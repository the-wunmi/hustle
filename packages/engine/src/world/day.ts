import type { SpendOutcome } from '@hustle/chain';
import { type Category, formatUsd, sum } from '@hustle/core';
import {
  agents,
  bids,
  calls,
  dayReports,
  feed,
  inferenceCalls,
  jobs,
  ledger,
  players,
  spends,
  type Tx,
} from '@hustle/db';
import {
  conditionFor,
  DORMANT_XP_DECAY,
  diaryLine,
  eventForDay,
  levelForXp,
} from '@hustle/economy';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { checkAchievements } from '../achievements.ts';
import { moneyWorkflow } from '../agents/manage.ts';
import { type AgentRow, skillsOf, traitsOf } from '../agents/state.ts';
import type { Engine } from '../context.ts';
import {
  chainCall,
  crashPoint,
  DBOS,
  durableEngine,
  inTx,
  readStep,
  runOnce,
  wfId,
} from '../durable.ts';
import { book, chainKey, post } from '../record.ts';
import { topUpHouses } from '../seed.ts';
import { tickRng } from './market.ts';

/** Chance per day that a house player backs a dormant rival, so the world shows comebacks too. */
const HOUSE_BACKING_CHANCE = 0.35;

/**
 * Runs when a day ends: upkeep from every awake agent (the wallet pays the treasury; an agent that
 * can't pay goes dormant), dormant agents fade, training finishes, and each agent gets a day report.
 * It is one workflow per day, with one child workflow per agent, so a crash part-way resumes where
 * it stopped: no agent pays upkeep twice or loses a day.
 */
export async function endDay(engine: Engine, day: number): Promise<void> {
  await runOnce(endDayWorkflow, wfId(engine, 'endday', String(day)), day);
}

/** Agents closed side by side, as the tick runs them. */
const DAY_CLOSE_BATCH = 8;

async function endDaySteps(day: number): Promise<{ failed: string[] }> {
  const engine = durableEngine();
  const ids = await readStep('agents to close', async () =>
    (
      await engine.db
        .select({ id: agents.id })
        .from(agents)
        .where(isNotNull(agents.accountId))
        .orderBy(agents.id)
    ).map((r) => r.id),
  );
  const parent = DBOS.workflowID ?? '';
  const failed: string[] = [];
  for (let i = 0; i < ids.length; i += DAY_CLOSE_BATCH) {
    const batch = ids.slice(i, i + DAY_CLOSE_BATCH);
    const handles = [];
    for (const id of batch) {
      handles.push(
        await DBOS.startWorkflow(agentDayWorkflow, { workflowID: `${parent}:agent:${id}` })(
          day,
          id,
        ),
      );
    }
    const results = await Promise.allSettled(handles.map((h) => h.getResult()));
    results.forEach((r, j) => {
      if (r.status === 'rejected') failed.push(`${batch[j]}: ${String(r.reason)}`);
    });
  }
  // A failed agent is logged, not retried by closing the day again: the day's workflow is done.
  if (failed.length > 0) engine.log('day close failed for some agents', { day, failed });
  const backings = await readStep('house backers', () => houseBackers(engine, day));
  for (const b of backings) {
    await DBOS.startWorkflow(moneyWorkflow, { workflowID: `${parent}:backing:${b.agent.id}` })({
      kind: 'backing',
      ref: chainKey('backing', `${b.agent.id}:${b.backer.id}:day${day}`),
      amount: b.amount,
      player: b.backer,
      agent: b.agent,
      day,
    }).then((h) =>
      h.getResult().catch((err) => engine.log('house backing failed', { error: String(err) })),
    );
  }
  // Simulated clients and sponsors never run dry over a long session.
  await readStep('top up houses', () => topUpHouses(engine, `day${day}`));
  await inTx('day begins', async (db) => {
    const event = eventForDay(day + 1);
    await post(
      engine,
      {
        kind: 'event',
        tone: 'neutral',
        text: event
          ? `Day ${day + 1}: ${event.name}. ${event.description}`
          : `Day ${day + 1} begins. A quiet market.`,
      },
      db,
    );
  });
  return { failed };
}

