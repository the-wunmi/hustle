import { NEAR_AUTH_TESTNET } from '@hustle/auth';
import {
  CATEGORIES,
  type Category,
  DomainError,
  type DomainErrorCode,
  newToken,
  toJson,
} from '@hustle/core';
import { agents, jobs } from '@hustle/db';
import { PLAYER_TASK_IDEAS, typicalJobCost, VENDORS } from '@hustle/economy';
import {
  agentView,
  answerCall,
  anyAgent,
  approvalsView,
  backAgent,
  buyAgent,
  callsFor,
  cancelJob,
  cancelListing,
  chooseBid,
  claimAllowance,
  confirmRulebook,
  dayOf,
  dayReportView,
  decideApproval,
  type Engine,
  fairValue,
  feedView,
  holderView,
  jobSummaries,
  jobView,
  leaderboardView,
  listAgent,
  loginWithIdToken,
  logout,
  marketplaceView,
  markPresent,
  meView,
  mintAgent,
  nftHistoryView,
  ownedAgent,
  ownJob,
  type PlayerRow,
  passkeyLogin,
  playerForSession,
  postTask,
  proofView,
  rateJob,
  sendAgentAfterJob,
  setFrozen,
  startEmailLogin,
  startWalletLogin,
  summariesOf,
  topUp,
  trainSkill,
  updateRulebook,
  updateStrategy,
  verifyEmailLogin,
  verifyWalletLogin,
  walletHistory,
  withdraw,
  worldView,
} from '@hustle/engine';
import { checkReportBinding, fetchPublicAttestation, freshNonce } from '@hustle/nearai';
import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { RateLimit } from './limits.ts';
import { sandboxRoutes } from './sandbox.ts';

const SESSION_COOKIE = 'hustle_session';
/** Sign-ups per client address per window: enough for a household, too few to farm credits. */
const SIGN_UPS_PER_WINDOW = 10;
/** Signed owner actions (rulebook, freeze, list, top up…) per player per window. */
const OWNER_ACTIONS_PER_WINDOW = 20;
const OWNER_ACTION_WINDOW_MS = 5 * 60_000;
const SIGN_UP_WINDOW_MS = 10 * 60_000;
/** How long one live attestation check is reused. */
const LIVE_ATTESTATION_TTL_MS = 60_000;

const FeedQuery = z.object({
  after: z.coerce.number().int().min(0).default(0),
  /** Older than this sequence number: the next page back. */
  before: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(60),
  agent: z.uuid().optional(),
  job: z.uuid().optional(),
});
/** Request bodies are small JSON; a job post is the largest at ~4 KB of text. */
const MAX_BODY_BYTES = 32 * 1024;

const STATUS: Record<DomainErrorCode, 400 | 401 | 402 | 403 | 404 | 409 | 429 | 503> = {
  invalid: 400,
  unauthorized: 401,
  insufficient_funds: 402,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  policy_error: 409,
  rate_limited: 429,
  unavailable: 503,
};

type Env = { Variables: { player: PlayerRow | null } };

type Status = 200 | 201 | 400 | 401 | 402 | 403 | 404 | 409 | 413 | 429 | 500 | 503;

/** JSON with bigints as strings: the one serialiser every response goes through. */
const send = (c: Context, body: unknown, status: Status = 200) =>
  c.body(toJson(body), status, { 'content-type': 'application/json; charset=utf-8' });

