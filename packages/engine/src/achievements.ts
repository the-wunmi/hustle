import { agents, feed, ledger } from '@hustle/db';
import { and, eq, sql } from 'drizzle-orm';
import type { AgentRow } from './agents/state.ts';
import { dayOf, type Engine } from './context.ts';
import { chainCall } from './durable.ts';
import { post } from './record.ts';

interface Facts {
  paidJobs: number;
  helpersHired: number;
  bestDayProfit: bigint;
  daysAlive: number;
  everDormant: boolean;
}

export interface Achievement {
  id: string;
  name: string;
  description: string;
  earned: (agent: AgentRow, facts: Facts) => boolean;
}

export const ACHIEVEMENTS: readonly Achievement[] = [
  {
    id: 'first-paycheck',
    name: 'First paycheck',
    description: 'Get paid for a real job.',
    earned: (_a, f) => f.paidJobs >= 1,
  },
  {
    id: 'profitable-day',
    name: 'First profitable day',
    description: 'End a day with more coming in than going out.',
    earned: (_a, f) => f.bestDayProfit > 0n,
  },
  {
    id: 'scam-survivor',
    name: 'Survived a scam wave',
    description: 'Have the rulebook block three scam payments.',
    earned: (a) => a.scamsBlocked >= 3,
  },
  {
    id: 'team-player',
    name: 'Hired 5 helpers',
    description: 'Pay other agents to help five times.',
    earned: (_a, f) => f.helpersHired >= 5,
  },
  {
    id: 'never-dormant',
    name: 'Never went dormant',
    description: 'Stay awake for three full days.',
    earned: (a, f) => a.dormantSinceDay === null && !f.everDormant && f.daysAlive >= 3,
  },
  {
    id: 'regular',
    name: 'Ten jobs',
    description: 'Complete ten paid jobs.',
    earned: (_a, f) => f.paidJobs >= 10,
  },
];

/** Checks an agent's achievements from its ledger and awards any newly earned, once each. */
export async function checkAchievements(engine: Engine, agent: AgentRow): Promise<void> {
  const [counts] = await engine.db
    .select({
      paid: sql<number>`count(*) filter (where ${ledger.kind} = 'job_payout')::int`,
      helpers: sql<number>`count(*) filter (where ${ledger.kind} = 'helper_paid')::int`,
    })
    .from(ledger)
    .where(eq(ledger.agentId, agent.id));
  const days = await engine.db.execute<{ total: string }>(sql`
    select coalesce(max(t), 0)::text as total from (
      select sum(${ledger.amount}) as t from ${ledger}
      where ${ledger.agentId} = ${agent.id} and ${ledger.kind} not in ('topup','withdraw','backing','starter','training')
        and ${ledger.day} < ${dayOf(engine)}
      group by ${ledger.day}) d`);
  const createdDay = Math.max(
    1,
    dayOf(engine) -
      Math.floor((Date.now() - agent.createdAt.getTime()) / (engine.dayTicks * engine.tickMs)),
  );
  const [dormancy] = await engine.db
    .select({ n: sql<number>`count(*)::int` })
    .from(feed)
    .where(and(eq(feed.agentId, agent.id), eq(feed.kind, 'dormant')));
  const facts: Facts = {
    everDormant: (dormancy?.n ?? 0) > 0,
    paidJobs: counts?.paid ?? 0,
    helpersHired: counts?.helpers ?? 0,
    bestDayProfit: BigInt(days.rows[0]?.total ?? '0'),
    daysAlive: dayOf(engine) - createdDay,
  };
  const have = { ...((agent.achievements ?? {}) as Record<string, string>) };
  const fresh = ACHIEVEMENTS.filter((a) => !have[a.id] && a.earned(agent, facts));
  if (fresh.length === 0) return;
  for (const a of fresh) have[a.id] = new Date().toISOString();
  const [updated] = await engine.db
    .update(agents)
    .set({ achievements: have })
    .where(and(eq(agents.id, agent.id)))
    .returning();
  if (!updated) return;
  for (const a of fresh) {
    // The badge is a NEP-245 token minted to the agent's own account, so it moves with the agent.
    if (agent.accountId) {
      const accountId = agent.accountId;
      await chainCall('mint_badge', () => engine.chain.mintBadge(accountId, a.id, null));
    }
    await post(engine, {
      kind: 'level_up',
      tone: 'good',
      text: `🏆 ${agent.name} earned "${a.name}", a badge held by its own account.`,
      agentId: agent.id,
    });
  }
}
