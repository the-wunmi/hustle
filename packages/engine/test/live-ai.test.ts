import { usd } from '@hustle/core';
import { agents, inferenceCalls, ledger, nearaiBudget, players } from '@hustle/db';
import { type NearAiCloud, NearAiCloudSimulator, NearAiError } from '@hustle/nearai';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mintAgent } from '../src/agents/manage.ts';
import { loadAgent } from '../src/agents/state.ts';
import { liveAiBudget, usdToNano, utcDay } from '../src/brain/budget.ts';
import { scriptedResponse } from '../src/brain/scripted.ts';
import { think } from '../src/brain/think.ts';
import { agentView, worldView } from '../src/views.ts';
import { brainContext } from '../src/world/context.ts';
import { houseAccount, openJob } from '../src/world/jobs.ts';
import { type World, world } from './harness.ts';

/**
 * Live NEAR AI only for real players' agents, under an org-wide daily budget. The "live" provider
 * here is the simulator reporting itself as live, so no test spends money; it counts the calls it
 * gets, and can fail the next one the way a reasoning model that ran out of tokens does.
 */
let w: World;
let seq = 0;
const stats = { chats: 0, failNextWithBill: 0n };

function liveStandIn(): NearAiCloud {
  const sim = new NearAiCloudSimulator('test-live', scriptedResponse);
  return {
    mode: 'live',
    listModels: () => sim.listModels(),
    createAgentKey: (name, limit) => sim.createAgentKey(name, limit),
    setSpendLimit: (id, limit) => sim.setSpendLimit(id, limit),
    async chat(key, request) {
      stats.chats++;
      if (stats.failNextWithBill > 0n) {
        stats.failNextWithBill = 0n;
        throw new NearAiError('bad_response', 'No completion content', 'billed-but-empty');
      }
      return sim.chat(key, request);
    },
    async costs(ids) {
      if (ids.includes('billed-but-empty')) return { 'billed-but-empty': 50_000n };
      return sim.costs(ids);
    },
    signature: (id) => sim.signature(id),
    attestation: (nonce, model) => sim.attestation(nonce, model),
  };
}

beforeAll(async () => {
  w = await world('liveai');
  w.engine.nearai = liveStandIn();
}, 60_000);
afterAll(async () => w.close());

async function playerAgent() {
  seq++;
  const owner = await w.signUp(`live${seq}@example.com`, `Live${seq}`);
  const agent = await mintAgent(w.engine, owner, {
    name: `Liv${seq}`,
    look: { body: 'orb', color: 'mint' },
    traits: ['meticulous', 'charming'],
    specialty: 'summary',
    tier: 'standard',
  });
  await w.engine.db.update(agents).set({ busyJobId: null }).where(eq(agents.id, agent.id));
  return (await loadAgent(w.engine, agent.id))!;
}

async function aJob() {
  const job = await openJob(
    w.engine,
    { accountId: houseAccount(w.engine, 'clients'), playerId: null, autoAward: true },
    {
      source: 'client',
      category: 'summary',
      title: `Live test ${seq}`,
      body: 'Summarise this memo in three lines.',
      budget: usd('0.80'),
      minLevel: 1,
      clientName: 'Live Co',
      clientStyle: 'balanced',
      scam: false,
      scamVendor: null,
      scamAmount: null,
      sponsorPoolId: null,
      answerKeywords: null,
    },
  );
  return job!;
}

async function bid(agentId: string, key: string) {
  const agent = (await loadAgent(w.engine, agentId))!;
  const job = await aJob();
  const ctx = await brainContext(w.engine, agent, job, 'bid');
  return think(w.engine, agent, key, job.id, ctx, job.body);
}

const sourceOf = async (key: string) =>
  (await w.engine.db.select().from(inferenceCalls).where(eq(inferenceCalls.key, key)))[0]?.source;