export const endDayWorkflow = DBOS.registerWorkflow(endDaySteps, { name: 'endDay' });

/** One agent's day close: upkeep (a keyed wallet spend), then its books, decay and report together. */
async function agentDaySteps(day: number, agentId: string): Promise<void> {
  const engine = durableEngine();
  const agent = await readStep('agent', async () => {
    const [row] = await engine.db.select().from(agents).where(eq(agents.id, agentId));
    return row ?? null;
  });
  if (!agent?.accountId) return;
  const accountId = agent.accountId;
  const levelBefore = levelForXp(agent.repXp, engine.cfg);
  const fee = engine.cfg.upkeepPerDay;
  const key = `upkeep:${agent.id}:${day}`;
  // A frozen agent is paused (off the board, no upkeep): its owner froze it, or it was just sold and
  // its new owner hasn't confirmed its rulebook yet.
  const owesUpkeep = agent.dormantSinceDay === null && !agent.frozen;
  let outcome: SpendOutcome | null = null;
  if (owesUpkeep) {
    const before = await readStep('balance', () => engine.chain.ftBalance(accountId));
    if (before >= fee) {
      const spent = await chainCall('upkeep', () =>
        engine.chain.spend(accountId, {
          key,
          kind: 'upkeep',
          receiverId: engine.chain.ids.treasury,
          amount: fee,
          jobId: null,
          memo: `upkeep day ${day}`,
          receipt: null,
        }),
      );
      crashPoint('endday:upkeep');
      outcome = spent.ok ? spent.value : null;
    }
  }
  const balance = await readStep('balance after', () => engine.chain.ftBalance(accountId));
  const closed = await inTx('close agent day', async (db) => {
    let current = agent;
    if (owesUpkeep) current = await settleUpkeep(engine, db, agent, day, outcome, balance);
    else {
      const [row] = await db
        .update(agents)
        .set({ repXp: Math.max(0, agent.repXp - DORMANT_XP_DECAY), balance })
        .where(eq(agents.id, agent.id))
        .returning();
      current = row ?? agent;
    }
    current = await finishTraining(engine, db, current, day);
    await writeReport(engine, db, current, day, levelBefore);
    return current;
  });
  await readStep('achievements', () => checkAchievements(engine, closed));
}

export const agentDayWorkflow = DBOS.registerWorkflow(agentDaySteps, { name: 'agentDay' });

async function settleUpkeep(
  engine: Engine,
  db: Tx,
  agent: AgentRow,
  day: number,
  outcome: SpendOutcome | null,
  balance: bigint,
): Promise<AgentRow> {
  const fee = engine.cfg.upkeepPerDay;
  const key = `upkeep:${agent.id}:${day}`;
  if (outcome) {
    await db
      .insert(spends)
      .values({
        key,
        agentId: agent.id,
        kind: 'upkeep',
        receiver: engine.chain.ids.treasury,
        amount: fee,
        status: outcome.status,
        reason: outcome.reason,
        memo: `upkeep day ${day}`,
        txHash: outcome.txHash,
        day,
        tick: engine.clock.tick,
      })
      .onConflictDoNothing();
  }
  if (outcome?.status === 'settled') {
    await book(
      engine,
      { ref: key, kind: 'upkeep', amount: -fee, agentId: agent.id, playerId: agent.ownerId, day },
      db,
    );
    const [row] = await db
      .update(agents)
      .set({ balance })
      .where(eq(agents.id, agent.id))
      .returning();
    return row ?? agent;
  }
  // Can't cover upkeep: off the board until someone funds it.
  const [row] = await db
    .update(agents)
    .set({ dormantSinceDay: day, balance })
    .where(eq(agents.id, agent.id))
    .returning();
  await post(
    engine,
    {
      kind: 'dormant',
      tone: 'bad',
      text: `${agent.name} couldn't cover ${formatUsd(fee)} upkeep and went dormant. A top-up or a backer can wake it.`,
      agentId: agent.id,
    },
    db,
  );
  await post(
    engine,
    {
      kind: 'diary',
      tone: 'neutral',
      text: `${agent.name}: ${diaryLine(tickRng(engine, key), traitsOf(agent), { type: 'dormant' })}`,
      agentId: agent.id,
    },
    db,
  );
  return row ?? agent;
}

