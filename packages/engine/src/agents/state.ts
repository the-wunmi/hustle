import type { AgentLook, Category, Rulebook, Strategy, Tier, Trait } from '@hustle/core';
import { agents, type Tx } from '@hustle/db';
import { type AgentSnapshot, levelForXp } from '@hustle/economy';
import { eq, isNotNull } from 'drizzle-orm';
import type { Engine } from '../context.ts';

export type AgentRow = typeof agents.$inferSelect;

export interface SkillState {
  level: number;
  xp: number;
  trainingUntilDay: number | null;
}
export type Skills = Record<Category, SkillState>;

/** Rulebook amounts are stored as strings in jsonb; this is the one place they come back as bigint. */
export function rulebookOf(row: AgentRow): Rulebook {
  const r = row.rulebook as Record<string, unknown>;
  return {
    dailyCap: BigInt(r.dailyCap as string),
    maxPerJob: BigInt(r.maxPerJob as string),
    maxPerCall: BigInt(r.maxPerCall as string),
    allowedVendors: r.allowedVendors as string[],
    anyVendor: r.anyVendor as boolean,
    mayHire: r.mayHire as boolean,
    helperBudget: BigInt(r.helperBudget as string),
  };
}

export const storedRulebook = (r: Rulebook): Record<string, unknown> => ({
  ...r,
  dailyCap: r.dailyCap.toString(),
  maxPerJob: r.maxPerJob.toString(),
  maxPerCall: r.maxPerCall.toString(),
  helperBudget: r.helperBudget.toString(),
});

export const strategyOf = (row: AgentRow): Strategy => row.strategy as Strategy;
export const skillsOf = (row: AgentRow): Skills => row.skills as Skills;
export const traitsOf = (row: AgentRow): Trait[] => row.traits as Trait[];
export const lookOf = (row: AgentRow): AgentLook => row.look as AgentLook;
export const tierOf = (row: AgentRow): Tier => strategyOf(row).tier;
export const levelOf = (engine: Engine, row: AgentRow): number => levelForXp(row.repXp, engine.cfg);
export const avgRating100 = (row: AgentRow): number | null =>
  row.ratingCount === 0 ? null : Math.round((row.ratingSum * 100) / row.ratingCount);

export function snapshotOf(row: AgentRow): AgentSnapshot {
  const skills = skillsOf(row);
  return {
    id: row.id,
    ownerId: row.ownerId,
    traits: traitsOf(row),
    specialty: row.specialty as Category,
    skills: Object.fromEntries(
      Object.entries(skills).map(([k, v]) => [k, { level: v.level, xp: v.xp }]),
    ) as AgentSnapshot['skills'],
    strategy: strategyOf(row),
    rulebook: rulebookOf(row),
    balance: row.balance,
    repXp: row.repXp,
    avgRating100: avgRating100(row),
    dormant: row.dormantSinceDay !== null,
    busy: row.busyJobId !== null,
  };
}

/** Re-reads the agent's balance from the chain, the source of truth, into the cache column. */
export async function refreshBalance(
  engine: Engine,
  row: AgentRow,
  db: Tx = engine.db,
): Promise<AgentRow> {
  if (!row.accountId) return row;
  const balance = await engine.chain.ftBalance(row.accountId);
  const [updated] = await db
    .update(agents)
    .set({ balance })
    .where(eq(agents.id, row.id))
    .returning();
  return updated ?? row;
}

export async function loadAgent(engine: Engine, id: string): Promise<AgentRow | null> {
  const [row] = await engine.db.select().from(agents).where(eq(agents.id, id));
  return row ?? null;
}

/** Refreshes the cached balance of whichever agent owns `accountId`, if any (e.g. a paid helper). */
export async function refreshAccount(engine: Engine, accountId: string): Promise<void> {
  const [row] = await engine.db.select().from(agents).where(eq(agents.accountId, accountId));
  if (row) await refreshBalance(engine, row);
}

/** Re-reads every agent's balance from the chain (in parallel), so the cache matches after a tick. */
export async function refreshAllBalances(engine: Engine): Promise<void> {
  const rows = await engine.db.select().from(agents).where(isNotNull(agents.accountId));
  await Promise.all(rows.map((row) => refreshBalance(engine, row)));
}