describe('live NEAR AI for players only, under a daily budget', () => {
  it("a player's agent thinks live; a house agent uses the recorded brain", async () => {
    w.engine.liveAiBudgetNano = usdToNano('1.00');
    const mine = await playerAgent();
    const before = stats.chats;
    const first = await bid(mine.id, `live-p${seq}`);
    expect(first).toMatchObject({ ok: true });
    expect(stats.chats).toBe(before + 1);
    expect(await sourceOf(`live-p${seq}`)).toBe('live');

    const [house] = await w.engine.db
      .select({ agent: agents })
      .from(agents)
      .innerJoin(players, eq(players.id, agents.ownerId))
      .where(eq(players.isHouse, true))
      .limit(1);
    const houseAgent = house!.agent;
    await w.engine.db.update(agents).set({ busyJobId: null }).where(eq(agents.id, houseAgent.id));
    const chatsBefore = stats.chats;
    expect(await bid(houseAgent.id, `live-h${seq}`)).toMatchObject({ ok: true });
    expect(stats.chats).toBe(chatsBefore);
    expect(await sourceOf(`live-h${seq}`)).toBe('recorded');
    expect((await agentView(w.engine, houseAgent, null)).brain).toEqual({
      source: 'recorded',
      why: 'house',
    });
    expect((await agentView(w.engine, mine, null)).brain).toEqual({ source: 'live', why: 'live' });
  });

  it('spend is counted from the billed cost and never passes the budget, even reserved', async () => {
    const budget = await liveAiBudget(w.engine);
    expect(budget.spentNano).toBeGreaterThan(0n);
    const [row] = await w.engine.db
      .select()
      .from(nearaiBudget)
      .where(eq(nearaiBudget.day, utcDay()));
    expect(row!.reservedNano).toBe(0n);
    expect(row!.spentNano + row!.reservedNano).toBeLessThanOrEqual(w.engine.liveAiBudgetNano);
  });

  it('once the budget would be passed, player agents fall back to the recorded brain, and the game says so', async () => {
    const spent = (await liveAiBudget(w.engine)).spentNano;
    // Room for less than one call's worst case.
    w.engine.liveAiBudgetNano = spent + 1n;
    const mine = await playerAgent();
    const chatsBefore = stats.chats;
    expect((await bid(mine.id, `over-${seq}`)).ok).toBe(true);
    expect(stats.chats).toBe(chatsBefore);
    expect(await sourceOf(`over-${seq}`)).toBe('recorded');
    const after = await liveAiBudget(w.engine);
    expect(after.reached).toBe(true);
    expect(after.spentNano).toBe(spent);
    expect((await worldView(w.engine)).liveAi?.reached).toBe(true);
    expect((await agentView(w.engine, mine, null)).brain).toEqual({
      source: 'recorded',
      why: 'budget_reached',
    });
    // Raising the budget mid-day doesn't undo today's fallback: it lasts until the UTC reset.
    w.engine.liveAiBudgetNano = usdToNano('1.00');
    const again = stats.chats;
    await bid(mine.id, `still-${seq}`);
    expect(stats.chats).toBe(again);
  });

  it('a new UTC day starts with a fresh budget', async () => {
    await w.engine.db
      .update(nearaiBudget)
      .set({ day: '2000-01-01' })
      .where(eq(nearaiBudget.day, utcDay()));
    const fresh = await liveAiBudget(w.engine);
    expect(fresh).toMatchObject({ spentNano: 0n, reached: false, calls: 0 });
    const mine = await playerAgent();
    const before = stats.chats;
    await bid(mine.id, `newday-${seq}`);
    expect(stats.chats).toBe(before + 1);
  });

  it('an empty reply (a model that ran out of tokens reasoning) counts against the budget, never the agent', async () => {
    const mine = await playerAgent();
    const spentBefore = (await liveAiBudget(w.engine)).spentNano;
    const balanceBefore = await w.engine.chain.ftBalance(mine.accountId!);
    stats.failNextWithBill = 1n;
    expect(await bid(mine.id, `empty-${seq}`)).toEqual({ ok: false, reason: 'provider' });
    expect((await liveAiBudget(w.engine)).spentNano).toBe(spentBefore + 50_000n);
    expect(await w.engine.chain.ftBalance(mine.accountId!)).toBe(balanceBefore);
    const booked = await w.engine.db
      .select()
      .from(ledger)
      .where(and(eq(ledger.agentId, mine.id), eq(ledger.kind, 'inference')));
    expect(booked).toHaveLength(0);
  });

  it('the budget is a dollar amount, read without floats', () => {
    expect(usdToNano('1.00')).toBe(1_000_000_000n);
    expect(usdToNano('0.25')).toBe(250_000_000n);
    expect(() => usdToNano('one dollar')).toThrow('NEARAI_DAILY_BUDGET_USD');
  });
});