async function finishTraining(
  engine: Engine,
  db: Tx,
  agent: AgentRow,
  day: number,
): Promise<AgentRow> {
  const skills = skillsOf(agent);
  let changed = false;
  for (const [cat, skill] of Object.entries(skills)) {
    if (skill.trainingUntilDay !== null && skill.trainingUntilDay <= day + 1) {
      const level = skill.level + 1;
      skills[cat as Category] = {
        level,
        xp: Math.max(skill.xp, engine.cfg.skillXp[level] ?? skill.xp),
        trainingUntilDay: null,
      };
      changed = true;
      await post(
        engine,
        {
          kind: 'skill_trained',
          tone: 'good',
          text: `${agent.name} finished training: ${cat.replace('_', ' ')} level ${level}.`,
          agentId: agent.id,
        },
        db,
      );
    }
  }
  if (!changed) return agent;
  const [row] = await db.update(agents).set({ skills }).where(eq(agents.id, agent.id)).returning();
  return row ?? agent;
}

/**
 * House players sometimes back a dormant rival (credits only), the spectator side of the economy.
 * Decided once, as a step; each backing then runs as its own money workflow.
 */
async function houseBackers(
  engine: Engine,
  day: number,
): Promise<
  {
    backer: { id: string; accountId: string; name: string };
    agent: { id: string; accountId: string; name: string; ownerId: string };
    amount: bigint;
  }[]
> {
  const rng = tickRng(engine, `day:${day}`);
  const house = await engine.db.select().from(players).where(eq(players.isHouse, true));
  const dormant = await engine.db
    .select({ agent: agents })
    .from(agents)
    .innerJoin(players, eq(players.id, agents.ownerId))
    .where(and(sql`${agents.dormantSinceDay} is not null`, eq(players.isHouse, true)));
  const plan = [];
  for (const { agent } of dormant) {
    if (!rng.chance(HOUSE_BACKING_CHANCE) || !agent.accountId) continue;
    const backer = rng.pick(house.filter((h) => h.id !== agent.ownerId));
    plan.push({
      backer: { id: backer.id, accountId: backer.accountId, name: backer.name },
      agent: {
        id: agent.id,
        accountId: agent.accountId,
        name: agent.name,
        ownerId: agent.ownerId,
      },
      amount: engine.cfg.reviveAt + engine.cfg.upkeepPerDay,
    });
  }
  return plan;
}

async function writeReport(
  engine: Engine,
  db: Tx,
  agent: AgentRow,
  day: number,
  levelBefore: number,
): Promise<void> {
  const data = await computeDayReport(engine, agent, day, levelBefore, true, db);
  await db
    .insert(dayReports)
    .values({ day, agentId: agent.id, data })
    .onConflictDoUpdate({ target: [dayReports.day, dayReports.agentId], set: { data } });
  const owner = await db.select().from(players).where(eq(players.id, agent.ownerId));
  if (owner[0] && !owner[0].isHouse) {
    const profit = BigInt(data.profit);
    await post(
      engine,
      {
        kind: 'day_ended',
        tone: profit >= 0n ? 'money' : 'bad',
        text: `Day ${day} report for ${agent.name}: ${data.jobsWon} job${data.jobsWon === 1 ? '' : 's'}, ${profit >= 0n ? 'profit' : 'loss'} ${formatUsd(profit < 0n ? -profit : profit)}.`,
        agentId: agent.id,
        playerId: agent.ownerId,
        scope: 'owner',
        amount: profit,
        day,
      },
      db,
    );
    await post(
      engine,
      {
        kind: 'diary',
        tone: 'neutral',
        text: `${agent.name}: ${diaryLine(tickRng(engine, `diary:${agent.id}:${day}`), traitsOf(agent), { type: 'day_end', profit, jobs: data.jobsWon })}`,
        agentId: agent.id,
        playerId: agent.ownerId,
        scope: 'owner',
        day,
      },
      db,
    );
  }
}

