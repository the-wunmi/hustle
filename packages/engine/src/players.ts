import { randomBytes, randomInt } from 'node:crypto';
import {
  AuthError,
  type Identity,
  isTestnetAccount,
  playerAccountId,
  verifyNep413,
} from '@hustle/auth';
import { DomainError, hashToken, newToken, parseInput, safeEqualHex } from '@hustle/core';
import { authChallenges, players, sessions, type Tx, walletChallenges } from '@hustle/db';
import { and, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { dayOf, type Engine } from './context.ts';
import {
  chainCall,
  crashPoint,
  DBOS,
  durableEngine,
  inTx,
  runOnce,
  wfId,
  workflowExists,
} from './durable.ts';
import { assertNearReserve, takeDailySlot } from './guards.ts';
import { book, post } from './record.ts';

export type PlayerRow = typeof players.$inferSelect;

/** How long an emailed code works. */
const CODE_TTL_MS = 10 * 60_000;
/** Wrong guesses allowed per code before it's burned. */
const MAX_CODE_ATTEMPTS = 5;
/** Codes one email can request per window, so nobody floods an inbox or farms accounts. */
const MAX_CODES_PER_WINDOW = 5;
const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;

const PlayerName = z
  .string()
  .trim()
  .min(2)
  .max(24)
  .regex(/^[\p{L}\p{N} '_-]+$/u);

export const StartEmailLogin = z.object({
  email: z
    .email()
    .max(120)
    .transform((e) => e.toLowerCase()),
});
export const VerifyEmailLogin = z.object({
  challengeId: z.uuid(),
  code: z.string().regex(/^\d{6}$/),
  name: PlayerName.optional(),
});
export const PasskeyLogin = z.object({ name: PlayerName });
export const IdTokenLogin = z.object({
  idToken: z.string().min(20).max(4000),
  name: PlayerName.optional(),
});

/**
 * Step one of the simulated email login (Auth0 passwordless, as NEAR Auth uses). In mock mode no email
 * is sent; the code comes back so the UI can show it in a clearly labelled simulated inbox.
 */
export async function startEmailLogin(engine: Engine, input: z.input<typeof StartEmailLogin>) {
  const { email } = parseInput(StartEmailLogin, input);
  if (!engine.authSim)
    throw new DomainError('unavailable', 'Email codes are handled by NEAR Auth in live mode');
  const since = new Date(Date.now() - CODE_TTL_MS);
  const [{ n } = { n: 0 }] = await engine.db
    .select({ n: sql<number>`count(*)::int` })
    .from(authChallenges)
    .where(and(eq(authChallenges.email, email), gt(authChallenges.createdAt, since)));
  if (n >= MAX_CODES_PER_WINDOW)
    throw new DomainError('rate_limited', 'Too many codes. Try again in a few minutes.');
  const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
  const [row] = await engine.db
    .insert(authChallenges)
    .values({
      email,
      codeHash: hashToken(`${email}:${code}`),
      expiresAt: new Date(Date.now() + CODE_TTL_MS),
    })
    .returning();
  if (!row) throw new Error('challenge not written');
  return { challengeId: row.id, simulatedInbox: { to: email, code } };
}

export async function verifyEmailLogin(engine: Engine, input: z.input<typeof VerifyEmailLogin>) {
  const { challengeId, code, name } = parseInput(VerifyEmailLogin, input);
  if (!engine.authSim)
    throw new DomainError('unavailable', 'Email codes are handled by NEAR Auth in live mode');
  const [challenge] = await engine.db
    .select()
    .from(authChallenges)
    .where(and(eq(authChallenges.id, challengeId), isNull(authChallenges.consumedAt)));
  if (!challenge || challenge.expiresAt < new Date() || challenge.attempts >= MAX_CODE_ATTEMPTS) {
    throw new DomainError('invalid', 'That code has expired. Ask for a new one.');
  }
  if (!safeEqualHex(hashToken(`${challenge.email}:${code}`), challenge.codeHash)) {
    await engine.db
      .update(authChallenges)
      .set({ attempts: challenge.attempts + 1 })
      .where(eq(authChallenges.id, challengeId));
    throw new DomainError('invalid', 'Wrong code');
  }
  await engine.db
    .update(authChallenges)
    .set({ consumedAt: new Date() })
    .where(eq(authChallenges.id, challengeId));
  const token = engine.authSim.issueIdToken({
    sub: `email|${challenge.email}`,
    email: challenge.email,
    method: 'email',
  });
  return loginWithIdToken(engine, {
    idToken: token,
    name: name ?? nameFromEmail(challenge.email),
  });
}

/**
 * A default display name from the email's local part, made to pass the name rules: "ada.lovelace+x"
 * becomes "ada lovelace x". Too short after cleaning falls back to "Player".
 */
export function nameFromEmail(email: string): string {
  const cleaned = (email.split('@')[0] ?? '')
    .replace(/[^\p{L}\p{N} '_-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24)
    .trim();
  return cleaned.length >= 2 ? cleaned : 'Player';
}

/** Simulated passkey sign-in: in live mode the browser gets the id token from NEAR Auth instead. */
export async function passkeyLogin(engine: Engine, input: z.input<typeof PasskeyLogin>) {
  const { name } = parseInput(PasskeyLogin, input);
  if (!engine.authSim)
    throw new DomainError('unavailable', 'Passkeys are handled by NEAR Auth in live mode');
  const sub = engine.authSim.newPasskeySubject();
  const token = engine.authSim.issueIdToken({ sub, email: null, method: 'passkey' });
  return loginWithIdToken(engine, { idToken: token, name });
}

// ── NEAR wallet sign-in (NEP-413) ───────────────────────────────────────────────────────────────

/** How long a wallet has to sign a challenge. */
const WALLET_CHALLENGE_TTL_MS = 5 * 60_000;
export const WALLET_SIGN_IN_MESSAGE = 'Sign in to Hustle';

export const VerifyWalletLogin = z.object({
  accountId: z.string().min(2).max(64),
  publicKey: z.string().startsWith('ed25519:').max(80),
  signature: z.string().min(80).max(100),
  /** Base64 of the challenge's 32-byte nonce. */
  nonce: z.string().min(40).max(48),
  /** The recipient the wallet was asked to sign for, if the browser reports it. */
  recipient: z.string().max(253).optional(),
});

/**
 * A one-time challenge for a wallet to sign: a random nonce, bound to the browser by `binding` (a
 * random token the API keeps in an http-only cookie; only its hash is stored), valid for minutes.
 */
export async function startWalletLogin(engine: Engine, binding: string, recipient: string) {
  const nonce = randomBytes(32).toString('base64');
  const expiresAt = new Date(Date.now() + WALLET_CHALLENGE_TTL_MS);
  // Old challenges are useless once expired; clear them as new ones are made.
  await engine.db
    .delete(walletChallenges)
    .where(lt(walletChallenges.expiresAt, new Date(Date.now() - WALLET_CHALLENGE_TTL_MS)));
  await engine.db.insert(walletChallenges).values({
    nonce,
    bindingHash: hashToken(binding),
    message: WALLET_SIGN_IN_MESSAGE,
    recipient,
    expiresAt,
  });
  return { message: WALLET_SIGN_IN_MESSAGE, nonce, recipient, expiresAt: expiresAt.toISOString() };
}

/**
 * A signed challenge becomes a player and a session, only if every check holds: a testnet account,
 * the challenge unused, unexpired and issued to this browser, a valid ed25519 signature over the
 * NEP-413 payload with our recipient, and the key a full-access key of that account on testnet.
 */
export async function verifyWalletLogin(
  engine: Engine,
  binding: string | undefined,
  input: z.input<typeof VerifyWalletLogin>,
) {
  const signed = parseInput(VerifyWalletLogin, input);
  if (!isTestnetAccount(signed.accountId))
    throw new DomainError('invalid', 'Only NEAR testnet accounts can sign in here.');
  if (!binding) throw new DomainError('unauthorized', 'Start the sign-in again from this page.');
  // Claim the challenge first: a nonce is spent even if what follows fails, so it can't be replayed.
  const [challenge] = await engine.db
    .update(walletChallenges)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(walletChallenges.nonce, signed.nonce),
        eq(walletChallenges.bindingHash, hashToken(binding)),
        isNull(walletChallenges.usedAt),
        gt(walletChallenges.expiresAt, new Date()),
      ),
    )
    .returning();
  if (!challenge) {
    const [row] = await engine.db
      .select()
      .from(walletChallenges)
      .where(eq(walletChallenges.nonce, signed.nonce));
    const why = !row
      ? 'That sign-in request is unknown.'
      : row.bindingHash !== hashToken(binding)
        ? 'That sign-in request was made in another browser.'
        : row.usedAt
          ? 'That sign-in request was already used.'
          : 'That sign-in request expired.';
    throw new DomainError('unauthorized', `${why} Start the sign-in again.`);
  }
  if (signed.recipient !== undefined && signed.recipient !== challenge.recipient)
    throw new DomainError('unauthorized', 'The wallet signed for another site.');
  const ok = verifyNep413(signed, {
    message: challenge.message,
    nonce: Uint8Array.from(Buffer.from(challenge.nonce, 'base64')),
    recipient: challenge.recipient,
  });
  if (!ok) throw new DomainError('unauthorized', "The wallet's signature doesn't match.");
  const permission = await engine.walletKeys(signed.accountId, signed.publicKey);
  if (permission === null)
    throw new DomainError(
      'unauthorized',
      `That key isn't a key of ${signed.accountId} on testnet.`,
    );
  if (permission !== 'full')
    throw new DomainError(
      'unauthorized',
      'That key can only call some contracts; sign with a full-access key of the account.',
    );
  // Everything above ran off the serial lane (the key lookup can take a while on a slow RPC); only
  // the player and session writes take it.
  return engine.lane.run(async () => {
    const player = await findOrCreatePlayer(
      engine,
      { sub: `wallet:${signed.accountId}`, email: null, method: 'wallet' },
      walletDisplayName(signed.accountId),
      signed.accountId,
    );
    const token = newToken();
    await engine.db.insert(sessions).values({
      tokenHash: hashToken(token),
      playerId: player.id,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    });
    return { player, sessionToken: token };
  });
}

/** The wallet account as the player's name: whole if it fits, else its two ends. */
export function walletDisplayName(accountId: string): string {
  return accountId.length <= 24 ? accountId : `${accountId.slice(0, 10)}…${accountId.slice(-12)}`;
}

/** Every login path ends here: a verified NEAR Auth id token becomes a player and a session. */
export async function loginWithIdToken(engine: Engine, input: z.input<typeof IdTokenLogin>) {
  const { idToken, name } = parseInput(IdTokenLogin, input);
  let identity: Identity;
  try {
    identity = await engine.auth.verifyIdToken(idToken);
  } catch (err) {
    if (err instanceof AuthError) throw new DomainError('unauthorized', err.message);
    throw err;
  }
  const player = await findOrCreatePlayer(engine, identity, name ?? 'Player');
  const token = newToken();
  await engine.db.insert(sessions).values({
    tokenHash: hashToken(token),
    playerId: player.id,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  });
  return { player, sessionToken: token };
}

/** A display name nobody else uses (case-insensitive): "Sam" becomes "Sam 2" if Sam exists. */
async function uniqueName(engine: Engine, name: string, db: Tx = engine.db): Promise<string> {
  const taken = new Set(
    (await db.select({ name: players.name }).from(players)).map((p) => p.name.toLowerCase()),
  );
  if (!taken.has(name.toLowerCase())) return name;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${name.slice(0, 20)} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return name;
}

/**
 * Finds the player for this identity or writes their row. NEAR Auth derives a key but doesn't create
 * an account; the game's own account for the player is made later, on their first on-chain action
 * (`ensurePlayerAccount`). A wallet sign-in passes the wallet's account as `walletAccountId`.
 */
async function findOrCreatePlayer(
  engine: Engine,
  identity: Identity,
  name: string,
  walletAccountId: string | null = null,
): Promise<PlayerRow> {
  const [existing] = await engine.db
    .select()
    .from(players)
    .where(eq(players.authSubject, identity.sub));
  if (existing) return existing;
  const accountId = playerAccountId(engine.secret, identity.sub, engine.chain.ids.root);
  // One workflow per account: the player row is written once, even if two sign-ins race or the
  // process dies half-way.
  return runOnce(signUpWorkflow, wfId(engine, 'signup', accountId), {
    accountId,
    identity: { sub: identity.sub, email: identity.email, method: identity.method },
    name,
    walletAccountId,
  });
}

interface SignUpInput {
  accountId: string;
  identity: { sub: string; email: string | null; method: string };
  name: string;
  walletAccountId?: string | null;
}

async function signUpSteps(input: SignUpInput): Promise<PlayerRow> {
  const engine = durableEngine();
  // Only the row: the player's NEAR account and starter credits wait for their first on-chain
  // action (`ensurePlayerAccount`), so a sign-up who never plays costs no NEAR.
  return inTx('write player', async (db) => {
    await db
      .insert(players)
      .values({
        name: await uniqueName(engine, input.name, db),
        email: input.identity.email,
        loginMethod: input.identity.method as PlayerRow['loginMethod'],
        authSubject: input.identity.sub,
        accountId: input.accountId,
        walletAccountId: input.walletAccountId ?? null,
        accountReady: false,
      })
      .onConflictDoNothing();
    const [row] = await db
      .select()
      .from(players)
      .where(eq(players.authSubject, input.identity.sub));
    if (!row) throw new Error('player not written');
    return row;
  });
}

// A new name, so a sign-up still in flight from a build that made the account at sign-in resumes
// with the steps it started with (`signUp`, below) and never mixes the two.
const signUpWorkflow = DBOS.registerWorkflow(signUpSteps, { name: 'signUpLazy' });

/** The sign-up of earlier builds (account and starter credits at once), kept only for recovery. */
async function legacySignUpSteps(input: SignUpInput): Promise<PlayerRow> {
  const engine = durableEngine();
  const created = await chainCall('create_account', () =>
    engine.chain.createAccount(input.accountId),
  );
  if (!created.ok && created.code !== 'account_exists')
    throw new DomainError('unavailable', 'Could not create your account');
  const player = await inTx('write player', async (db) => {
    await db
      .insert(players)
      .values({
        name: await uniqueName(engine, input.name, db),
        email: input.identity.email,
        loginMethod: input.identity.method as PlayerRow['loginMethod'],
        authSubject: input.identity.sub,
        accountId: input.accountId,
      })
      .onConflictDoNothing();
    const [row] = await db
      .select()
      .from(players)
      .where(eq(players.authSubject, input.identity.sub));
    if (!row) throw new Error('player not written');
    return row;
  });
  await grantSteps({
    playerId: player.id,
    accountId: player.accountId,
    amount: engine.cfg.starterWalletCredits,
    ref: `starter:${player.id}`,
    kind: 'starter',
  });
  return player;
}

DBOS.registerWorkflow(legacySignUpSteps, { name: 'signUp' });

/**
 * The player's NEAR account, made on their first on-chain action: the account (funded with just
 * enough for its storage and some gas, our key on it), its credits registration and the starter
 * credits. One workflow per account, so racing actions or a crash in between make it once.
 */
export async function ensurePlayerAccount(engine: Engine, player: PlayerRow): Promise<PlayerRow> {
  if (player.accountReady) return player;
  // A retry of an account already being made doesn't count again.
  if (!(await workflowExists(wfId(engine, 'account', player.accountId)))) {
    await assertNearReserve(engine);
    await takeDailySlot(engine, 'accounts');
  }
  return runOnce(accountWorkflow, wfId(engine, 'account', player.accountId), {
    playerId: player.id,
    accountId: player.accountId,
  });
}

async function accountSteps(input: { playerId: string; accountId: string }): Promise<PlayerRow> {
  const engine = durableEngine();
  const created = await chainCall('create_account', () =>
    engine.chain.createAccount(input.accountId),
  );
  if (!created.ok && created.code !== 'account_exists')
    throw new DomainError('unavailable', 'Could not create your account');
  crashPoint('account:created');
  await grantSteps({
    playerId: input.playerId,
    accountId: input.accountId,
    amount: engine.cfg.starterWalletCredits,
    ref: `starter:${input.playerId}`,
    kind: 'starter',
  });
  return inTx('account ready', async (db) => {
    const [row] = await db
      .update(players)
      .set({ accountReady: true })
      .where(eq(players.id, input.playerId))
      .returning();
    if (!row) throw new Error('player vanished');
    return row;
  });
}

const accountWorkflow = DBOS.registerWorkflow(accountSteps, { name: 'playerAccount' });

interface GrantInput {
  playerId: string;
  accountId: string;
  amount: bigint;
  ref: string;
  kind: 'starter' | 'allowance' | 'deposit';
}

async function grantSteps(input: GrantInput): Promise<void> {
  const engine = durableEngine();
  const res = await chainCall('mint', () =>
    engine.chain.mintCredits(input.accountId, input.amount, `mint:${input.ref}`),
  );
  if (!res.ok) throw new DomainError('unavailable', 'Could not add credits');
  await inTx('book credits', (db) =>
    book(
      engine,
      { ref: input.ref, kind: input.kind, amount: input.amount, playerId: input.playerId },
      db,
    ),
  );
}

const grantWorkflow = DBOS.registerWorkflow(grantSteps, { name: 'grantCredits' });

/** Sandbox only: credits minted by the token owner into a player's wallet, once per `ref`. */
export async function grantCredits(
  engine: Engine,
  player: PlayerRow,
  amount: bigint,
  ref: string,
  kind: 'starter' | 'allowance' | 'deposit',
): Promise<void> {
  await runOnce(grantWorkflow, wfId(engine, 'grant', ref), {
    playerId: player.id,
    accountId: player.accountId,
    amount,
    ref,
    kind,
  });
}

export async function playerForSession(
  engine: Engine,
  token: string | undefined,
): Promise<PlayerRow | null> {
  if (!token) return null;
  const [row] = await engine.db
    .select({ player: players })
    .from(sessions)
    .innerJoin(players, eq(players.id, sessions.playerId))
    .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, new Date())));
  return row?.player ?? null;
}

export async function logout(engine: Engine, token: string): Promise<void> {
  await engine.db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
}

/** The free daily credits: once per game day. */
export async function claimAllowance(engine: Engine, player: PlayerRow): Promise<void> {
  player = await ensurePlayerAccount(engine, player);
  const day = dayOf(engine);
  if (player.allowanceDay === day)
    throw new DomainError('conflict', 'Already claimed today. Come back tomorrow.');
  const [claimed] = await engine.db
    .update(players)
    .set({ allowanceDay: day })
    .where(and(eq(players.id, player.id), sql`${players.allowanceDay} is distinct from ${day}`))
    .returning();
  if (!claimed) throw new DomainError('conflict', 'Already claimed today. Come back tomorrow.');
  await grantCredits(
    engine,
    player,
    engine.cfg.dailyAllowance,
    `allowance:${player.id}:${day}`,
    'allowance',
  );
  await post(engine, {
    kind: 'wallet',
    tone: 'money',
    text: `You claimed today's free credits.`,
    playerId: player.id,
    amount: engine.cfg.dailyAllowance,
    scope: 'owner',
  });
}
