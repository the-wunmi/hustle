import { nearaiBudget } from '@hustle/db';
import { and, eq, sql } from 'drizzle-orm';
import type { Engine } from '../context.ts';

/**
 * The org-wide guard on live NEAR AI spend (`NEARAI_DAILY_BUDGET_USD`, default $1.00 a UTC day).
 * Before a live call its worst case (estimated input plus `max_tokens` of output at the model's
 * price) is reserved; after it, the reservation is settled to the exact cost `/v1/billing/costs`
 * reports. A reservation that would take spent plus reserved past the budget is refused, so even
 * concurrent calls can't overshoot it, and the agent uses the recorded brain instead until the
 * next UTC day (a new row is the midnight reset). Kept in Postgres, so a restart doesn't forget.
 */

export const DEFAULT_DAILY_BUDGET_USD = '1.00';

/** Dollars as a decimal string to nano-USD, without floats. */
export function usdToNano(usd: string): bigint {
  const [whole = '0', frac = ''] = usd.trim().split('.');
  if (!/^\d+$/.test(whole) || !/^\d*$/.test(frac))
    throw new Error(`NEARAI_DAILY_BUDGET_USD must be a dollar amount, like 1.00 (got "${usd}")`);
  return BigInt(whole) * 1_000_000_000n + BigInt(frac.padEnd(9, '0').slice(0, 9));
}

export const utcDay = (now = new Date()): string => now.toISOString().slice(0, 10);

/**
 * Share of the daily budget tool calls may use (spent and reserved), so searches can't starve the
 * agents' ordinary thinking.
 */
export const TOOL_BUDGET_SHARE_BPS = 5_000n;

/** Left over below this, the day counts as spent: even a small call wouldn't fit. */
const SMALL_CALL_NANO = 2_000_000n; // $0.002

/**
 * Holds `worstNano` of today's budget for one call, within `limitNano` (the whole budget, or the
 * tools' share). Null if it won't fit; the day is marked spent only when not even a small call would.
 */
export async function reserveLive(
  engine: Engine,
  worstNano: bigint,
  limitNano: bigint = engine.liveAiBudgetNano,
): Promise<string | null> {
  const day = utcDay();
  await engine.db.insert(nearaiBudget).values({ day }).onConflictDoNothing();
  const [held] = await engine.db
    .update(nearaiBudget)
    .set({
      reservedNano: sql`${nearaiBudget.reservedNano} + ${worstNano}`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(nearaiBudget.day, day),
        eq(nearaiBudget.exhausted, false),
        sql`${nearaiBudget.spentNano} + ${nearaiBudget.reservedNano} + ${worstNano} <= ${limitNano}`,
      ),
    )
    .returning({ day: nearaiBudget.day });
  if (held) return held.day;
  await engine.db
    .update(nearaiBudget)
    .set({ exhausted: true, updatedAt: new Date() })
    .where(
      and(
        eq(nearaiBudget.day, day),
        sql`${nearaiBudget.spentNano} + ${nearaiBudget.reservedNano} + ${SMALL_CALL_NANO} > ${engine.liveAiBudgetNano}`,
      ),
    );
  return null;
}

/** The tools' share of today's budget, in nano-USD. */
export const toolBudgetNano = (engine: Engine): bigint =>
  (engine.liveAiBudgetNano * TOOL_BUDGET_SHARE_BPS) / 10_000n;

/**
 * Whether a tool call can still be paid for today: the day isn't spent and the tools' share has room
 * for one more typical call. Read once a tick into `engine.toolsOpen`.
 */
export async function toolsOpenToday(engine: Engine, typicalNano: bigint): Promise<boolean> {
  const [row] = await engine.db.select().from(nearaiBudget).where(eq(nearaiBudget.day, utcDay()));
  if (!row) return toolBudgetNano(engine) >= typicalNano;
  return !row.exhausted && row.spentNano + row.reservedNano + typicalNano <= toolBudgetNano(engine);
}

/** Turns a reservation into the call's real cost (the billed amount, or the reserved worst case). */
export async function settleLive(
  engine: Engine,
  day: string,
  worstNano: bigint,
  actualNano: bigint,
): Promise<void> {
  await engine.db
    .update(nearaiBudget)
    .set({
      spentNano: sql`${nearaiBudget.spentNano} + ${actualNano}`,
      reservedNano: sql`greatest(${nearaiBudget.reservedNano} - ${worstNano}, 0)`,
      calls: sql`${nearaiBudget.calls} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(nearaiBudget.day, day));
}

export interface LiveAiBudget {
  day: string;
  budgetNano: bigint;
  spentNano: bigint;
  calls: number;
  /** Today's budget turned a call away: player agents are on the recorded brain until midnight UTC. */
  reached: boolean;
}

export async function liveAiBudget(engine: Engine): Promise<LiveAiBudget> {
  const day = utcDay();
  const [row] = await engine.db.select().from(nearaiBudget).where(eq(nearaiBudget.day, day));
  return {
    day,
    budgetNano: engine.liveAiBudgetNano,
    spentNano: row?.spentNano ?? 0n,
    calls: row?.calls ?? 0,
    reached: row?.exhausted ?? false,
  };
}