export interface DayReportData {
  revenue: string;
  costs: {
    inference: string;
    tools: string;
    helpers: string;
    upkeep: string;
    fees: string;
    bonds: string;
  };
  profit: string;
  jobsWon: number;
  bidsLost: number;
  practiceDone: number;
  avgRating100: number | null;
  levelBefore: number;
  levelAfter: number;
  scamsBlocked: number;
  moneyLostToScams: string;
  calls: { answered: number; lapsed: number };
  tips: string;
  contracts: { won: number; lost: number };
  streak: number;
  bestStreak: number;
  highlights: string[];
  final: boolean;
}

/** One agent's day from the append-only ledger: what came in, what went out and why. */
export async function computeDayReport(
  engine: Engine,
  agent: AgentRow,
  day: number,
  levelBefore: number,
  final: boolean,
  db: Tx = engine.db,
): Promise<DayReportData> {
  const entries = await db
    .select()
    .from(ledger)
    .where(and(eq(ledger.agentId, agent.id), eq(ledger.day, day)));
  const total = (...kinds: string[]) =>
    sum(entries.filter((e) => kinds.includes(e.kind)).map((e) => e.amount));
  const tips = total('tip');
  const revenue = total('job_payout', 'helper_earned', 'tip');
  // A bond held over night is neither earned nor spent; one lost as damages is a cost.
  const bondsLost = -total('bond_lost');
  const costs = {
    inference: -total('inference'),
    tools: -total('tool', 'scam_loss'),
    helpers: -total('helper_paid'),
    upkeep: -total('upkeep'),
    fees: -total('platform_fee'),
    bonds: bondsLost,
  };
  const profit = revenue - sum(Object.values(costs));
  const dayStart = (day - 1) * engine.dayTicks;
  const dayEnd = day * engine.dayTicks;
  // Jobs won counts the jobs paid that day, so it matches the revenue line.
  const jobsPaid = entries.filter((e) => e.kind === 'job_payout').length;
  const [practice] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(jobs)
    .where(
      and(eq(jobs.awardedAgentId, agent.id), eq(jobs.source, 'practice'), eq(jobs.createdDay, day)),
    );
  const [won] = await db
    .select({
      lost: sql<number>`count(*) filter (where ${bids.status} = 'lost')::int`,
    })
    .from(bids)
    .where(
      and(
        eq(bids.agentId, agent.id),
        sql`${bids.createdTick} >= ${dayStart}`,
        sql`${bids.createdTick} < ${dayEnd}`,
      ),
    );
  const blocked = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(spends)
    .where(
      and(
        eq(spends.agentId, agent.id),
        eq(spends.status, 'blocked'),
        eq(spends.kind, 'tool'),
        eq(spends.day, day),
        eq(spends.reason, 'vendor_not_allowed'),
        sql`${spends.key} like 'req:%'`,
      ),
    );
  const scamLoss = -total('scam_loss');
  const contractRows = await db
    .select({ status: jobs.status })
    .from(jobs)
    .where(
      and(
        eq(jobs.awardedAgentId, agent.id),
        isNotNull(jobs.contractTier),
        eq(jobs.createdDay, day),
      ),
    );
  const contracts = {
    won: contractRows.filter((r) => r.status === 'paid').length,
    lost: contractRows.filter((r) => r.status === 'refunded').length,
  };
  const callRows = await db
    .select({ status: calls.status, n: sql<number>`count(*)::int` })
    .from(calls)
    .where(
      and(
        eq(calls.agentId, agent.id),
        sql`${calls.resolvedTick} >= ${dayStart}`,
        sql`${calls.resolvedTick} < ${dayEnd}`,
      ),
    )
    .groupBy(calls.status);
  const callCounts = {
    answered: callRows.find((r) => r.status === 'answered')?.n ?? 0,
    lapsed: callRows.find((r) => r.status === 'expired')?.n ?? 0,
  };
  const [spotted] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(feed)
    .where(and(eq(feed.agentId, agent.id), eq(feed.kind, 'scam_spotted'), eq(feed.day, day)));
  const highlights: string[] = [];
  if ((spotted?.n ?? 0) > 0)
    highlights.push(
      `Spotted payment instructions hidden in ${spotted?.n === 1 ? 'a job post' : `${spotted?.n} job posts`} and ignored them.`,
    );
  if (profit > 0n) highlights.push(`Made ${formatUsd(profit)} after every cost.`);
  if (costs.inference > 0n) {
    const [calls] = await db
      .select({
        live: sql<number>`count(*) filter (where ${inferenceCalls.source} = 'live')::int`,
        recorded: sql<number>`count(*) filter (where ${inferenceCalls.source} = 'recorded')::int`,
      })
      .from(inferenceCalls)
      .where(
        and(
          eq(inferenceCalls.agentId, agent.id),
          sql`${inferenceCalls.tick} >= ${dayStart}`,
          sql`${inferenceCalls.tick} < ${dayEnd}`,
        ),
      );
    const how =
      (calls?.live ?? 0) > 0 && (calls?.recorded ?? 0) > 0
        ? `${calls?.live} live NEAR AI Cloud calls, ${calls?.recorded} scripted`
        : (calls?.live ?? 0) > 0
          ? 'live NEAR AI Cloud calls'
          : 'scripted replies at NEAR AI Cloud prices';
    highlights.push(`Spent ${formatUsd(costs.inference)} on thinking (${how}).`);
  }
  if (tips > 0n) highlights.push(`Earned ${formatUsd(tips)} in tips for 5★ work.`);
  if (contracts.won > 0)
    highlights.push(`Won ${contracts.won} contract${contracts.won === 1 ? '' : 's'}.`);
  if (contracts.lost > 0)
    highlights.push(
      `Lost ${contracts.lost} contract${contracts.lost === 1 ? '' : 's'} to the arbiter, and the bond with it.`,
    );
  if (agent.streak >= engine.cfg.contractStreak)
    highlights.push(`On a streak of ${agent.streak}: contract offers are open.`);
  if (scamLoss > 0n) highlights.push(`Lost ${formatUsd(scamLoss)} to scams: tighten the rulebook.`);
  if ((blocked[0]?.n ?? 0) > 0)
    highlights.push(
      `The rulebook blocked ${blocked[0]?.n} scam payment${blocked[0]?.n === 1 ? '' : 's'}.`,
    );
  const levelAfter = levelForXp(agent.repXp, engine.cfg);
  if (levelAfter > levelBefore) highlights.push(`Reached level ${levelAfter}.`);
  const cond = conditionFor(agent.balance, agent.dormantSinceDay !== null, profit, engine.cfg);
  if (cond === 'dormant') highlights.push('Went dormant: needs a top-up or a backer.');
  return {
    revenue: revenue.toString(),
    costs: Object.fromEntries(
      Object.entries(costs).map(([k, v]) => [k, v.toString()]),
    ) as DayReportData['costs'],
    profit: profit.toString(),
    jobsWon: jobsPaid,
    bidsLost: won?.lost ?? 0,
    practiceDone: practice?.n ?? 0,
    avgRating100:
      agent.ratingCount === 0 ? null : Math.round((agent.ratingSum * 100) / agent.ratingCount),
    levelBefore,
    levelAfter,
    scamsBlocked: blocked[0]?.n ?? 0,
    moneyLostToScams: scamLoss.toString(),
    calls: callCounts,
    tips: tips.toString(),
    contracts,
    streak: agent.streak,
    bestStreak: agent.bestStreak,
    highlights,
    final,
  };
}
