import { randomInt } from 'node:crypto';
import { AuthError, type Identity, playerAccountId } from '@hustle/auth';
import { DomainError, hashToken, newToken, parseInput, safeEqualHex } from '@hustle/core';
import { authChallenges, players, sessions, type Tx } from '@hustle/db';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { dayOf, type Engine } from './context.ts';
import { chainCall, DBOS, durableEngine, inTx, runOnce, wfId } from './durable.ts';
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
 * NEAR Auth derives a key but doesn't create an account, so the game creates the player's account
 * (through the relayer, gas sponsored) and funds the sandbox wallet with starter credits.
 */
async function findOrCreatePlayer(
  engine: Engine,
  identity: Identity,
  name: string,
): Promise<PlayerRow> {
  const [existing] = await engine.db
    .select()
    .from(players)
    .where(eq(players.authSubject, identity.sub));
  if (existing) return existing;
  const accountId = playerAccountId(engine.secret, identity.sub, engine.chain.ids.root);
  // One workflow per account: the chain account, the player row and the starter credits happen
  // once, even if two sign-ins race or the process dies half-way.
  return runOnce(signUpWorkflow, wfId(engine, 'signup', accountId), {
    accountId,
    identity: { sub: identity.sub, email: identity.email, method: identity.method },
    name,
  });
}

interface SignUpInput {
  accountId: string;
  identity: { sub: string; email: string | null; method: string };
  name: string;
}

async function signUpSteps(input: SignUpInput): Promise<PlayerRow> {
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

const signUpWorkflow = DBOS.registerWorkflow(signUpSteps, { name: 'signUp' });

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
