import { DomainError } from '@hustle/core';
import { dailyCaps } from '@hustle/db';
import { sql } from 'drizzle-orm';
import type { Engine } from './context.ts';

/** What a daily cap counts: new on-chain player accounts, and agent mints (each costs NEAR). */
export type DailyCapKind = 'accounts' | 'mints';

const utcDay = (now = new Date()) => now.toISOString().slice(0, 10);

/**
 * Takes one of today's slots for `kind`, or refuses when the day's cap is used up. Durable and
 * global (Postgres, one conditional upsert), so neither restarts nor many IPs get round it.
 */
export async function takeDailySlot(
  engine: Engine,
  kind: DailyCapKind | `parent:${string}`,
  limitFor: number = engine.dailyCaps[kind as DailyCapKind],
): Promise<void> {
  const limit = limitFor;
  if (!Number.isFinite(limit)) return;
  const day = utcDay();
  const rows = await engine.db
    .insert(dailyCaps)
    .values({ day, kind, count: 1 })
    .onConflictDoUpdate({
      target: [dailyCaps.day, dailyCaps.kind],
      set: { count: sql`${dailyCaps.count} + 1` },
      setWhere: sql`${dailyCaps.count} < ${limit}`,
    })
    .returning({ count: dailyCaps.count });
  if (rows.length === 0 || (rows[0]?.count ?? 0) > limit)
    throw new DomainError('rate_limited', 'The game is full for today; try again tomorrow.');
}

/**
 * New accounts a day for wallets under one parent account (`a1.attacker.testnet`,
 * `a2.attacker.testnet`, …): sub-accounts are nearly free to make, so one person's script can't use
 * up the day's global cap that way. Top-level `*.testnet` and implicit accounts aren't limited here.
 */
export const ACCOUNTS_PER_PARENT_PER_DAY = 3;

/** The parent of a named sub-account under a `.testnet` name, or null. */
export function walletParent(accountId: string): string | null {
  if (/^[0-9a-f]{64}$/.test(accountId)) return null;
  const parent = accountId.slice(accountId.indexOf('.') + 1);
  return parent === 'testnet' || !parent.endsWith('.testnet') ? null : parent;
}

let reserveLogged = false;

/**
 * Refuses actions that spend the game's NEAR (a new account, a mint) once the root or operator is
 * down to its reserve, so the world can keep running on what's left. Logged once per process.
 */
export async function assertNearReserve(engine: Engine): Promise<void> {
  const short = await engine.reserveCheck();
  if (!short) return;
  if (!reserveLogged) {
    reserveLogged = true;
    engine.log('NEAR reserve reached: refusing new accounts and agents', { short });
  }
  throw new DomainError(
    'unavailable',
    'The game is low on NEAR for new accounts and agents right now; try again later.',
  );
}
