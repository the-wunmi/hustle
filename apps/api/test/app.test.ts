import { createDb, createPool } from '@hustle/db';
import { runMigrations } from '@hustle/db/migrate';
import { freshTestDatabase } from '@hustle/db/test-databases';
import { closeEngine, createEngine, seedWorld } from '@hustle/engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';

let pool: ReturnType<typeof createPool>;
let app: ReturnType<typeof createApp>;
let engine: Awaited<ReturnType<typeof createEngine>>;

beforeAll(async () => {
  const env = await freshTestDatabase('api');
  await runMigrations(env.DATABASE_URL);
  pool = createPool(env.DATABASE_URL);
  engine = await createEngine({
    db: createDb(pool),
    env: { ...env, NODE_ENV: 'test', CHAIN_MODE: 'sim', AUTH_MODE: 'mock', NEARAI_MODE: 'mock' },
    secret: 'test-api',
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
