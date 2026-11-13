import { createDb, createPool, walletChallenges } from '@hustle/db';
import { runMigrations } from '@hustle/db/migrate';
import { freshTestDatabase } from '@hustle/db/test-databases';
import { closeEngine, createEngine, seedWorld } from '@hustle/engine';
import { KeyPair, KeyPairSigner } from 'near-api-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';

let pool: ReturnType<typeof createPool>;
let app: ReturnType<typeof createApp>;
let engine: Awaited<ReturnType<typeof createEngine>>;
/** Stands in for testnet's view_access_key: "<account> <public key>" → permission. */
const testnetKeys = new Map<string, 'full' | 'function_call'>();
/** When set, the key lookup waits for it (a slow testnet RPC). */
let slowLookup: { started: () => void; release: Promise<void> } | null = null;

beforeAll(async () => {
  const env = await freshTestDatabase('api');
  await runMigrations(env.DATABASE_URL);
  pool = createPool(env.DATABASE_URL);
  engine = await createEngine({
    db: createDb(pool),
    env: { ...env, NODE_ENV: 'test', CHAIN_MODE: 'sim', AUTH_MODE: 'mock', NEARAI_MODE: 'mock' },
    secret: 'test-api',
    walletKeys: async (account, key) => {
      if (slowLookup) {
        slowLookup.started();
        await slowLookup.release;
      }
      return testnetKeys.get(`${account} ${key}`) ?? null;
    },
  });
  await seedWorld(engine);
  app = createApp(engine);
}, 60_000);
afterAll(async () => {
  await closeEngine();
  await pool.end();
});

const post = (path: string, body: unknown, cookie?: string) =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

async function signIn(email: string): Promise<string> {
  const start = (await (await post('/api/auth/email/start', { email })).json()) as {
    challengeId: string;
    simulatedInbox: { code: string };
  };
  const res = await post('/api/auth/email/verify', {
    challengeId: start.challengeId,
    code: start.simulatedInbox.code,
  });
  const cookie = res.headers.get('set-cookie') ?? '';
  expect(cookie).toContain('HttpOnly');
  return cookie.split(';')[0] ?? '';
}

