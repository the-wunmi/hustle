// One process of a crash test (crash.test.ts): boots the engine on the test's database (which
// resumes any workflow a killed process left), then runs one operation. HUSTLE_CRASH_AT makes the
// process kill itself (SIGKILL) at a named point inside that operation.
import { usd } from '@hustle/core';
import { agents, createDb, createPool, players } from '@hustle/db';
import { eq } from 'drizzle-orm';
import { mintAgent } from '../src/agents/manage.ts';
import { closeEngine, createEngine } from '../src/context.ts';
import { startEmailLogin, verifyEmailLogin } from '../src/players.ts';
import { seedWorld } from '../src/seed.ts';
import { buyAgent, listAgent } from '../src/trade.ts';
import { houseAccount, openJob } from '../src/world/jobs.ts';
import { tick } from '../src/world/tick.ts';

const op = process.argv[2] ?? 'boot';
const pool = createPool(process.env.DATABASE_URL);
const engine = await createEngine({
  db: createDb(pool),
  env: {
    ...process.env,
    NODE_ENV: 'test',
    CHAIN_MODE: 'sim',
    AUTH_MODE: 'mock',
    NEARAI_MODE: 'mock',
  },
  secret: 'test-crash',
});
await seedWorld(engine);

async function signUp(email: string, name: string) {
  const { challengeId, simulatedInbox } = await startEmailLogin(engine, { email });
  return (await verifyEmailLogin(engine, { challengeId, code: simulatedInbox.code, name })).player;
}

async function byName(name: string) {
  const [row] = await engine.db.select().from(agents).where(eq(agents.name, name));
  if (!row) throw new Error(`no agent ${name}`);
  return row;
}

switch (op) {
  case 'boot':
    break;
  case 'escrow':
    await openJob(
      engine,
      { accountId: houseAccount(engine, 'clients'), playerId: null, autoAward: true },
      {
        source: 'client',
        category: 'summary',
        title: 'Crash test: summarise a memo',
        body: 'Summarise this memo in three lines.',
        budget: usd('0.80'),
        minLevel: 1,
        clientName: 'Crash Co',
        clientStyle: 'balanced',
        scam: false,
        scamVendor: null,
        scamAmount: null,
        sponsorPoolId: null,
        answerKeywords: null,
      },
    );
    break;
  case 'mint': {
    const owner = await signUp('minter@example.com', 'Minter');
    await mintAgent(engine, owner, {
      name: 'Crashy',
      look: { body: 'orb', color: 'mint' },
      traits: ['charming', 'frugal'],
      specialty: 'summary',
      tier: 'standard',
    });
    break;
  }
  case 'sale-setup': {
    const seller = await signUp('seller@example.com', 'Seller');
    await signUp('buyer@example.com', 'Buyer');
    const agent = await mintAgent(engine, seller, {
      name: 'Forsale',
      look: { body: 'bolt', color: 'sky' },
      traits: ['bold', 'meticulous'],
      specialty: 'summary',
      tier: 'standard',
    });
    // Off its practice job, so it can be listed.
    await engine.db.update(agents).set({ busyJobId: null }).where(eq(agents.id, agent.id));
    await listAgent(engine, seller, await byName('Forsale'), { price: usd('1.50') });
    break;
  }
  case 'sale': {
    const [buyer] = await engine.db.select().from(players).where(eq(players.name, 'Buyer'));
    if (!buyer) throw new Error('no buyer');
    await buyAgent(engine, buyer, await byName('Forsale'), {
      expectedPrice: usd('1.50'),
      requestId: 'crash-sale-request-1',
    });
    break;
  }
  case 'endday':
    // Tick until day 1 is closed (the tick that starts day 2 closes it).
    while ((engine.clock.closedDay ?? 0) < 1) await tick(engine);
    break;
  default:
    throw new Error(`unknown op ${op}`);
}

await closeEngine();
await pool.end();
process.exit(0);
