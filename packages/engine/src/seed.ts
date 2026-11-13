import { defaultRulebook, usd } from '@hustle/core';
import { agents, players, sponsorPools } from '@hustle/db';
import { HOUSE_PLAYERS, RIVALS, SPONSOR_POOLS } from '@hustle/economy';
import { eq } from 'drizzle-orm';
import { knownVendorAccounts, mintSteps } from './agents/manage.ts';
import { storedRulebook } from './agents/state.ts';
import type { Engine } from './context.ts';
import {
  chainCall,
  DBOS,
  durableEngine,
  inTx,
  readStep,
  runOnce,
  stableUuid,
  wfId,
} from './durable.ts';
import { chainKey } from './record.ts';
import { houseAccount } from './world/jobs.ts';

/** Credits kept in each house account that posts jobs; topped back up at each check. */
const HOUSE_FLOAT = usd('500');
const HOUSE_LOW = usd('100');
/** Each house player's wallet, for backing rivals. */
const HOUSE_PLAYER_FLOAT = usd('25');

/**
 * First-run setup, safe to run on every boot: house accounts that post jobs, sponsor pools, house
 * players and their rival agents. Rivals are ordinary agents minted through the same path as yours.
 */
export async function seedWorld(engine: Engine): Promise<void> {
  for (const who of ['clients', 'sponsors'] as const) {
    const account = houseAccount(engine, who);
    await chainCall('create_account', () => engine.chain.createAccount(account));
    await topUpHouse(engine, account, 'seed');
  }
  for (const pool of SPONSOR_POOLS) {
    await engine.db
      .insert(sponsorPools)
      .values({ id: pool.id, remaining: pool.pool })
      .onConflictDoNothing();
  }
  for (const name of HOUSE_PLAYERS) {
    const accountId = `${name.toLowerCase()}.house.${engine.chain.ids.root}`;
    await chainCall('create_account', () => engine.chain.createAccount(accountId));
    await engine.db
      .insert(players)
      .values({
        name,
        email: null,
        loginMethod: 'house',
        authSubject: `house|${name}`,
        accountId,
        isHouse: true,
      })
      .onConflictDoNothing();
    await chainCall('mint', () =>
      engine.chain.mintCredits(accountId, HOUSE_PLAYER_FLOAT, `mint:house-player:${accountId}`),
    );
  }
  const house = await engine.db.select().from(players).where(eq(players.isHouse, true));
  for (const p of house) engine.houseOwners.add(p.id);
  const existing = await engine.db.select().from(agents);
  for (const rival of RIVALS) {
    if (existing.some((a) => a.name === rival.name)) continue;
    const owner = house.find((p) => p.name === rival.owner);
    if (!owner) continue;
    // One workflow per rival (mint, rulebook, starting credits, strategy), keyed by its name, so a
    // crash part-way through seeding finishes that rival instead of leaving it half set up.
    await runOnce(rivalWorkflow, wfId(engine, 'rival', rival.name), {
      name: rival.name,
      owner: { id: owner.id, accountId: owner.accountId, name: owner.name },
    });
  }
}

interface RivalInput {
  name: string;
  owner: { id: string; accountId: string; name: string };
}

async function seedRival(input: RivalInput): Promise<void> {
  const engine = durableEngine();
  const rival = RIVALS.find((r) => r.name === input.name);
  if (!rival) return;
  const { owner } = input;
  const agentId = stableUuid(`${engine.clock.seed}:rival:${rival.name}`);
  const minted = await mintSteps({
    agentId,
    owner,
    data: {
      name: rival.name,
      look: rival.look,
      traits: [...rival.traits],
      specialty: rival.specialty,
      tier: rival.tier,
    },
    rulebook: storedRulebook(defaultRulebook(knownVendorAccounts(engine))),
  });
  if (!minted.ok) throw new Error(`could not mint rival ${rival.name}: ${minted.code}`);
  const agent = minted.agent;
  const accountId = agent.accountId ?? '';
  const rulebook = rival.looseRulebook
    ? {
        ...defaultRulebook([]),
        anyVendor: true,
        maxPerCall: usd('2'),
        maxPerJob: usd('3'),
        dailyCap: usd('5'),
      }
    : defaultRulebook(knownVendorAccounts(engine));
  if (rival.looseRulebook)
    await chainCall('set_rulebook', () =>
      engine.chain.setRulebook(owner.accountId, accountId, rulebook),
    );
  // Rivals start with their own amount instead of the standard starter credits.
  const extra = rival.credits - engine.cfg.starterAgentCredits;
  if (extra > 0n) {
    await chainCall('mint', () =>
      engine.chain.mintCredits(accountId, extra, `mint:rival:${agent.id}`),
    );
  } else if (extra < 0n) {
    // Some rivals start poorer than a new player's agent, so the world has agents near the edge.
    await chainCall('withdraw', () =>
      engine.chain.withdraw(owner.accountId, accountId, -extra, `withdraw:rival:${agent.id}`),
    );
  }
  const balance = await readStep('rival balance', () => engine.chain.ftBalance(accountId));
  await inTx('rival strategy', (db) =>
    db
      .update(agents)
      .set({
        strategy: {
          tier: rival.tier,
          focus: rival.focus,
          priceStyle: rival.priceStyle,
          sponsorJobs: true,
          screenJobs: false,
        },
        rulebook: storedRulebook(rulebook),
        balance,
      })
      .where(eq(agents.id, agent.id)),
  );
}

const rivalWorkflow = DBOS.registerWorkflow(seedRival, { name: 'seedRival' });

/** Refills a house account that runs low; `when` keys the refill (a day, or the seed). */
export async function topUpHouse(engine: Engine, account: string, when: string): Promise<void> {
  const balance = await engine.chain.ftBalance(account);
  if (balance >= HOUSE_LOW) return;
  const key = chainKey('mint', `house:${account}:${when}`);
  await chainCall('mint', () => engine.chain.mintCredits(account, HOUSE_FLOAT - balance, key));
}

export async function topUpHouses(engine: Engine, when: string): Promise<void> {
  for (const who of ['clients', 'sponsors'] as const)
    await topUpHouse(engine, houseAccount(engine, who), when);
}
