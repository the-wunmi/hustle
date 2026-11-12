import type { ChainTxView } from '@hustle/core';
import { type Db, simTxs } from '@hustle/db';
import { and, desc, eq, ne, sql } from 'drizzle-orm';
import type { PendingTx, SettledTx, TxFilter, TxLog } from './types.ts';

type Row = typeof simTxs.$inferSelect;

/** One explorer row, showing the real block height when the transaction came from a NEAR node. */
export function txView(row: Row): ChainTxView & { tick: number | null } {
  return {
    hash: row.hash,
    signer: row.signer,
    receiver: row.receiver,
    method: row.method,
    args: row.args,
    // Callers never see pending rows (they are filtered out of every query that returns views).
    outcome: row.outcome === 'pending' ? 'failure' : row.outcome,
    events: row.events as ChainTxView['events'],
    error: row.error,
    block: row.chainBlock ?? row.block,
    createdAt: row.createdAt.toISOString(),
    tick: row.tick,
  };
}

/** The explorer query both gateways share: by job id (args, key or events) and/or by account. */
export async function queryTxs(db: Db, filter: TxFilter): Promise<ChainTxView[]> {
  const conds = [];
  const matches = [];
  if (filter.jobId) {
    // Job ids appear as strings (simulator) or numbers (contract JSON), in args or in event data.
    const asNumber = /^\d+$/.test(filter.jobId) ? Number(filter.jobId) : null;
    const ids: (string | number)[] = asNumber === null ? [filter.jobId] : [filter.jobId, asNumber];
    for (const id of ids) {
      matches.push(sql`${simTxs.args} @> ${JSON.stringify({ job_id: id })}::jsonb`);
      matches.push(sql`${simTxs.events} @> ${JSON.stringify([{ data: { job_id: id } }])}::jsonb`);
    }
    matches.push(sql`${simTxs.key} like ${`%:${filter.jobId}`}`);
  }
  if (filter.gameJobId) {
    matches.push(
      sql`${simTxs.args} @> ${JSON.stringify({ request: { job_id: filter.gameJobId } })}::jsonb`,
    );
  }
  if (matches.length) conds.push(sql`(${sql.join(matches, sql` or `)})`);
  if (filter.account) {
    // Also transactions whose events name the account (a refund or payout sent to it).
    conds.push(
      sql`(${simTxs.signer} = ${filter.account} or ${simTxs.receiver} = ${filter.account} or ${simTxs.events}::text like ${`%"${filter.account}"%`})`,
    );
  }
  // Pending rows are notes for reconciliation, not transactions anyone can see on chain.
  conds.push(ne(simTxs.outcome, 'pending'));
  const rows = await db
    .select()
    .from(simTxs)
    .where(and(...conds))
    .orderBy(desc(simTxs.block))
    .limit(filter.limit);
  return rows.map(txView);
}

export async function findTxByKey(db: Db, key: string): Promise<ChainTxView | null> {
  return settledTxByKey(db, key);
}

/** The first successful transaction with this key, with the value it returned. */
export async function settledTxByKey(db: Db, key: string): Promise<SettledTx | null> {
  const [row] = await db
    .select()
    .from(simTxs)
    .where(and(eq(simTxs.key, key), eq(simTxs.outcome, 'success')))
    .orderBy(simTxs.block)
    .limit(1);
  // Stored wrapped (`{ value }`): a bare JSON string read back from jsonb would lose its quotes.
  return row ? { ...txView(row), result: (row.result as { value?: unknown } | null)?.value } : null;
}

/**
 * Postgres-backed transaction log for a gateway talking to a NEAR node. `currentTick` stamps each
 * transaction with the game tick so receipts can be shown in game time.
 */
export class PgTxLog implements TxLog {
  constructor(
    private readonly db: Db,
    private readonly currentTick: () => number,
  ) {}

  async record(tx: Parameters<TxLog['record']>[0]): Promise<void> {
    const result = {
      value: JSON.parse(
        JSON.stringify(tx.result ?? null, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
      ),
    };
    const outcome = {
      outcome: tx.outcome,
      result,
      events: tx.events,
      error: tx.error,
      timestampMs: tx.timestampMs,
      chainBlock: tx.chainBlock,
      signed: null,
    };
    // A keyed transaction was noted as pending under the same hash: its row becomes the record.
    await this.db
      .insert(simTxs)
      .values({
        hash: tx.hash,
        signer: tx.signer,
        receiver: tx.receiver,
        method: tx.method,
        args: (tx.args ?? {}) as Record<string, unknown>,
        key: tx.key,
        tick: this.currentTick(),
        ...outcome,
      })
      .onConflictDoUpdate({
        target: simTxs.hash,
        set: outcome,
        where: eq(simTxs.outcome, 'pending'),
      });
  }

  settledByKey(key: string): Promise<SettledTx | null> {
    return settledTxByKey(this.db, key);
  }

  async notePending(tx: PendingTx): Promise<void> {
    await this.db
      .insert(simTxs)
      .values({
        hash: tx.hash,
        signer: tx.signer,
        receiver: tx.receiver,
        method: tx.method,
        args: (tx.args ?? {}) as Record<string, unknown>,
        outcome: 'pending',
        result: null,
        events: [],
        error: null,
        key: tx.key,
        signed: tx.signed,
        timestampMs: Date.now(),
        chainBlock: null,
        tick: this.currentTick(),
      })
      .onConflictDoNothing();
  }

  async pendingByKey(key: string): Promise<PendingTx | null> {
    const [row] = await this.db
      .select()
      .from(simTxs)
      .where(and(eq(simTxs.key, key), eq(simTxs.outcome, 'pending')))
      .orderBy(desc(simTxs.block))
      .limit(1);
    if (!row?.signed) return null;
    return {
      key,
      hash: row.hash,
      signer: row.signer,
      receiver: row.receiver,
      method: row.method,
      args: row.args,
      signed: row.signed,
    };
  }

  async dropPending(hash: string): Promise<void> {
    await this.db.delete(simTxs).where(and(eq(simTxs.hash, hash), eq(simTxs.outcome, 'pending')));
  }

  txs(filter: TxFilter): Promise<ChainTxView[]> {
    return queryTxs(this.db, filter);
  }

  findByKey(key: string): Promise<ChainTxView | null> {
    return findTxByKey(this.db, key);
  }
}
