import { spends } from '@hustle/db';
import { eq } from 'drizzle-orm';
import { type AgentRow, refreshAccount, refreshBalance } from '../agents/state.ts';
import { dayOf, type Engine } from '../context.ts';
import type { JobRow } from './jobs.ts';

/** Spends from the agent wallet through the contract and records the outcome. */
export async function pay(
  engine: Engine,
  agent: AgentRow,
  job: JobRow,
  key: string,
  kind: 'tool' | 'helper' | 'inference',
  receiver: string,
  amount: bigint,
  memo: string,
) {
  const outcome = await engine.chain.spend(agent.accountId ?? '', {
    key,
    kind,
    receiverId: receiver,
    amount,
    jobId: job.id,
    memo,
    receipt: null,
  });
  const [row] = await engine.db
    .insert(spends)
    .values({
      key,
      agentId: agent.id,
      jobId: job.id,
      kind,
      receiver,
      amount,
      status: outcome.status,
      reason: outcome.reason,
      requestId: outcome.requestId,
      memo,
      txHash: outcome.txHash,
      day: dayOf(engine),
      tick: engine.clock.tick,
    })
    .onConflictDoNothing()
    .returning();
  // A retried request returns the wallet's stored outcome in a new transaction; the payment itself
  // is the first one, which is the hash we kept.
  const [first] = row ? [row] : await engine.db.select().from(spends).where(eq(spends.key, key));
  // The cache follows the chain on both sides of every payment (the receiver may be a helper agent).
  await refreshBalance(engine, agent);
  await refreshAccount(engine, receiver);
  return {
    outcome,
    spendId: first?.id ?? null,
    paidTx: first?.txHash ?? outcome.txHash,
    fresh: row !== undefined,
  };
}
