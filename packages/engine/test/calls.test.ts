import { createRng, usd } from '@hustle/core';
import { agents, bids, calls, jobs, spends } from '@hustle/db';
import { scamJob, VENDORS } from '@hustle/economy';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mintAgent } from '../src/agents/manage.ts';
import { loadAgent, rulebookOf } from '../src/agents/state.ts';
import {
  answerCall,
  callResolved,
  callsFor,
  callViews,
  expireCalls,
  raiseCalls,
} from '../src/calls.ts';
import { vendorAccount } from '../src/context.ts';
import type { PlayerRow } from '../src/players.ts';
import { markPresent } from '../src/presence.ts';
import { houseAccount, openJob } from '../src/world/jobs.ts';
import { activeAgents, awardJob, placeBids } from '../src/world/market.ts';
import { advanceWork, settle } from '../src/world/work.ts';
import { type World, world } from './harness.ts';

let w: World;
let seq = 0;

beforeAll(async () => {
  w = await world('calls');
}, 60_000);
afterAll(async () => w.close());

/** A watching owner with one idle Standard agent specialising in summaries. */
async function watchedAgent() {
  seq += 1;
  const owner = await w.signUp(`caller${seq}@example.com`, `Cal${seq}`);
  const agent = await mintAgent(w.engine, owner, {
    name: `Echo${seq}`,
    look: { body: 'orb', color: 'sky' },
    traits: ['meticulous', 'charming'],
    specialty: 'summary',
    tier: 'standard',
  });
  await w.engine.db.update(agents).set({ busyJobId: null }).where(eq(agents.id, agent.id));
  await w.engine.db
    .update(jobs)
    .set({ status: 'cancelled' })
    .where(eq(jobs.reservedForAgentId, agent.id));
  markPresent(w.engine, owner.id);
  return { owner, agent: (await loadAgent(w.engine, agent.id))! };
}

async function clientJob(budget: bigint, extra: { specialist?: string | null } = {}) {
  const draft = {
    ...scamJob(createRng(`calls:${seq}:${Date.now()}`)),
    scam: false,
    scamVendor: null,
    scamAmount: null,
    budget,
    title: `Calls job ${seq}`,
    category: 'summary' as const,
    body: 'Summarise the attached update in three bullets.',
    ...extra,
  };
  return (await openJob(
    w.engine,
    { accountId: houseAccount(w.engine, 'clients'), playerId: null, autoAward: true },
    draft,
  ))!;
}

async function callsOf(owner: PlayerRow) {
  return callsFor(w.engine, owner);
}

/** Awards a job straight to the agent and parks it at the tools stage with a plan. */
async function atTools(agentId: string, job: typeof jobs.$inferSelect, plan: object) {
  const [bid] = await w.engine.db
    .insert(bids)
    .values({
      jobId: job.id,
      agentId,
      price: job.budget,
      pitch: 't',
      status: 'open',
      createdTick: 0,
    })
    .returning();
  await awardJob(w.engine, job, bid!.id);
  await w.engine.db
    .update(jobs)
    .set({
      stage: 'tools',
      nextAt: 0,
      plan: { plan, rushed: false, toolsBought: 0, helperDone: false },
    })
    .where(eq(jobs.id, job.id));
}

/** Answers a call and waits for what it set off, then returns the call as the player now sees it. */
async function answerAndSettle(
  w: { engine: import('../src/context.ts').Engine },
  owner: Parameters<typeof answerCall>[1],
  id: string,
  input: Parameters<typeof answerCall>[3],
) {
  const first = await answerCall(w.engine, owner, id, input);
  expect(first.status).toBe('answered');
  // The answer comes back before its effects: the card says it's working on them.
  expect(first.outcome?.pending).toBe(true);
  await callResolved(w.engine, id);
  const [row] = await w.engine.db.select().from(calls).where(eq(calls.id, id));
  const [view] = await callViews(w.engine, [row!]);
  return view!;
}

