import { createRng, defaultRulebook, usd } from '@hustle/core';
import { agents, bids, feed, jobs, ledger, spends } from '@hustle/db';
import { scamJob } from '@hustle/economy';
import type { NearAiCloudSimulator } from '@hustle/nearai';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkAchievements } from '../src/achievements.ts';
import {
  backAgent,
  decideApproval,
  knownVendorAccounts,
  mintAgent,
  updateRulebook,
} from '../src/agents/manage.ts';
import { loadAgent } from '../src/agents/state.ts';
import { think } from '../src/brain/think.ts';
import { chainCall } from '../src/durable.ts';
import { cancelJob, postTask, rateJob, sendAgentAfterJob } from '../src/jobs.ts';
import type { PlayerRow } from '../src/players.ts';
import { brainContext } from '../src/world/context.ts';
import { endDay } from '../src/world/day.ts';
import { houseAccount, openJob } from '../src/world/jobs.ts';
import { awardJob, placeBids } from '../src/world/market.ts';
import { advanceWork } from '../src/world/work.ts';
import { type World, world } from './harness.ts';

let w: World;
let owner: PlayerRow;
let seq = 0;

beforeAll(async () => {
  w = await world('money');
  owner = await w.signUp('owner@example.com', 'Ada');
}, 60_000);
afterAll(async () => w.close());

async function newAgent(
  traits: [
    'meticulous' | 'fast_and_loose' | 'skeptical' | 'charming' | 'frugal' | 'bold',
    'meticulous' | 'fast_and_loose' | 'skeptical' | 'charming' | 'frugal' | 'bold',
  ] = ['meticulous', 'charming'],
) {
  seq += 1;
  // A fresh owner per agent: players are capped at three agents each.
  owner = await w.signUp(`owner${seq}@example.com`, `Ada${seq}`);
  const agent = await mintAgent(w.engine, owner, {
    name: `Nova${seq}`,
    look: { body: 'orb', color: 'mint' },
    traits,
    specialty: 'summary',
    tier: 'standard',
  });
  // Free it from the tutorial practice job so tests control what it works on.
  await w.engine.db.update(agents).set({ busyJobId: null }).where(eq(agents.id, agent.id));
  await w.engine.db
    .update(jobs)
    .set({ status: 'cancelled' })
    .where(eq(jobs.reservedForAgentId, agent.id));
  return (await loadAgent(w.engine, agent.id))!;
}

/** A client job awarded straight to `agent` with a chosen plan, parked at a given stage. */
async function jobAtStage(
  agentId: string,
  stage: 'tools' | 'helper' | 'draft',
  plan: object,
  budget = usd('1.20'),
) {
  const rng = createRng(`job:${seq}:${Date.now()}`);
  const draft = {
    ...scamJob(rng),
    scam: false,
    budget,
    title: `Test job ${seq}`,
    category: 'summary' as const,
  };
  const job = await openJob(
    w.engine,
    { accountId: houseAccount(w.engine, 'clients'), playerId: null, autoAward: true },
    draft,
  );
  const [bid] = await w.engine.db
    .insert(bids)
    .values({
      jobId: job!.id,
      agentId,
      price: budget,
      pitch: 'test',
      status: 'open',
      createdTick: 0,
    })
    .returning();
  await awardJob(w.engine, job!, bid!.id);
  const [row] = await w.engine.db
    .update(jobs)
    .set({
      stage,
      nextAt: 0,
      plan: { plan, rushed: false, toolsBought: 0, helperDone: false },
    })
    .where(eq(jobs.id, job!.id))
    .returning();
  return row!;
}

const scamPlan = {
  steps: [],
  tools: [],
  payRequests: [{ payee: 'premium-data-unlock', amountUsd: '1.20', reason: 'client says so' }],
  hireHelper: false,
};