export function createApp(engine: Engine) {
  const app = new Hono<Env>().basePath('/api');
  const lane = <T>(fn: () => Promise<T>) => engine.lane.run(fn);

  app.use(
    '*',
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => c.json({ error: 'Request too large' }, 413),
    }),
  );
  // Writes from a browser must come from the game's own origin (CSRF): with PUBLIC_ORIGIN set (the
  // public https URL in production), a state-changing request whose Origin is anything else is
  // refused. Requests without an Origin are not from a browser page, so they carry no cookie risk.
  const publicOrigin = process.env.PUBLIC_ORIGIN?.replace(/\/$/, '');
  app.use('*', async (c, next) => {
    const method = c.req.method;
    if (publicOrigin && method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      const origin = c.req.header('origin');
      if (origin && origin !== publicOrigin)
        return c.json({ error: 'Request from another site', code: 'forbidden' }, 403);
    }
    await next();
  });
  app.use('*', async (c, next) => {
    c.set('player', await playerForSession(engine, getCookie(c, SESSION_COOKIE)));
    await next();
  });

  app.onError((err, c) => {
    if (err instanceof DomainError) {
      return send(
        c,
        { error: err.message, code: err.code, details: err.details ?? null },
        STATUS[err.code] as Status,
      );
    }
    engine.log('unhandled error', {
      path: c.req.path,
      error: String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    return send(c, { error: 'Something went wrong on our side', code: 'internal' }, 500);
  });

  const me = (c: { get: (k: 'player') => PlayerRow | null }): PlayerRow => {
    const player = c.get('player');
    if (!player) throw new DomainError('unauthorized', 'Sign in first');
    return player;
  };
  const body = async (c: { req: { json: () => Promise<unknown> } }): Promise<unknown> => {
    try {
      return await c.req.json();
    } catch {
      throw new DomainError('invalid', 'Expected a JSON body');
    }
  };
  const startSession = (c: Parameters<typeof setCookie>[0], token: string) =>
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      // Only sent over HTTPS once the game is served from one (the public origin, or production).
      secure: publicOrigin?.startsWith('https://') || process.env.NODE_ENV === 'production',
      maxAge: 30 * 24 * 3600,
    });

  // ── Auth ──────────────────────────────────────────────────────────────────────────────────────
  // Sign-ups mint starter credits, so each client address gets a few per window (Sybil brake).
  const signUps = new RateLimit(
    SIGN_UPS_PER_WINDOW,
    SIGN_UP_WINDOW_MS,
    'Too many sign-ins from here. Try again later.',
  );
  // X-Forwarded-For is trusted only behind our reverse proxy (PUBLIC_ORIGIN set): the API port is
  // bound to loopback there and Caddy overwrites the header. Without a proxy any client could set it.
  const behindProxy = Boolean(process.env.PUBLIC_ORIGIN);
  const clientKey = (c: Context) => {
    const socket = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)
      ?.incoming?.socket?.remoteAddress;
    const forwarded = behindProxy
      ? c.req.header('x-forwarded-for')?.split(',').at(-1)?.trim()
      : undefined;
    return forwarded || socket || 'local';
  };
  // The stand-in sign-in (AUTH_MODE=mock) shows its code on screen, so it is never offered in
  // production unless ALLOW_MOCK_AUTH=1 says so explicitly.
  const mockAuth =
    engine.authSim !== null &&
    (process.env.NODE_ENV !== 'production' || process.env.ALLOW_MOCK_AUTH === '1');
  const requireMock = () => {
    if (!mockAuth) throw new DomainError('forbidden', 'This sign-in method is off here.');
  };
  // What a NEAR wallet signs for (NEP-413 recipient): the public site's host.
  const walletRecipient = publicOrigin ? new URL(publicOrigin).host : 'localhost';
  const WALLET_CHALLENGE_COOKIE = 'hustle_wallet_challenge';
  // A wallet sign-in from a browser always carries an Origin; in production a request without one
  // is a script, so it is refused (the Origin check above then covers the rest).
  const originRequired = process.env.NODE_ENV === 'production';
  const requireOrigin = (c: Context) => {
    if (originRequired && !c.req.header('origin'))
      throw new DomainError('forbidden', 'Sign in from the game page.');
  };
  app.post('/auth/wallet/challenge', async (c) => {
    requireOrigin(c);
    signUps.take(`wallet:${clientKey(c)}`);
    // Binds the challenge to this browser: only the cookie's hash is stored with the nonce.
    const binding = newToken();
    setCookie(c, WALLET_CHALLENGE_COOKIE, binding, {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/api/auth/wallet',
      secure: publicOrigin?.startsWith('https://') || process.env.NODE_ENV === 'production',
      maxAge: 10 * 60,
    });
    return send(c, await startWalletLogin(engine, binding, walletRecipient));
  });
  // Not rate-limited itself: every attempt needs a fresh challenge, which is.
  app.post('/auth/wallet/verify', async (c) => {
    requireOrigin(c);
    const binding = getCookie(c, WALLET_CHALLENGE_COOKIE);
    const input = await body(c);
    // Not on the lane: the checks (including a testnet RPC lookup) run first, and only the player
    // and session writes take the lane, inside `verifyWalletLogin`.
    const { player, sessionToken } = await verifyWalletLogin(engine, binding, input as never);
    deleteCookie(c, WALLET_CHALLENGE_COOKIE, { path: '/api/auth/wallet' });
    startSession(c, sessionToken);
    return send(c, { player: { id: player.id, name: player.name } });
  });
  app.post('/auth/email/start', async (c) => {
    requireMock();
    signUps.take(`email:${clientKey(c)}`);
    const input = await body(c);
    return send(c, await lane(() => startEmailLogin(engine, input as never)));
  });
  app.post('/auth/email/verify', async (c) => {
    requireMock();
    const { player, sessionToken } = await lane(async () =>
      verifyEmailLogin(engine, (await body(c)) as never),
    );
    startSession(c, sessionToken);
    return send(c, { player: { id: player.id, name: player.name } });
  });
  // What the browser needs for NEAR Auth's popup. The client id and domain are public by design.
  app.get('/auth/config', (c) =>
    send(c, {
      mode: engine.auth.mode,
      domain: process.env.NEAR_AUTH_DOMAIN || NEAR_AUTH_TESTNET.domain,
      clientId: process.env.NEAR_AUTH_CLIENT_ID || NEAR_AUTH_TESTNET.clientId,
      allowedOrigins: process.env.NEAR_AUTH_DOMAIN ? [] : [...NEAR_AUTH_TESTNET.allowedOrigins],
      // The labelled stand-in (email code on screen) is offered only where it's allowed.
      mock: mockAuth,
      wallet: { network: 'testnet', recipient: walletRecipient },
    }),
  );
  app.post('/auth/passkey', async (c) => {
    requireMock();
    signUps.take(`passkey:${clientKey(c)}`);
    const { player, sessionToken } = await lane(async () =>
      passkeyLogin(engine, (await body(c)) as never),
    );
    startSession(c, sessionToken);
    return send(c, { player: { id: player.id, name: player.name } });
  });
  app.post('/auth/id-token', async (c) => {
    signUps.take(`idtoken:${clientKey(c)}`);
    const { player, sessionToken } = await lane(async () =>
      loginWithIdToken(engine, (await body(c)) as never),
    );
    startSession(c, sessionToken);
    return send(c, { player: { id: player.id, name: player.name } });
  });
  app.post('/auth/logout', async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) await logout(engine, token);
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return send(c, { ok: true });
  });

  // ── World ─────────────────────────────────────────────────────────────────────────────────────
  // Liveness only: up as soon as HTTP is. `recovering` says workflows from the last process are
  // still finishing (the world waits for them, a minute by default).
  app.get('/health', (c) =>
    send(c, { ok: true, tick: engine.clock.tick, recovering: engine.recovering }),
  );

  app.get('/world', async (c) => send(c, await worldView(engine)));
  app.get('/me', async (c) => {
    const player = c.get('player');
    return send(c, player ? await meView(engine, player) : null);
  });
  app.get('/vendors', (c) =>
    send(
      c,
      VENDORS.filter((v) => !v.scam).map((v) => ({
        accountId: `${v.handle}.${engine.chain.ids.vendors}`,
        name: v.name,
        description: v.description,
        price: v.price,
        known: true,
      })),
    ),
  );
  /** The brain tiers and their NEAR AI Cloud models and prices, for onboarding and "under the hood". */
  app.get('/brains', (c) =>
    send(
      c,
      (['budget', 'standard', 'premium'] as const).map((tier) => ({
        ...engine.brains[tier],
        typicalJobCost: typicalJobCost(engine.brains[tier]),
        quality: engine.cfg.tierQuality[tier],
      })),
    ),
  );
  /**
   * A live check against NEAR AI Cloud's public attestation endpoint: fetch the gateway report with a
   * fresh nonce and check it answers that nonce and names its signing key. Real network call, no key;
   * cached briefly so the page can't be used to hammer the provider.
   */
  let liveAttestation: { at: number; body: unknown } | null = null;
  app.get('/attestation/live', async (c) => {
    if (liveAttestation && Date.now() - liveAttestation.at < LIVE_ATTESTATION_TTL_MS) {
      return send(c, liveAttestation.body);
    }
    const nonce = freshNonce();
    const baseUrl = process.env.NEARAI_BASE_URL ?? 'https://cloud-api.near.ai/v1';
    try {
      const report = await fetchPublicAttestation(baseUrl, nonce);
      const body = {
        fetchedAt: new Date().toISOString(),
        endpoint: `${baseUrl}/attestation/report`,
        verification: checkReportBinding('live', report, nonce),
      };
      liveAttestation = { at: Date.now(), body };
      return send(c, body);
    } catch {
      throw new DomainError('unavailable', 'NEAR AI Cloud did not answer. Try again in a minute.');
    }
  });
  app.get('/task-ideas', (c) => send(c, PLAYER_TASK_IDEAS));

  app.get('/feed', async (c) => {
    const parsed = FeedQuery.safeParse(c.req.query());
    if (!parsed.success)
      throw new DomainError('invalid', 'Invalid feed query', parsed.error.issues);
    const after = parsed.data.after || undefined;
    const limit = parsed.data.limit;
    const agentId = parsed.data.agent;
    const jobId = parsed.data.job;
    return send(
      c,
      await feedView(engine, c.get('player'), {
        ...(after ? { after } : {}),
        ...(parsed.data.before ? { before: parsed.data.before } : {}),
        ...(agentId ? { agentId } : {}),
        ...(jobId ? { jobId } : {}),
        limit,
      }),
    );
  });

  /** Live feed over Server-Sent Events: each wake-up sends whatever this viewer hasn't seen yet. */
  app.get('/feed/stream', (c) => {
    const viewer = c.get('player');
    let last = Number(c.req.query('after') ?? 0) || 0;
    return streamSSE(c, async (stream) => {
      let pending = true;
      const wake = () => {
        pending = true;
      };
      engine.bus.on('feed', wake);
      engine.bus.on('tick', wake);
      stream.onAbort(() => {
        engine.bus.off('feed', wake);
        engine.bus.off('tick', wake);
      });
      while (!stream.aborted) {
        if (pending) {
          pending = false;
          const events = (
            await feedView(engine, viewer, {
              ...(last ? { after: last } : {}),
              limit: last ? 100 : 30,
            })
          ).reverse();
          for (const e of events) {
            await stream.writeSSE({ event: 'feed', data: toJson(e), id: String(e.seq) });
            last = Math.max(last, e.seq);
          }
          await stream.writeSSE({
            event: 'tick',
            data: JSON.stringify({ tick: engine.clock.tick, day: dayOf(engine) }),
          });
        }
        await stream.sleep(500);
      }
    });
  });

  // ── Agents ────────────────────────────────────────────────────────────────────────────────────
  app.get('/agents', async (c) => {
    const rows = await engine.db
      .select()
      .from(agents)
      .where(and(isNotNull(agents.accountId), eq(agents.hidden, false)))
      .orderBy(agents.createdAt);
    return send(c, await summariesOf(engine, rows, c.get('player')));
  });
  app.post('/agents', async (c) => {
    const player = me(c);
    const input = await body(c);
    const agent = await lane(() => mintAgent(engine, player, input as never));
    return send(c, await agentView(engine, agent, player), 201);
  });
  app.get('/agents/:id', async (c) =>
    send(c, await agentView(engine, await anyAgent(engine, c.req.param('id')), c.get('player'))),
  );
  // Owner actions sign transactions from the player's account, which the root refills with gas: a
  // few a minute is plenty for play and keeps a looping script from burning NEAR.
  const ownerActions = new RateLimit(
    OWNER_ACTIONS_PER_WINDOW,
    OWNER_ACTION_WINDOW_MS,
    'Too many changes in a row. Wait a minute and try again.',
  );
  const ownerAction = (
    path: string,
    fn: (
      player: PlayerRow,
      agent: Awaited<ReturnType<typeof ownedAgent>>,
      input: unknown,
    ) => Promise<unknown>,
  ) =>
    app.post(`/agents/:id/${path}`, async (c) => {
      const player = me(c);
      ownerActions.take(player.id);
      const input = await body(c);
      await lane(async () =>
        fn(player, await ownedAgent(engine, player, c.req.param('id')), input),
      );
      return send(
        c,
        await agentView(engine, await ownedAgent(engine, player, c.req.param('id')), player),
      );
    });
  ownerAction('strategy', (p, a, i) => updateStrategy(engine, p, a, i as never));
  ownerAction('rulebook', (p, a, i) => updateRulebook(engine, p, a, i as never));
  ownerAction('topup', (p, a, i) => topUp(engine, p, a, i as never));
  ownerAction('withdraw', (p, a, i) => withdraw(engine, p, a, i as never));
  ownerAction('freeze', (p, a, i) => setFrozen(engine, p, a, i as never));
  ownerAction('train', (p, a, i) => trainSkill(engine, p, a, i as never));
  // ── Marketplace ───────────────────────────────────────────────────────────────────────────────
  ownerAction('listing', (p, a, i) => listAgent(engine, p, a, i as never));
  ownerAction('unlist', (p, a) => cancelListing(engine, p, a));
  ownerAction('confirm', (p, a, i) => confirmRulebook(engine, p, a, i as never));
  app.get('/agents/:id/value', async (c) => {
    const player = me(c);
    const agent = await ownedAgent(engine, player, c.req.param('id'));
    return send(c, { fairValue: (await fairValue(engine, agent)).toString() });
  });
  app.post('/agents/:id/buy', async (c) => {
    const player = me(c);
    const input = await body(c);
    const agent = await lane(async () =>
      buyAgent(engine, player, await anyAgent(engine, c.req.param('id')), input as never),
    );
    return send(c, await agentView(engine, agent, player));
  });
  app.get('/marketplace', async (c) => send(c, await marketplaceView(engine, c.get('player'))));
  // ── The agent NFT (NFTs track) ────────────────────────────────────────────────────────────────
  // The holder's console: gated on the NFT owner read from chain on this request, not the session
  // alone, so a former holder is refused the moment the registry moves the token.
  app.get('/agents/:id/holder', async (c) => {
    const player = me(c);
    return send(c, await holderView(engine, player, await anyAgent(engine, c.req.param('id'))));
  });
  // Everything the NFT earned, paid out and who held it, from the chain's receipt log. Public.
  app.get('/agents/:id/history', async (c) =>
    send(
      c,
      await nftHistoryView(engine, await anyAgent(engine, c.req.param('id')), c.get('player')),
    ),
  );
  app.post('/agents/:id/back', async (c) => {
    const player = me(c);
    const input = await body(c);
    const agent = await lane(async () =>
      backAgent(engine, player, await anyAgent(engine, c.req.param('id')), input as never),
    );
    return send(c, await agentView(engine, agent, player));
  });
  app.get('/agents/:id/report', async (c) => {
    const player = me(c);
    const agent = await ownedAgent(engine, player, c.req.param('id'));
    const day = Number(c.req.query('day') ?? dayOf(engine));
    if (!Number.isInteger(day) || day < 1 || day > dayOf(engine))
      throw new DomainError('invalid', 'No report for that day');
    return send(c, await dayReportView(engine, player, agent, day));
  });
  app.get('/agents/:id/jobs', async (c) => {
    const agent = await anyAgent(engine, c.req.param('id'));
    const rows = await engine.db
      .select()
      .from(jobs)
      .where(eq(jobs.awardedAgentId, agent.id))
      .orderBy(desc(jobs.createdAt))
      .limit(30);
    return send(c, await jobSummaries(engine, rows, c.get('player')));
  });
  app.get('/agents/:id/proof', async (c) =>
    send(c, await proofView(engine, await anyAgent(engine, c.req.param('id')))),
  );
  app.get('/agents/:id/txs', async (c) => {
    const agent = await anyAgent(engine, c.req.param('id'));
    return send(c, await engine.chain.txs({ account: agent.accountId ?? '', limit: 40 }));
  });

  // ── Calls ───────────────────────────────────────────────────────────────
  // Polling this is what marks a player as watching: calls are only raised for watching players.
  app.get('/calls', async (c) => {
    const player = me(c);
    markPresent(engine, player.id);
    return send(c, await callsFor(engine, player));
  });
  app.post('/calls/:id', async (c) => {
    const player = me(c);
    const input = await body(c);
    return send(c, await lane(() => answerCall(engine, player, c.req.param('id'), input as never)));
  });

  // ── Approvals ─────────────────────────────────────────────────────────────────────────────────
  app.get('/approvals', async (c) =>
    send(c, await approvalsView(engine, me(c), c.req.query('all') !== '1')),
  );
  app.post('/approvals/:id', async (c) => {
    const player = me(c);
    ownerActions.take(player.id);
    const input = await body(c);
    await lane(() => decideApproval(engine, player, c.req.param('id'), input as never));
    return send(c, await approvalsView(engine, player, false));
  });

  // ── Jobs ──────────────────────────────────────────────────────────────────────────────────────
  app.get('/jobs', async (c) => {
    const status = c.req.query('status') ?? 'open';
    if (!['open', 'active', 'mine', 'recent', 'done', 'all'].includes(status))
      throw new DomainError(
        'invalid',
        'status must be open, active, mine, recent (or done) or all',
      );
    const player = c.get('player');
    const category = c.req.query('category');
    const conds = [sql`${jobs.source} <> 'practice'`];
    if (status === 'open') conds.push(eq(jobs.status, 'open'));
    else if (status === 'active') conds.push(inArray(jobs.status, ['working', 'delivered']));
    else if (status === 'mine' && player) conds.push(eq(jobs.clientPlayerId, player.id));
    else if (status === 'recent' || status === 'done')
      conds.push(inArray(jobs.status, ['paid', 'refunded']));
    if (category && (CATEGORIES as readonly string[]).includes(category))
      conds.push(eq(jobs.category, category as Category));
    const rows = await engine.db
      .select()
      .from(jobs)
      .where(and(...conds))
      .orderBy(desc(jobs.createdAt))
      .limit(60);
    return send(c, await jobSummaries(engine, rows, player));
  });
  app.post('/jobs', async (c) => {
    const player = me(c);
    const input = await body(c);
    const job = await lane(() => postTask(engine, player, input as never));
    return send(c, await jobView(engine, job, player), 201);
  });
  app.get('/jobs/:id', async (c) => {
    const id = z.uuid().safeParse(c.req.param('id'));
    const player = c.get('player');
    const [row] = id.success ? await engine.db.select().from(jobs).where(eq(jobs.id, id.data)) : [];
    if (!row) throw new DomainError('not_found', 'Job not found');
    return send(c, await jobView(engine, row, player));
  });
  const clientAction = (
    path: string,
    fn: (
      player: PlayerRow,
      job: Awaited<ReturnType<typeof ownJob>>,
      input: unknown,
    ) => Promise<unknown>,
  ) =>
    app.post(`/jobs/:id/${path}`, async (c) => {
      const player = me(c);
      const input = path === 'cancel' ? {} : await body(c);
      await lane(async () => fn(player, await ownJob(engine, player, c.req.param('id')), input));
      return send(
        c,
        await jobView(engine, await ownJob(engine, player, c.req.param('id')), player),
      );
    });
  // Any player may send their own agent after an open job at a price they choose.
  app.post('/jobs/:id/bid', async (c) => {
    const player = me(c);
    const input = await body(c);
    const id = z.uuid().safeParse(c.req.param('id'));
    await lane(async () => {
      const [job] = id.success
        ? await engine.db.select().from(jobs).where(eq(jobs.id, id.data))
        : [];
      if (!job) throw new DomainError('not_found', 'Job not found');
      await sendAgentAfterJob(engine, player, job, input as never);
    });
    const [job] = await engine.db
      .select()
      .from(jobs)
      .where(eq(jobs.id, id.data ?? ''));
    if (!job) throw new DomainError('not_found', 'Job not found');
    return send(c, await jobView(engine, job, player));
  });
  clientAction('award', (_p, j, i) => chooseBid(engine, j, i as never));
  clientAction('rate', (p, j, i) => rateJob(engine, p, j, i as never));
  clientAction('cancel', (p, j) => cancelJob(engine, p, j));

  // ── Leaderboard and wallet ────────────────────────────────────────────────────────────────────
  app.get('/leaderboard', async (c) =>
    send(
      c,
      await leaderboardView(
        engine,
        c.get('player'),
        c.req.query('period') === 'today' ? 'today' : 'season',
      ),
    ),
  );

  app.post('/wallet/allowance', async (c) => {
    const player = me(c);
    await lane(() => claimAllowance(engine, player));
    return send(
      c,
      await meView(
        engine,
        (await playerForSession(engine, getCookie(c, SESSION_COOKIE))) ?? player,
      ),
    );
  });
  app.get('/wallet/history', async (c) => send(c, await walletHistory(engine, me(c))));
  app.get('/wallet/txs', async (c) =>
    send(c, await engine.chain.txs({ account: me(c).accountId, limit: 40 })),
  );

  // Sandbox controls move the shared world's clock and post red-team jobs. On by default in sim mode
  // and on the local node, for local play and judging; SANDBOX_CONTROLS=off removes them.
  if (engine.modes.chain !== 'testnet' && process.env.SANDBOX_CONTROLS !== 'off') {
    app.route('/sandbox', sandboxRoutes(engine, me, lane, body));
  }

  app.notFound((c) => send(c, { error: 'Not found', code: 'not_found' }, 404));
  return app;
}