describe('calls from an agent to its owner', () => {
  it('a watching owner gets a pitch call with prices and odds, and the auction waits for it', async () => {
    const { owner, agent } = await watchedAgent();
    const job = await clientJob(usd('1.40'));
    await raiseCalls(w.engine, await activeAgents(w.engine));
    const [call] = await callsOf(owner);
    expect(call).toMatchObject({ kind: 'pitch', status: 'open', defaultOption: 'auto' });
    expect(call!.job?.id).toBe(job.id);
    const prices = call!.options.filter((o) => o.winChance !== null);
    expect(prices.length).toBeGreaterThan(0);
    for (const o of prices) expect(o.winChance).toBeGreaterThanOrEqual(0);
    expect(call!.tells.map((t) => t.label)).toContain('Client');
    const [held] = await w.engine.db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(held!.closesTick).toBeGreaterThan(call!.expiresTick);

    const chosen = prices[0]!;
    await answerAndSettle(w, owner, call!.id, { choice: chosen.id });
    const [bid] = await w.engine.db
      .select()
      .from(bids)
      .where(and(eq(bids.jobId, job.id), eq(bids.agentId, agent.id)));
    expect(bid?.status).toBe('open');
    expect(chosen.label).toContain(`$${(Number(bid!.price) / 1e6).toFixed(2)}`);
    await expect(
      answerCall(w.engine, owner, call!.id, { choice: chosen.id }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it("a watched agent leaves bidding to its owner's calls; a lapsed pitch lets it price the job itself", async () => {
    const { owner, agent } = await watchedAgent();
    const job = await clientJob(usd('1.40'));
    await placeBids(w.engine, await activeAgents(w.engine));
    const mine = (jobId: string) =>
      w.engine.db
        .select()
        .from(bids)
        .where(and(eq(bids.jobId, jobId), eq(bids.agentId, agent.id)));
    expect(await mine(job.id)).toHaveLength(0);
    await raiseCalls(w.engine, await activeAgents(w.engine));
    const [call] = await callsOf(owner);
    const pitched = call!.job!.id;
    await w.engine.db.update(calls).set({ expiresTick: 0 }).where(eq(calls.id, call!.id));
    await expireCalls(w.engine);
    const [lapsed] = (await callsOf(owner)).filter((c) => c.id === call!.id);
    expect(lapsed).toMatchObject({ status: 'expired', choice: 'auto' });
    const [bid] = await mine(pitched);
    // Its own rules may pass on the job; either way the card says what happened.
    if (bid && bid.status !== 'withdrawn') expect(lapsed!.outcome?.text).toContain('Bid');
    else expect(lapsed!.outcome?.text).toContain('passed');
  });

  it('a job the owner passed on is not offered again', async () => {
    const { owner, agent } = await watchedAgent();
    await clientJob(usd('1.40'));
    await raiseCalls(w.engine, await activeAgents(w.engine));
    const [first] = await callsOf(owner);
    await answerAndSettle(w, owner, first!.id, { choice: 'pass' });
    await w.engine.db.update(agents).set({ nextCallTick: 0 }).where(eq(agents.id, agent.id));
    await raiseCalls(w.engine, await activeAgents(w.engine));
    const again = (await callsOf(owner)).filter((c) => c.status === 'open');
    for (const c of again) expect(c.job?.id).not.toBe(first!.job?.id);
  });

  it('an owner who is not watching gets no calls: the agent plays on its own', async () => {
    const { owner } = await watchedAgent();
    w.engine.presence.delete(owner.id);
    await clientJob(usd('1.40'));
    await raiseCalls(w.engine, await activeAgents(w.engine));
    expect(await callsOf(owner)).toHaveLength(0);
  });

  it('allowing a specialist on a vendor call writes it to the rulebook on chain, then pays it', async () => {
    const { owner, agent } = await watchedAgent();
    const job = await clientJob(usd('1.40'), { specialist: 'factcheck-desk' });
    await atTools(agent.id, job, { steps: [], tools: [], payRequests: [], hireHelper: false });
    await advanceWork(w.engine);
    const [call] = (await callsOf(owner)).filter((c) => c.kind === 'vendor');
    expect(call).toMatchObject({ status: 'open', defaultOption: 'refuse' });
    expect(call!.tells.find((t) => t.label === 'Who asked')).toBeTruthy();
    // The stage waits for the owner.
    const [waiting] = await w.engine.db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(waiting!.stage).toBe('tools');

    await answerAndSettle(w, owner, call!.id, { choice: 'allow' });
    w.engine.clock.tick += 1;
    await advanceWork(w.engine);
    const account = vendorAccount(w.engine, 'factcheck-desk');
    const fresh = (await loadAgent(w.engine, agent.id))!;
    expect(rulebookOf(fresh).allowedVendors).toContain(account);
    expect((await w.engine.chain.getWallet(agent.accountId!)).rulebook.allowedVendors).toContain(
      account,
    );
    const [paid] = await w.engine.db
      .select()
      .from(spends)
      .where(and(eq(spends.jobId, job.id), eq(spends.receiver, account)));
    expect(paid?.status).toBe('settled');
    const [done] = await w.engine.db.select().from(jobs).where(eq(jobs.id, job.id));
    expect((done!.plan as { specialist?: string }).specialist).toBe('bought');
  });

  it('a scam payment call left unanswered is refused, and the wallet blocks it on chain', async () => {
    const { owner, agent } = await watchedAgent();
    const scam = VENDORS.find((v) => v.scam)!;
    const job = await clientJob(usd('1.40'));
    await atTools(agent.id, job, {
      steps: [],
      tools: [],
      payRequests: [{ payee: scam.handle, amountUsd: '0.90', reason: 'verify the wallet first' }],
      hireHelper: false,
    });
    await advanceWork(w.engine);
    const [call] = (await callsOf(owner)).filter((c) => c.kind === 'vendor');
    expect(call!.tells.find((t) => t.label === 'Who asked')?.tone).toBe('bad');
    await w.engine.db.update(calls).set({ expiresTick: 0 }).where(eq(calls.id, call!.id));
    await expireCalls(w.engine);
    w.engine.clock.tick += 1;
    await advanceWork(w.engine);
    const [blocked] = await w.engine.db
      .select()
      .from(spends)
      .where(
        and(eq(spends.jobId, job.id), eq(spends.receiver, vendorAccount(w.engine, scam.handle))),
      );
    expect(blocked).toMatchObject({ status: 'blocked', reason: 'vendor_not_allowed' });
    const [resolved] = (await callsOf(owner)).filter((c) => c.id === call!.id);
    expect(resolved).toMatchObject({ status: 'expired', choice: 'refuse' });
    expect(resolved!.outcome?.tone).toBe('shield');
  });

  it('a streak earns a contract offer; taking it puts up a bond, which a refund forfeits', async () => {
    const { owner, agent } = await watchedAgent();
    await w.engine.db
      .update(agents)
      .set({ streak: 3, nextContractTick: 0, nextCallTick: 0 })
      .where(eq(agents.id, agent.id));
    await raiseCalls(w.engine, await activeAgents(w.engine));
    const [offer] = await callsOf(owner);
    expect(offer).toMatchObject({ kind: 'contract', defaultOption: 'decline' });
    const accept = offer!.options.find((o) => o.id === 'accept')!;
    const bond = BigInt(accept.cost!);
    expect(bond).toBeGreaterThan(0n);

    const before = await w.engine.chain.ftBalance(agent.accountId!);
    const treasuryBefore = await w.engine.chain.ftBalance(w.engine.chain.ids.treasury);
    const answered = await answerAndSettle(w, owner, offer!.id, { choice: 'accept' });
    expect(answered.outcome?.tone).toBe('coin');
    expect(await w.engine.chain.ftBalance(w.engine.chain.ids.treasury)).toBeGreaterThanOrEqual(
      treasuryBefore + bond,
    );
    const [contract] = await w.engine.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.reservedForAgentId, agent.id), eq(jobs.status, 'open')));
    expect(contract).toMatchObject({ bond, contractTier: 1 });
    expect(await w.engine.chain.ftBalance(agent.accountId!)).toBeLessThan(before);

    // The arbiter refunds the client: the bond goes to them as damages, and the streak ends.
    const [bid] = await w.engine.db.select().from(bids).where(eq(bids.jobId, contract!.id));
    await awardJob(w.engine, contract!, bid!.id);
    const [delivered] = await w.engine.db
      .update(jobs)
      // An honest contract (a trap one returns the bond instead).
      .set({ status: 'delivered', scam: false })
      .where(eq(jobs.id, contract!.id))
      .returning();
    const client = houseAccount(w.engine, 'clients');
    const clientBefore = await w.engine.chain.ftBalance(client);
    await settle(w.engine, delivered!, (await loadAgent(w.engine, agent.id))!, null, 'refunded');
    expect(await w.engine.chain.ftBalance(client)).toBe(clientBefore + bond);
    expect((await loadAgent(w.engine, agent.id))!.streak).toBe(0);
  });

  it('a trap contract costs nothing but the work: bond back, streak and reputation kept, held payments dropped', async () => {
    const { owner, agent } = await watchedAgent();
    await w.engine.db
      .update(agents)
      .set({ streak: 4, nextContractTick: 0, nextCallTick: 0, repXp: 100 })
      .where(eq(agents.id, agent.id));
    await raiseCalls(w.engine, await activeAgents(w.engine));
    const [offer] = await callsOf(owner);
    await answerAndSettle(w, owner, offer!.id, { choice: 'accept' });
    const [contract] = await w.engine.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.reservedForAgentId, agent.id), eq(jobs.status, 'open')));
    const [bid] = await w.engine.db.select().from(bids).where(eq(bids.jobId, contract!.id));
    await awardJob(w.engine, contract!, bid!.id);
    // A proofreading hire left waiting for approval on this job.
    await w.engine.db.insert(spends).values({
      key: `held-trap-${seq}`,
      agentId: agent.id,
      jobId: contract!.id,
      kind: 'helper',
      receiver: 'x',
      amount: usd('0.11'),
      status: 'pending',
      memo: 'proofread',
      day: 1,
    });
    const [delivered] = await w.engine.db
      .update(jobs)
      .set({ status: 'delivered', scam: true })
      .where(eq(jobs.id, contract!.id))
      .returning();
    const before = await w.engine.chain.ftBalance(agent.accountId!);
    await settle(w.engine, delivered!, (await loadAgent(w.engine, agent.id))!, null, 'refunded');
    const after = (await loadAgent(w.engine, agent.id))!;
    expect(after.streak).toBe(4);
    expect(after.repXp).toBe(100);
    expect(await w.engine.chain.ftBalance(agent.accountId!)).toBe(before + contract!.bond!);
    const [held] = await w.engine.db
      .select()
      .from(spends)
      .where(eq(spends.key, `held-trap-${seq}`));
    expect(held?.status).not.toBe('pending');
  });

  it('a bond over the daily cap is refused by the wallet, with a reason the owner can act on', async () => {
    const { owner, agent } = await watchedAgent();
    const rulebook = rulebookOf(agent);
    await w.engine.chain.setRulebook(owner.accountId, agent.accountId!, {
      ...rulebook,
      dailyCap: usd('0.05'),
    });
    await w.engine.db
      .update(agents)
      .set({ streak: 3, nextContractTick: 0, nextCallTick: 0 })
      .where(eq(agents.id, agent.id));
    await raiseCalls(w.engine, await activeAgents(w.engine));
    const [offer] = await callsOf(owner);
    const answered = await answerAndSettle(w, owner, offer!.id, { choice: 'accept' });
    expect(answered.outcome).toMatchObject({ tone: 'bad' });
    expect(answered.outcome?.text).toContain('daily cap');
    const open = await w.engine.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.reservedForAgentId, agent.id), eq(jobs.status, 'open')));
    expect(open).toHaveLength(0);
  });
});