describe('money paths', () => {
  it('an agent following a scam instruction is stopped by its rulebook and loses nothing', async () => {
    const agent = await newAgent();
    const before = await w.engine.chain.ftBalance(agent.accountId!);
    const job = await jobAtStage(agent.id, 'tools', scamPlan);
    await advanceWork(w.engine);
    expect(await w.engine.chain.ftBalance(agent.accountId!)).toBe(before);
    const [spend] = await w.engine.db
      .select()
      .from(spends)
      .where(eq(spends.key, `req:${job.id}:0`));
    expect(spend).toMatchObject({ status: 'blocked', reason: 'vendor_not_allowed' });
    expect((await loadAgent(w.engine, agent.id))!.scamsBlocked).toBe(1);
    const shield = await w.engine.db
      .select()
      .from(feed)
      .where(and(eq(feed.jobId, job.id), eq(feed.kind, 'spend_blocked')));
    expect(shield[0]?.text).toContain('No money lost');
    expect((await w.engine.chain.getReputation(agent.accountId!)).scamsBlocked).toBe(1);
  });

  it('with a loose rulebook the same instruction costs real money, booked as a scam loss', async () => {
    const agent = await newAgent();
    await updateRulebook(w.engine, owner, agent, {
      ...defaultRulebook([]),
      anyVendor: true,
      maxPerCall: usd('2'),
      maxPerJob: usd('3'),
      dailyCap: usd('5'),
    });
    const before = await w.engine.chain.ftBalance(agent.accountId!);
    const job = await jobAtStage(agent.id, 'tools', scamPlan);
    await advanceWork(w.engine);
    expect(await w.engine.chain.ftBalance(agent.accountId!)).toBe(before - usd('1.20'));
    const [loss] = await w.engine.db
      .select()
      .from(ledger)
      .where(eq(ledger.ref, `spend:req:${job.id}:0`));
    expect(loss).toMatchObject({ kind: 'scam_loss', amount: -usd('1.20') });
  });

  it('a helper hire over the helper budget waits for the owner; approving pays the helper once', async () => {
    const agent = await newAgent();
    const job = await jobAtStage(
      agent.id,
      'helper',
      { steps: [], tools: [], payRequests: [], hireHelper: true },
      usd('2'),
    );
    await advanceWork(w.engine);
    const [held] = await w.engine.db
      .select()
      .from(spends)
      .where(eq(spends.key, `helper:${job.id}`));
    expect(held).toMatchObject({
      status: 'pending',
      reason: 'over_helper_budget',
      amount: usd('0.20'),
    });
    const [waiting] = await w.engine.db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(waiting?.stage).toBe('helper');
    const helperBalance = await w.engine.chain.ftBalance(held!.receiver);
    await decideApproval(w.engine, owner, held!.id, { approve: true });
    expect(await w.engine.chain.ftBalance(held!.receiver)).toBe(helperBalance + usd('0.20'));
    // The job picks the approved helper up on its next step and moves on to drafting.
    await w.engine.db.update(jobs).set({ nextAt: 0 }).where(eq(jobs.id, job.id));
    await advanceWork(w.engine);
    const [resumed] = await w.engine.db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(resumed).toMatchObject({ stage: 'draft', helperPrice: usd('0.20') });
    await expect(
      decideApproval(w.engine, owner, held!.id, { approve: true }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('a denied hire moves nothing, and a stranger cannot decide it', async () => {
    const agent = await newAgent();
    const job = await jobAtStage(
      agent.id,
      'helper',
      { steps: [], tools: [], payRequests: [], hireHelper: true },
      usd('3'),
    );
    await advanceWork(w.engine);
    const [held] = await w.engine.db
      .select()
      .from(spends)
      .where(eq(spends.key, `helper:${job.id}`));
    const stranger = await w.signUp(`stranger${seq}@example.com`, 'Eve');
    await expect(
      decideApproval(w.engine, stranger, held!.id, { approve: true }),
    ).rejects.toMatchObject({ code: 'not_found' });
    const before = await w.engine.chain.ftBalance(agent.accountId!);
    await decideApproval(w.engine, owner, held!.id, { approve: false });
    expect(await w.engine.chain.ftBalance(agent.accountId!)).toBe(before);
    expect((await w.engine.chain.getWallet(agent.accountId!)).pending).toHaveLength(0);
  });

  it('thinking the wallet would refuse to pay for is never bought from the provider', async () => {
    const agent = await newAgent();
    // The per-job cap: the wallet would refuse the draft halfway through a job.
    await updateRulebook(w.engine, owner, agent, {
      ...defaultRulebook(knownVendorAccounts(w.engine)),
      maxPerJob: 1n,
    });
    const fresh = (await loadAgent(w.engine, agent.id))!;
    const job = await jobAtStage(agent.id, 'draft', {
      steps: [],
      tools: [],
      payRequests: [],
      hireHelper: false,
    });
    const ctx = await brainContext(w.engine, fresh, job, 'draft');
    const result = await think(w.engine, fresh, `t:${job.id}`, job.id, ctx, job.body);
    expect(result).toEqual({ ok: false, reason: 'capped' });
    const booked = await w.engine.db
      .select()
      .from(ledger)
      .where(eq(ledger.ref, `inf:t:${job.id}`));
    expect(booked).toHaveLength(0);
  });

  it('a rulebook that could not pay the daily upkeep is refused', async () => {
    const agent = await newAgent();
    await expect(
      updateRulebook(w.engine, owner, agent, {
        ...defaultRulebook(knownVendorAccounts(w.engine)),
        maxPerCall: w.engine.cfg.upkeepPerDay - 1n,
      }),
    ).rejects.toThrow(/upkeep/);
  });

  it('a provider failure moves no money', async () => {
    const agent = await newAgent();
    const job = await jobAtStage(agent.id, 'draft', {
      steps: [],
      tools: [],
      payRequests: [],
      hireHelper: false,
    });
    (w.engine.nearai as NearAiCloudSimulator).failNext('unavailable');
    const before = await w.engine.chain.ftBalance(agent.accountId!);
    const ctx = await brainContext(w.engine, agent, job, 'draft');
    expect(await think(w.engine, agent, `f:${job.id}`, job.id, ctx, job.body)).toEqual({
      ok: false,
      reason: 'provider',
    });
    expect(await w.engine.chain.ftBalance(agent.accountId!)).toBe(before);
  });

  it('a repeated thinking step pays once and returns the same output', async () => {
    const agent = await newAgent();
    const job = await jobAtStage(agent.id, 'draft', {
      steps: [],
      tools: [],
      payRequests: [],
      hireHelper: false,
    });
    const ctx = await brainContext(w.engine, agent, job, 'draft');
    const first = await think(w.engine, agent, `r:${job.id}`, job.id, ctx, job.body);
    const mid = await w.engine.chain.ftBalance(agent.accountId!);
    const again = await think(
      w.engine,
      (await loadAgent(w.engine, agent.id))!,
      `r:${job.id}`,
      job.id,
      ctx,
      job.body,
    );
    expect(again).toEqual(first);
    expect(await w.engine.chain.ftBalance(agent.accountId!)).toBe(mid);
  });

  it('a chain call whose first try landed is answered from the chain, not sent twice', async () => {
    const account = `doubt${seq}.${w.engine.chain.ids.root}`;
    await w.engine.chain.createAccount(account);
    const key = `mint:doubt:${seq}`;
    const first = await w.engine.chain.mintCredits(account, usd('1'), key);
    // The retry a crash between the effect and its checkpoint would cause: same key, no second mint.
    const res = await chainCall('mint', () => w.engine.chain.mintCredits(account, usd('1'), key));
    expect(res).toMatchObject({ ok: true, value: { txHash: first.txHash } });
    expect(await w.engine.chain.ftBalance(account)).toBe(usd('1'));
  });

  it('an agent that cannot cover upkeep goes dormant, and a backer wakes it with a reputation dip', async () => {
    const agent = await newAgent();
    await w.engine.db.update(agents).set({ repXp: 100 }).where(eq(agents.id, agent.id));
    const balance = await w.engine.chain.ftBalance(agent.accountId!);
    await w.engine.chain.withdraw(owner.accountId, agent.accountId!, balance - 1n, `wd${seq}`);
    await endDay(w.engine, 1);
    const asleep = (await loadAgent(w.engine, agent.id))!;
    expect(asleep.dormantSinceDay).toBe(1);
    const backer = await w.signUp(`backer${seq}@example.com`, 'Sam');
    const awake = await backAgent(w.engine, backer, asleep, { amount: usd('1') });
    expect(awake.dormantSinceDay).toBeNull();
    expect(awake.repXp).toBeLessThan(asleep.repXp);
  });

  it('agents never bid on their own owner’s tasks', async () => {
    const agent = await newAgent();
    const job = await postTask(w.engine, owner, {
      title: 'Summarise my notes',
      body: 'Summarise in two lines: the shop opens at nine and closes at five.',
      category: 'summary',
      budget: '400000',
    });
    for (let i = 0; i < 5; i++) await placeBids(w.engine, [agent]);
    const mine = await w.engine.db
      .select()
      .from(bids)
      .where(and(eq(bids.jobId, job.id), eq(bids.agentId, agent.id)));
    expect(mine).toHaveLength(0);
  });

  it('a player task runs from escrow to a rated payout', async () => {
    const client = await w.signUp(`client${seq}@example.com`, 'Lola');
    const agent = await newAgent();
    const walletBefore = await w.engine.chain.ftBalance(client.accountId);
    const job = await postTask(w.engine, client, {
      title: 'Summarise this',
      body: 'Summarise in two bullets: rain today, sun tomorrow, wind on Friday.',
      category: 'summary',
      budget: '500000',
      autoAward: false,
    });
    expect(await w.engine.chain.ftBalance(client.accountId)).toBe(walletBefore - usd('0.50'));
    const [bid] = await w.engine.db
      .insert(bids)
      .values({
        jobId: job.id,
        agentId: agent.id,
        price: usd('0.40'),
        pitch: 'me',
        status: 'open',
        createdTick: 0,
      })
      .returning();
    await awardJob(w.engine, job, bid!.id);
    expect(await w.engine.chain.ftBalance(client.accountId)).toBe(walletBefore - usd('0.40'));
    for (let i = 0; i < 6; i++) {
      await w.engine.db.update(jobs).set({ nextAt: 0 }).where(eq(jobs.id, job.id));
      await advanceWork(w.engine);
    }
    const [delivered] = await w.engine.db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(delivered?.status).toBe('delivered');
    const agentBefore = await w.engine.chain.ftBalance(agent.accountId!);
    await rateJob(w.engine, client, delivered!, { rating: 5 });
    expect(await w.engine.chain.ftBalance(agent.accountId!)).toBe(agentBefore + usd('0.36'));
    const [paid] = await w.engine.db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(paid).toMatchObject({ status: 'paid', rating: 5 });
    await expect(rateJob(w.engine, client, paid!, { rating: 5 })).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('cancelling an open task refunds it, and a task larger than the wallet is refused', async () => {
    const client = await w.signUp(`cancel${seq}@example.com`, 'Noor');
    const before = await w.engine.chain.ftBalance(client.accountId);
    const job = await postTask(w.engine, client, {
      title: 'Translate a note',
      body: 'Translate into Spanish: see you at nine.',
      category: 'translation',
      budget: '300000',
    });
    await cancelJob(w.engine, client, job);
    expect(await w.engine.chain.ftBalance(client.accountId)).toBe(before);
    await expect(
      postTask(w.engine, client, {
        title: 'Too big',
        body: 'A job bigger than my wallet can hold.',
        category: 'summary',
        budget: '5000000',
      }),
    ).resolves.toBeDefined();
    await expect(
      postTask(w.engine, client, {
        title: 'Too big again',
        body: 'A job bigger than my wallet can hold.',
        category: 'summary',
        budget: '5000000',
      }),
    ).rejects.toMatchObject({ code: 'insufficient_funds' });
  });

  it('every agent’s cached balance still matches the chain', async () => {
    const rows = await w.engine.db
      .select()
      .from(agents)
      .where(sql`${agents.accountId} is not null`);
    for (const a of rows) expect(a.balance).toBe(await w.engine.chain.ftBalance(a.accountId!));
  });

  it('a player can send their agent after a job at a chosen price, never below its own cost', async () => {
    const agent = await newAgent();
    const rng = createRng(`send:${seq}`);
    const draft = {
      ...scamJob(rng),
      scam: false,
      title: `Send test ${seq}`,
      category: 'summary' as const,
      budget: usd('0.80'),
    };
    const job = await openJob(
      w.engine,
      { accountId: houseAccount(w.engine, 'clients'), playerId: null, autoAward: true },
      draft,
    );
    await expect(
      sendAgentAfterJob(w.engine, owner, job!, { agentId: agent.id, price: '100' }),
    ).rejects.toMatchObject({ code: 'invalid' });
    await expect(
      sendAgentAfterJob(w.engine, owner, job!, { agentId: agent.id, price: '900000' }),
    ).rejects.toMatchObject({ code: 'invalid' });
    await sendAgentAfterJob(w.engine, owner, job!, { agentId: agent.id, price: '500000' });
    const [bid] = await w.engine.db
      .select()
      .from(bids)
      .where(and(eq(bids.jobId, job!.id), eq(bids.agentId, agent.id)));
    expect(bid?.price).toBe(usd('0.50'));
    await expect(
      sendAgentAfterJob(w.engine, owner, job!, { agentId: agent.id, price: '500000' }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('an earned achievement is minted as a badge on the agent’s own account, once', async () => {
    const agent = await newAgent();
    await w.engine.db.update(agents).set({ scamsBlocked: 3 }).where(eq(agents.id, agent.id));
    const fresh = (await loadAgent(w.engine, agent.id))!;
    await checkAchievements(w.engine, fresh);
    await checkAchievements(w.engine, (await loadAgent(w.engine, agent.id))!);
    const badges = await w.engine.chain.badgesOf(agent.accountId!);
    expect(badges.map((b) => b.tokenId)).toEqual(['scam-survivor']);
  });
});