describe('API', () => {
  it('serves the world without signing in', async () => {
    const res = await app.request('/api/world');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { modes: { chain: string } }).modes.chain).toBe('sim');
  });

  it('tells the browser how to reach NEAR Auth, and the removed money routes are gone', async () => {
    const cfg = (await (await app.request('/api/auth/config')).json()) as {
      mode: string;
      domain: string;
      allowedOrigins: string[];
    };
    expect(cfg).toMatchObject({ mode: 'mock', domain: 'login.testnet.fast-auth.com' });
    expect(cfg.allowedOrigins).toEqual(['http://localhost:3000']);
    expect((await app.request('/api/economy')).status).toBe(404);
    expect((await app.request('/api/wallet/deposit/quote', { method: 'POST' })).status).toBe(404);
  });

  it('pages the feed backwards with a before cursor', async () => {
    const first = (await (await app.request('/api/feed?limit=3')).json()) as { seq: number }[];
    expect(first.length).toBe(3);
    const last = first.at(-1)!.seq;
    const older = (await (await app.request(`/api/feed?limit=3&before=${last}`)).json()) as {
      seq: number;
    }[];
    expect(older.every((e) => e.seq < last)).toBe(true);
  });

  it('with a public origin, refuses writes from another site', async () => {
    process.env.PUBLIC_ORIGIN = 'https://hustle.example';
    const prod = createApp(engine);
    delete process.env.PUBLIC_ORIGIN;
    const post = (origin: string) =>
      prod.request('/api/auth/email/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin },
        body: JSON.stringify({ email: 'origin@example.com' }),
      });
    expect((await post('https://evil.example')).status).toBe(403);
    expect((await post('https://hustle.example')).status).toBe(200);
  });

  it('signs in with a NEAR wallet: a NEP-413 signature by a full-access key, once', async () => {
    const full = KeyPair.fromRandom('ed25519');
    const limited = KeyPair.fromRandom('ed25519');
    testnetKeys.set(`wally.testnet ${full.getPublicKey().toString()}`, 'full');
    testnetKeys.set(`wally.testnet ${limited.getPublicKey().toString()}`, 'function_call');
    const challenge = async () => {
      const res = await app.request('/api/auth/wallet/challenge', { method: 'POST' });
      expect(res.status).toBe(200);
      const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
      const c = (await res.json()) as { message: string; nonce: string; recipient: string };
      return { ...c, cookie };
    };
    // Signed by near-api-js's own NEP-413 implementation, not ours.
    const sign = async (
      key: KeyPair,
      c: { message: string; nonce: string; recipient: string },
      account = 'wally.testnet',
      recipient = c.recipient,
    ) => {
      const s = await new KeyPairSigner(key).signNep413Message(account, {
        message: c.message,
        recipient,
        nonce: Uint8Array.from(Buffer.from(c.nonce, 'base64')),
      });
      return {
        accountId: account,
        publicKey: s.publicKey.toString(),
        signature: Buffer.from(s.signature).toString('base64'),
        nonce: c.nonce,
      };
    };
    const verify = (cookie: string, input: unknown) =>
      app.request('/api/auth/wallet/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify(input),
      });

    const c1 = await challenge();
    expect(c1).toMatchObject({ message: 'Sign in to Hustle', recipient: 'localhost' });
    const ok = await verify(c1.cookie, await sign(full, c1));
    expect(ok.status).toBe(200);
    const session =
      ok.headers
        .getSetCookie()
        .find((h) => h.startsWith('hustle_session='))
        ?.split(';')[0] ?? '';
    expect(session).toMatch(/^hustle_session=/);
    const me = (await (await app.request('/api/me', { headers: { cookie: session } })).json()) as {
      player: { name: string; loginMethod: string; walletAccountId: string; accountId: string };
    };
    expect(me.player).toMatchObject({
      name: 'wally.testnet',
      loginMethod: 'wallet',
      walletAccountId: 'wally.testnet',
    });
    // The game's own account for the player is separate: the wallet never pays for anything.
    expect(me.player.accountId).not.toBe('wally.testnet');
    // The same signature again: the nonce is spent.
    expect((await verify(c1.cookie, await sign(full, c1))).status).toBe(401);

    const c2 = await challenge();
    // From another browser (no challenge cookie, or someone else's).
    expect((await verify('', await sign(full, c2))).status).toBe(401);
    const c3 = await challenge();
    expect((await verify(c2.cookie, await sign(full, c3))).status).toBe(401);
    // Signed for another site.
    const c4 = await challenge();
    expect(
      (await verify(c4.cookie, await sign(full, c4, 'wally.testnet', 'evil.example'))).status,
    ).toBe(401);
    // A function-call key can't sign in.
    const c5 = await challenge();
    expect((await verify(c5.cookie, await sign(limited, c5))).status).toBe(401);
    // A key that isn't on the account.
    const c6 = await challenge();
    expect((await verify(c6.cookie, await sign(KeyPair.fromRandom('ed25519'), c6))).status).toBe(
      401,
    );
    // Mainnet accounts are refused outright.
    const c7 = await challenge();
    expect((await verify(c7.cookie, await sign(full, c7, 'wally.near'))).status).toBe(400);
    // Expired.
    const c8 = await challenge();
    await engine.db.update(walletChallenges).set({ expiresAt: new Date(Date.now() - 1000) });
    expect((await verify(c8.cookie, await sign(full, c8))).status).toBe(401);
    // Signing in again finds the same player.
    const c9 = await challenge();
    const again = await verify(c9.cookie, await sign(full, c9));
    expect(((await again.json()) as { player: { name: string } }).player.name).toBe(
      'wally.testnet',
    );
  });

  it('a slow testnet key lookup does not hold up the game, and production needs an Origin', async () => {
    const key = KeyPair.fromRandom('ed25519');
    testnetKeys.set(`slowpoke.testnet ${key.getPublicKey().toString()}`, 'full');
    const res = await app.request('/api/auth/wallet/challenge', { method: 'POST' });
    const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const c = (await res.json()) as { message: string; nonce: string; recipient: string };
    const s = await new KeyPairSigner(key).signNep413Message('slowpoke.testnet', {
      message: c.message,
      recipient: c.recipient,
      nonce: Uint8Array.from(Buffer.from(c.nonce, 'base64')),
    });
    let release = () => {};
    let lookupStarted = () => {};
    const started = new Promise<void>((r) => {
      lookupStarted = r;
    });
    slowLookup = { started: lookupStarted, release: new Promise((r) => (release = r)) };
    const pending = app.request('/api/auth/wallet/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        accountId: 'slowpoke.testnet',
        publicKey: s.publicKey.toString(),
        signature: Buffer.from(s.signature).toString('base64'),
        nonce: c.nonce,
      }),
    });
    await started;
    // While the lookup waits, the lane (ticks, every other player's actions) is free.
    const lane = await Promise.race([
      engine.lane.run(async () => 'free'),
      new Promise((r) => setTimeout(() => r('held'), 2_000)),
    ]);
    expect(lane).toBe('free');
    release();
    slowLookup = null;
    expect((await pending).status).toBe(200);

    const before = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const prod = createApp(engine);
    process.env.NODE_ENV = before;
    expect((await prod.request('/api/auth/wallet/challenge', { method: 'POST' })).status).toBe(403);
  });

  it('never offers the stand-in sign-in in production unless ALLOW_MOCK_AUTH=1', async () => {
    const before = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const prod = createApp(engine);
    process.env.ALLOW_MOCK_AUTH = '1';
    const allowed = createApp(engine);
    delete process.env.ALLOW_MOCK_AUTH;
    process.env.NODE_ENV = before;
    const start = (a: typeof app) =>
      a.request('/api/auth/email/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'mock@example.com' }),
      });
    expect((await start(prod)).status).toBe(403);
    expect(
      ((await (await prod.request('/api/auth/config')).json()) as { mock: boolean }).mock,
    ).toBe(false);
    expect((await start(allowed)).status).toBe(200);
  });

  it('refuses owner actions without a session', async () => {
    const res = await post('/api/agents', { name: 'Nova' });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'unauthorized' });
  });

  it('a signed-in player mints an agent and amounts come back as strings', async () => {
    const cookie = await signIn('api@example.com');
    const res = await post(
      '/api/agents',
      {
        name: 'Nova',
        look: { body: 'orb', color: 'mint' },
        traits: ['meticulous', 'charming'],
        specialty: 'summary',
        tier: 'standard',
      },
      cookie,
    );
    expect(res.status).toBe(201);
    const agent = (await res.json()) as { balance: string; accountId: string };
    expect(agent.balance).toBe('2000000');
    expect(agent.accountId).toMatch(/\.agents\.hustle\.sim$/);
  });

  it('invalid input is a 400 with the problems listed', async () => {
    const cookie = await signIn('bad@example.com');
    const res = await post(
      '/api/jobs',
      { title: 'x', body: 'y', category: 'nope', budget: '-1' },
      cookie,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { details: unknown[] }).details.length).toBeGreaterThan(0);
  });

  it('malformed JSON and oversized bodies are refused', async () => {
    expect((await post('/api/auth/email/start', '{not json')).status).toBe(400);
    expect((await post('/api/auth/email/start', { email: 'a'.repeat(40_000) })).status).toBe(413);
  });

  it('another player’s agent is not found for owner actions', async () => {
    const a = await signIn('owner-a@example.com');
    const b = await signIn('owner-b@example.com');
    const agent = (await (
      await post(
        '/api/agents',
        {
          name: 'Kipling',
          look: { body: 'bolt', color: 'sky' },
          traits: ['frugal', 'bold'],
          specialty: 'research',
          tier: 'budget',
        },
        a,
      )
    ).json()) as { id: string };
    expect((await post(`/api/agents/${agent.id}/withdraw`, { amount: '1' }, b)).status).toBe(404);
    expect((await post(`/api/agents/not-a-uuid/withdraw`, { amount: '1' }, b)).status).toBe(404);
  });

  it('unknown routes are a JSON 404', async () => {
    const res = await app.request('/api/nope');
    expect(res.status).toBe(404);
  });
});
