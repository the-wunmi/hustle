import { createHash } from 'node:crypto';
import type { FeedKind, FeedTone } from '@hustle/core';
import { feed, ledger, type Tx } from '@hustle/db';
import { dayOf, type Engine } from './context.ts';

// ── Feed ────────────────────────────────────────────────────────────────────────────────────────

export interface FeedInput {
  kind: FeedKind;
  tone: FeedTone;
  text: string;
  agentId?: string | null;
  jobId?: string | null;
  /** The owner who should see an owner-scoped event. */
  playerId?: string | null;
  amount?: bigint | null;
  scope?: 'public' | 'owner';
  /** The game day the event belongs to, when it isn't today (a report on a day that just closed). */
  day?: number;
}

/** Appends a feed event and wakes the live streams. */
export async function post(engine: Engine, input: FeedInput, db: Tx = engine.db): Promise<void> {
  await db.insert(feed).values({
    day: input.day ?? dayOf(engine),
    tick: engine.clock.tick,
    kind: input.kind,
    tone: input.tone,
    text: input.text,
    agentId: input.agentId ?? null,
    jobId: input.jobId ?? null,
    playerId: input.playerId ?? null,
    amount: input.amount ?? null,
    scope: input.scope ?? 'public',
  });
  engine.bus.emit('feed');
}

// ── Ledger ──────────────────────────────────────────────────────────────────────────────────────

export type LedgerKind =
  | 'job_payout'
  | 'platform_fee'
  | 'inference'
  | 'tool'
  | 'helper_paid'
  | 'helper_earned'
  | 'upkeep'
  | 'scam_loss'
  | 'topup'
  | 'withdraw'
  | 'backing'
  | 'starter'
  | 'allowance'
  | 'training'
  | 'deposit'
  /** A client's 5★ tip on top of the price. */
  | 'tip'
  /** A contract bond held by the treasury: out when taken, back when the contract closes. Neutral. */
  | 'bond'
  /** A bond paid to the client as damages after a refund: the real cost. */
  | 'bond_lost'
  /** A player's wallet buying or selling an agent on the marketplace (no agent's own books). */
  | 'agent_purchase'
  | 'agent_sale'
  /** The creator's share of a resale: out of the seller's proceeds, into the creator's wallet. */
  | 'royalty';

export interface LedgerInput {
  /** Makes the entry happen once: a retried step can't double-count. */
  ref: string;
  kind: LedgerKind;
  amount: bigint;
  agentId?: string | null;
  playerId?: string | null;
  jobId?: string | null;
  related?: boolean;
  /** The game day it belongs to, when it isn't today (upkeep charged as a day closes). */
  day?: number;
}

export async function book(engine: Engine, entry: LedgerInput, db: Tx = engine.db): Promise<void> {
  await db
    .insert(ledger)
    .values({
      ref: entry.ref,
      day: entry.day ?? dayOf(engine),
      kind: entry.kind,
      amount: entry.amount,
      agentId: entry.agentId ?? null,
      playerId: entry.playerId ?? null,
      jobId: entry.jobId ?? null,
      related: entry.related ?? false,
    })
    .onConflictDoNothing({ target: ledger.ref });
}

// ── Chain keys ──────────────────────────────────────────────────────────────────────────────────

/** Wallet request keys are at most 64 characters, so long natural keys are hashed to a fixed size. */
const MAX_CHAIN_KEY = 64;

/** A deterministic chain key: `prefix:` plus the natural key, hashed when it would be too long. */
export function chainKey(prefix: string, natural: string): string {
  const plain = `${prefix}:${natural}`;
  if (plain.length <= MAX_CHAIN_KEY) return plain;
  const digest = createHash('sha256').update(natural).digest('base64url').slice(0, 40);
  return `${prefix}:${digest}`;
}
