import { createHash, randomBytes } from 'node:crypto';
import type { ChainTxView, Rulebook, SpendReason } from '@hustle/core';
import {
  type Db,
  simAccounts,
  simFt,
  simJobs,
  simListings,
  simNft,
  simReputation,
  simTxs,
  simWallets,
  type Tx,
} from '@hustle/db';
import { asc, count, eq, sql } from 'drizzle-orm';
import { findTxByKey, queryTxs, settledTxByKey } from './pg-txlog.ts';
import {
  type BadgeType,
  ChainError,
  type ChainGateway,
  type ChainIds,
  type ChainJob,
  type ChainSetup,
  type Listing,
  type PendingApproval,
  type Reputation,
  type SpendOutcome,
  type SpendRequest,
  type TxFilter,
  type TxResult,
  type WalletState,
} from './types.ts';
import {
  approvalDeposit,
  buyResult,
  fromStoredRequest,
  fromStoredRulebook,
  type StoredRequest,
  type StoredRulebook,
  toStoredRequest,
  toStoredRulebook,
} from './wire.ts';

export { fromStoredRulebook, toStoredRulebook };

// ── Limits mirrored from the contracts ──────────────────────────────────────────────────────────

/** Approval requests a wallet holds at once; the wallet pays their storage, so it's bounded. */
export const MAX_PENDING = 8;
/** Request keys a wallet remembers for idempotency. */
export const MAX_RECENT = 64;
/** Per-job spend entries a wallet keeps. */
export const MAX_JOB_SPEND = 16;
/** Smallest budget the job board escrows; smaller ones are refunded so nobody fills storage with dust. */
export const MIN_BUDGET = 100_000n;
/** Outcomes the reputation registry keeps per agent. */
export const MAX_RECENT_OUTCOMES = 20;
/** Largest money argument the contracts accept (one billion dollars); keeps sums far from overflow. */
const MAX_AMOUNT = 1_000_000_000_000_000n;
/** Largest single faucet mint (one million dollars), as the credits contract caps it. */
const MAX_MINT = 1_000_000_000_000n;
/** Vendors a rulebook may list, as the wallet bounds its state. */
const MAX_ALLOWED_VENDORS = 16;
/** Payments that may only go to the treasury and are blocked, never held, over a cap. */
const TREASURY_KINDS: ReadonlySet<string> = new Set(['inference', 'upkeep', 'bond']);
/** String caps the wallet and job board enforce (bytes; our ids and keys are ASCII). */
const MAX_JOB_ID_LEN = 64;
const MAX_MEMO_LEN = 128;
const MAX_RECEIPT_LEN = 128;
const MAX_JOB_KEY_LEN = 64;
/** The wallet's request-key cap: empty keys, and keys longer than this, are refused with `invalid_key`. */
const MAX_KEY_LEN = 64;
const MAX_HASH_LEN = 128;
/** Longest review window: seven days. */
const MAX_REVIEW_WINDOW_MS = 7 * 86_400_000;
/** Listings the market holds at once; it pays their storage from its own balance. */
export const MAX_LISTINGS = 500;
/** Highest listing price: 1,000 credits. */
export const MAX_LISTING_PRICE = 1_000_000_000n;
/** Highest platform fee the job board and the market accept: 20%. */
const MAX_FEE_BPS = 2000;
/** Delivery deadline after award when the post names none: one day. */
const DEFAULT_DELIVERY_WINDOW_MS = 86_400_000;
/** Shortest delivery deadline, so a client cannot award and reclaim in the same breath. */
const MIN_DELIVERY_WINDOW_MS = 60_000;
/** Longest delivery deadline: seven days, as long as a review window. */
const MAX_DELIVERY_WINDOW_MS = 7 * 86_400_000;

interface StoredWallet {
  owner_id: string;
  registry_id: string;
  operator_id: string;
  credits_id: string;
  treasury_id: string;
  rulebook: StoredRulebook;
  frozen: boolean;
  day_ms: number;
  day: number;
  spent_today: string;
  job_spend: [string, string][];
  pending: { id: number; request: StoredRequest; reason: SpendReason }[];
  recent: [string, StoredOutcome][];
  rotation_seq: number;
  next_request_id: number;
}

/** As the wallet stores it: a denial (by the owner or a change of owner) is final for the key. */
interface StoredOutcome {
  status: SpendOutcome['status'] | 'denied';
  request_id: number | null;
  reason: SpendReason | 'denied_by_owner' | 'owner_changed' | null;
}

interface StoredJob {
  job_id: string;
  client_id: string;
  budget: string;
  price: string | null;
  agent_id: string | null;
  status: ChainJob['status'];
  work_hash: string | null;
  auto_award: boolean;
  review_window_ms: number;
  delivered_at_ms: number | null;
  spec_hash: string;
  /** Absent in rows written before delivery deadlines existed; read as the default. */
  delivery_window_ms?: number;
  awarded_at_ms?: number | null;
}

/** How a job left the board, named as the job board names it. */
type Settlement = 'paid' | 'refunded' | 'cancelled' | 'reclaimed';

interface EscrowTransfer {
  receiver_id: string;
  amount: bigint;
  purpose: 'agent_payout' | 'fee' | 'refund';
}

interface StoredBadge {
  title: string;
  description: string;
  supply: number;
}

/** Most badge types the contract holds; its storage is bounded and paid from its own balance. */
const MAX_BADGE_TYPES = 64;
const MAX_BADGE_TITLE_LEN = 64;
const MAX_BADGE_DESCRIPTION_LEN = 256;
const BADGE_ID = /^[a-z0-9_-]{1,64}$/;

/** Reputation outcomes, named as the reputation contract names them. */
type RepOutcome = 'completed' | 'dispute_won' | 'dispute_lost' | 'scam_blocked';

interface StoredRep {
  jobs: number;
  rating_sum: number;
  /** Absent in rows written before dispute wins stopped carrying a rating. */
  rated_jobs?: number;
  disputes: number;
  scams_blocked: number;
  recent: { job_id: string; outcome: string; rating: number | null }[];
}

/** A direct sub-account of the registry: the only accounts it creates are agent wallets. */
function isAgentWallet(accountId: string, registryId: string): boolean {
  const label = accountId.endsWith(`.${registryId}`)
    ? accountId.slice(0, -registryId.length - 1)
    : '';
  return label.length > 0 && !label.includes('.');
}

function assertValidRulebook(r: StoredRulebook): void {
  require_(r.allowed_vendors.length <= MAX_ALLOWED_VENDORS, 'too_many_vendors');
  require_(new Set(r.allowed_vendors).size === r.allowed_vendors.length, 'duplicate_vendor');
  for (const cap of [r.daily_cap, r.max_per_job, r.max_per_call, r.helper_budget]) {
    require_(BigInt(cap) <= MAX_AMOUNT, 'amount_too_large');
  }
}

function assertValidRequest(r: SpendRequest): void {
  require_(r.key.length > 0 && r.key.length <= MAX_KEY_LEN, 'invalid_key');
  require_(r.amount > 0n && r.amount <= MAX_AMOUNT, 'invalid_amount');
  require_(r.memo.length <= MAX_MEMO_LEN, 'memo_too_long');
  if (r.jobId !== null) {
    require_(r.jobId.length > 0 && r.jobId.length <= MAX_JOB_ID_LEN, 'invalid_job_id');
  }
  if (r.receipt !== null) require_(r.receipt.length <= MAX_RECEIPT_LEN, 'receipt_too_long');
}

/** A panic inside a simulated contract method: the state change rolls back, the tx is logged failed. */
class Panic extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const require_ = (cond: boolean, code: string): void => {
  if (!cond) throw new Panic(code);
};

interface CallContext {
  tx: Tx;
  signer: string;
  events: { event: string; data: unknown }[];
  nowMs: number;
}

const ONE_YOCTO = 1;

/**
 * The contracts, played by Postgres (CHAIN_MODE=sim). Each method mirrors the Rust contract of the
 * same name: who may call it, the checks and their order, reason codes, events and storage bounds.
 * Calls are atomic here; on a real chain cross-contract steps are asynchronous receipts, which the
 * sandbox mode exercises against the compiled contracts.
 */
export class SimChain implements ChainGateway {
  readonly mode = 'sim' as const;
  readonly ids: ChainIds;

  constructor(
    private readonly db: Db,
    /** Block time on the game clock, in milliseconds. */
    private readonly now: () => number,
    root = 'hustle.sim',
    /** The game tick, stamped on each logged transaction for timelines in game time. */
    private readonly currentTick?: () => number,
  ) {
    this.ids = {
      root,
      credits: `credits.${root}`,
      registry: `agents.${root}`,
      jobs: `jobs.${root}`,
      rep: `rep.${root}`,
      operator: `orchestrator.${root}`,
      treasury: `treasury.${root}`,
      vendors: `vendors.${root}`,
      badges: `badges.${root}`,
      market: `market.${root}`,
    };
  }

  // ── Transaction runner ────────────────────────────────────────────────────────────────────────

  private async call<T>(
    signer: string,
    receiver: string,
    method: string,
    args: Record<string, unknown>,
    deposit: number | bigint,
    key: string | null,
    body: (ctx: CallContext) => Promise<T>,
  ): Promise<TxResult<T>> {
    // Once per key, as the NEAR gateway does: a repeated key whose call succeeded returns that
    // call's result and changes nothing. A wallet spend is the exception: the wallet itself keeps
    // its keys, and a held payment's outcome changes after the first call.
    if (key !== null && method !== 'spend') {
      const prior = await settledTxByKey(this.db, key);
      if (prior) return { txHash: prior.hash, value: (prior.result ?? undefined) as T };
    }
    const hash = createHash('sha256')
      .update(`${signer}:${receiver}:${method}:${randomBytes(16).toString('hex')}`)
      .digest('base64url')
      .slice(0, 43);
    const nowMs = this.now();
    const jsonArgs = JSON.parse(
      JSON.stringify({ ...args, attached_deposit: deposit }, (_k, v) =>
        typeof v === 'bigint' ? v.toString() : v,
      ),
    ) as Record<string, unknown>;
    try {
      return await this.db.transaction(async (tx) => {
        const ctx: CallContext = { tx, signer, events: [], nowMs };
        const value = await body(ctx);
        await tx.insert(simTxs).values({
          hash,
          signer,
          receiver,
          method,
          args: jsonArgs,
          outcome: 'success',
          result: {
            value: JSON.parse(
              JSON.stringify(value ?? null, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
            ),
          },
          events: ctx.events,
          error: null,
          key,
          timestampMs: nowMs,
          tick: this.currentTick?.() ?? null,
        });
        return { txHash: hash, value };
      });
    } catch (err) {
      if (!(err instanceof Panic)) throw err;
      await this.db.insert(simTxs).values({
        hash,
        signer,
        receiver,
        method,
        args: jsonArgs,
        outcome: 'failure',
        result: null,
        events: [],
        error: err.code,
        key,
        timestampMs: nowMs,
        tick: this.currentTick?.() ?? null,
      });
      throw new ChainError(err.code, hash);
    }
  }

  private emit(ctx: CallContext, event: string, data: Record<string, unknown>): void {
    ctx.events.push({
      event,
      data: JSON.parse(JSON.stringify(data, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))),
    });
  }

  // ── Credits (NEP-141) ─────────────────────────────────────────────────────────────────────────

  private async ftBalanceIn(tx: Tx, accountId: string): Promise<bigint | null> {
    const [row] = await tx.select().from(simFt).where(eq(simFt.accountId, accountId)).for('update');
    return row ? row.balance : null;
  }

  private async ftMove(
    ctx: CallContext,
    from: string,
    to: string,
    amount: bigint,
    memo: string,
  ): Promise<void> {
    // Codes as the gateway maps near-contract-standards' panics, so both modes speak alike.
    require_(amount > 0n, 'invalid_amount');
    require_(from !== to, 'self_transfer');
    // Lock both rows in a fixed order so two transfers can't deadlock each other.
    const [first, second] = from < to ? [from, to] : [to, from];
    const a = await this.ftBalanceIn(ctx.tx, first);
    const b = await this.ftBalanceIn(ctx.tx, second);
    const fromBal = from === first ? a : b;
    const toBal = to === first ? a : b;
    require_(fromBal !== null && toBal !== null, 'not_registered');
    require_((fromBal ?? 0n) >= amount, 'insufficient_balance');
    await ctx.tx
      .update(simFt)
      .set({ balance: sql`${simFt.balance} - ${amount}` })
      .where(eq(simFt.accountId, from));
    await ctx.tx
      .update(simFt)
      .set({ balance: sql`${simFt.balance} + ${amount}` })
      .where(eq(simFt.accountId, to));
    this.emit(ctx, 'ft_transfer', { old_owner_id: from, new_owner_id: to, amount, memo });
  }

  private async register(tx: Tx, accountId: string, kind: string): Promise<void> {
    await tx.insert(simAccounts).values({ accountId, kind }).onConflictDoNothing();
    await tx.insert(simFt).values({ accountId, balance: 0n }).onConflictDoNothing();
  }

  async ensureSetup(cfg: ChainSetup): Promise<void> {
    const [done] = await this.db
      .select()
      .from(simAccounts)
      .where(eq(simAccounts.accountId, this.ids.jobs));
    if (!done) await this.setupContracts(cfg);
    // Its own step, as on a node, so a world set up before the market existed gains it.
    const [market] = await this.db
      .select()
      .from(simAccounts)
      .where(eq(simAccounts.accountId, this.ids.market));
    if (!market) await this.setupMarket(cfg.marketFeeBps);
    for (const badge of cfg.badges ?? []) {
      const known = await this.badgeType(this.db, badge.tokenId);
      if (known?.title !== badge.title || known.description !== badge.description) {
        await this.registerBadge(badge);
      }
    }
  }

  private async setupContracts(cfg: {
    feeBps: number;
    dayMs: number;
    vendorHandles: string[];
  }): Promise<void> {
    const { feeBps, dayMs, vendorHandles } = cfg;
    const args = { feeBps, dayMs, vendorHandles };
    await this.call(this.ids.root, this.ids.root, 'setup', args, 0, 'setup', async (ctx) => {
      for (const [id, kind] of [
        [this.ids.root, 'user'],
        [this.ids.credits, 'contract'],
        [this.ids.registry, 'contract'],
        [this.ids.jobs, 'contract'],
        [this.ids.rep, 'contract'],
        [this.ids.operator, 'user'],
        [this.ids.treasury, 'user'],
        [this.ids.vendors, 'user'],
        [this.ids.badges, 'contract'],
      ] as const) {
        await this.register(ctx.tx, id, kind);
      }
      for (const handle of vendorHandles) {
        await this.register(ctx.tx, `${handle}.${this.ids.vendors}`, 'user');
      }
      await ctx.tx
        .insert(simAccounts)
        .values({
          accountId: `config:${this.ids.root}`,
          kind: JSON.stringify({ feeBps, dayMs, vendorHandles }),
        })
        .onConflictDoNothing();
    });
  }

  /** The market's `new`: registered with credits, with its fee stored as its config. */
  private async setupMarket(feeBps: number): Promise<void> {
    await this.call(
      this.ids.root,
      this.ids.market,
      'new',
      {
        owner_id: this.ids.root,
        registry_id: this.ids.registry,
        credits_id: this.ids.credits,
        treasury_id: this.ids.treasury,
        fee_bps: feeBps,
      },
      0,
      'setup:market',
      async (ctx) => {
        require_(Number.isInteger(feeBps) && feeBps >= 0 && feeBps <= MAX_FEE_BPS, 'fee_too_high');
        await this.register(ctx.tx, this.ids.market, 'contract');
        await this.putJson(ctx.tx, this.marketConfigKey(), { feeBps });
        return undefined;
      },
    );
  }

  private marketConfigKey(): string {
    return `config:${this.ids.market}`;
  }

  private async config(tx: Tx): Promise<{ feeBps: number; dayMs: number }> {
    const [row] = await tx
      .select()
      .from(simAccounts)
      .where(eq(simAccounts.accountId, `config:${this.ids.root}`));
    require_(row !== undefined, 'not_initialized');
    return JSON.parse(row?.kind ?? '{}') as { feeBps: number; dayMs: number };
  }

  async createAccount(accountId: string): Promise<TxResult> {
    return this.call(
      this.ids.root,
      accountId,
      'create_account',
      { account_id: accountId },
      0,
      `account:${accountId}`,
      async (ctx) => {
        const [exists] = await ctx.tx
          .select()
          .from(simAccounts)
          .where(eq(simAccounts.accountId, accountId));
        require_(!exists, 'account_exists');
        await this.register(ctx.tx, accountId, 'user');
        return undefined;
      },
    );
  }

  async mintCredits(accountId: string, amount: bigint, key: string): Promise<TxResult> {
    return this.call(
      this.ids.root,
      this.ids.credits,
      'mint',
      { account_id: accountId, amount },
      0,
      key,
      async (ctx) => {
        require_(ctx.signer === this.ids.root, 'not_owner');
        require_(amount > 0n && amount <= MAX_MINT, 'invalid_amount');
        const bal = await this.ftBalanceIn(ctx.tx, accountId);
        require_(bal !== null, 'not_registered');
        await ctx.tx
          .update(simFt)
          .set({ balance: sql`${simFt.balance} + ${amount}` })
          .where(eq(simFt.accountId, accountId));
        this.emit(ctx, 'ft_mint', { owner_id: accountId, amount });
        return undefined;
      },
    );
  }

  async ftBalance(accountId: string): Promise<bigint> {
    const [row] = await this.db.select().from(simFt).where(eq(simFt.accountId, accountId));
    return row?.balance ?? 0n;
  }

  async ftTransfer(
    signer: string,
    receiverId: string,
    amount: bigint,
    memo: string,
    key: string,
  ): Promise<TxResult> {
    return this.call(
      signer,
      this.ids.credits,
      'ft_transfer',
      { receiver_id: receiverId, amount, memo },
      ONE_YOCTO,
      key,
      async (ctx) => {
        await this.ftMove(ctx, signer, receiverId, amount, memo);
        return undefined;
      },
    );
  }

  // ── Registry (NEP-171) ────────────────────────────────────────────────────────────────────────

  async mintAgent(
    ownerId: string,
    name: string,
    metadata: Record<string, unknown>,
    rulebook: Rulebook,
    key: string,
  ): Promise<TxResult<string>> {
    const prior = await this.findByKey(key);
    const minted = prior?.events.find((e) => e.event === 'nft_mint')?.data as
      | { token_ids?: string[] }
      | undefined;
    const priorToken = minted?.token_ids?.[0];
    if (prior?.outcome === 'success' && priorToken)
      return { txHash: prior.hash, value: priorToken };
    return this.call(
      this.ids.operator,
      this.ids.registry,
      'mint_agent',
      { owner_id: ownerId, name, metadata },
      0,
      key,
      async (ctx) => {
        require_(ctx.signer === this.ids.operator, 'not_minter');
        require_(name.length > 0 && name.length <= 64, 'invalid_name');
        assertValidRulebook(toStoredRulebook(rulebook));
        const cfg = await this.config(ctx.tx);
        // Numbered from 0 by a stored counter, as the registry's `next_agent`: a count of minted
        // tokens could reuse a number after a failed mint, or collide with older numbering.
        const counterKey = `agentseq:${this.ids.registry}`;
        const [mark] = await ctx.tx
          .select()
          .from(simAccounts)
          .where(eq(simAccounts.accountId, counterKey))
          .for('update');
        const [{ top } = { top: -1 }] = await ctx.tx
          .select({
            top: sql<number>`coalesce(max(substring(${simNft.tokenId} from '^agent-([0-9]+)\\.')::int), -1)`,
          })
          .from(simNft);
        const n = Math.max(Number(mark?.kind ?? -1), top) + 1;
        await ctx.tx
          .insert(simAccounts)
          .values({ accountId: counterKey, kind: String(n) })
          .onConflictDoUpdate({ target: simAccounts.accountId, set: { kind: String(n) } });
        const tokenId = `agent-${n}.${this.ids.registry}`;
        await this.register(ctx.tx, tokenId, 'agent');
        const wallet: StoredWallet = {
          owner_id: ownerId,
          registry_id: this.ids.registry,
          operator_id: this.ids.operator,
          credits_id: this.ids.credits,
          treasury_id: this.ids.treasury,
          rulebook: toStoredRulebook(rulebook),
          frozen: false,
          day_ms: cfg.dayMs,
          day: Math.floor(ctx.nowMs / cfg.dayMs),
          spent_today: '0',
          job_spend: [],
          pending: [],
          recent: [],
          rotation_seq: 0,
          next_request_id: 0,
        };
        await ctx.tx.insert(simWallets).values({ accountId: tokenId, state: wallet });
        await ctx.tx
          .insert(simNft)
          .values({ tokenId, ownerId, metadata: { title: name, ...metadata } });
        this.emit(ctx, 'nft_mint', { owner_id: ownerId, token_ids: [tokenId] });
        return tokenId;
      },
    );
  }

  private async nftOwnerIn(
    tx: Tx,
    tokenId: string,
  ): Promise<{ ownerId: string; rotationSeq: number }> {
    const [row] = await tx.select().from(simNft).where(eq(simNft.tokenId, tokenId)).for('update');
    require_(row !== undefined, 'not_found');
    return { ownerId: row?.ownerId ?? '', rotationSeq: row?.rotationSeq ?? 0 };
  }

  async nftOwner(tokenId: string): Promise<string | null> {
    const [row] = await this.db.select().from(simNft).where(eq(simNft.tokenId, tokenId));
    return row?.ownerId ?? null;
  }

  async nftTransfer(signer: string, tokenId: string, receiverId: string): Promise<TxResult> {
    return this.call(
      signer,
      this.ids.registry,
      'nft_transfer',
      { receiver_id: receiverId, token_id: tokenId },
      ONE_YOCTO,
      null,
      async (ctx) => {
        await this.transferToken(ctx, signer, tokenId, receiverId, null);
        return undefined;
      },
    );
  }

  /**
   * The registry's `nft_transfer` by the holder or an approved account (with a matching approval id
   * if given), then `rotate_owner` on the wallet. The registry's nft_transfer_call guard
   * (`transfer_in_flight`) has nothing to guard here: a simulated transfer and its rotation are one
   * atomic step, so there is no window.
   */
  private async transferToken(
    ctx: CallContext,
    sender: string,
    tokenId: string,
    receiverId: string,
    approvalId: number | null,
  ): Promise<void> {
    const [token] = await ctx.tx
      .select()
      .from(simNft)
      .where(eq(simNft.tokenId, tokenId))
      .for('update');
    require_(token !== undefined, 'not_found');
    const ownerId = token?.ownerId ?? '';
    if (sender !== ownerId) {
      const actual = token?.approvals[sender];
      require_(actual !== undefined, 'not_owner');
      require_(approvalId === null || actual === approvalId, 'approval_mismatch');
    }
    require_(receiverId !== ownerId, 'self_transfer');
    const seq = (token?.rotationSeq ?? 0) + 1;
    // Every transfer clears the token's approvals (their storage goes back to the old holder).
    await ctx.tx
      .update(simNft)
      .set({ ownerId: receiverId, rotationSeq: seq, approvals: {} })
      .where(eq(simNft.tokenId, tokenId));
    this.emit(ctx, 'nft_transfer', {
      old_owner_id: ownerId,
      new_owner_id: receiverId,
      token_ids: [tokenId],
    });
    // rotate_owner on the wallet: owner changes, pending approval requests are cleared, money stays put, and the
    // wallet is frozen until the new owner unfreezes it.
    const w = await this.walletIn(ctx.tx, tokenId);
    const oldOwnerId = w.owner_id;
    w.owner_id = receiverId;
    for (const p of w.pending) {
      this.remember(w, p.request.key, {
        status: 'denied',
        request_id: p.id,
        reason: 'owner_changed',
      });
    }
    const cleared = w.pending.map((p) => p.id);
    w.pending = [];
    w.rotation_seq = seq;
    w.frozen = true;
    await this.saveWallet(ctx.tx, tokenId, w);
    this.emit(ctx, 'owner_rotated', {
      wallet_id: tokenId,
      old_owner_id: oldOwnerId,
      new_owner_id: receiverId,
      rotation_seq: seq,
      cleared_request_ids: cleared,
      frozen: true,
    });
  }

  /** Owner actions go through the registry, which checks ownership in the same step that holds it. */
  private async ownerAction<T>(
    signer: string,
    tokenId: string,
    method: string,
    args: Record<string, unknown>,
    body: (ctx: CallContext, wallet: StoredWallet) => Promise<T>,
    key: string | null = null,
  ): Promise<TxResult<T>> {
    return this.call(
      signer,
      this.ids.registry,
      method,
      { token_id: tokenId, ...args },
      ONE_YOCTO,
      key,
      async (ctx) => {
        const { ownerId } = await this.nftOwnerIn(ctx.tx, tokenId);
        require_(ownerId === signer, 'not_owner');
        const wallet = await this.walletIn(ctx.tx, tokenId);
        const value = await body(ctx, wallet);
        await this.saveWallet(ctx.tx, tokenId, wallet);
        return value;
      },
    );
  }

  async setRulebook(signer: string, tokenId: string, rulebook: Rulebook): Promise<TxResult> {
    const stored = toStoredRulebook(rulebook);
    return this.ownerAction(
      signer,
      tokenId,
      'set_rulebook',
      { rulebook: stored },
      async (ctx, w) => {
        assertValidRulebook(stored);
        w.rulebook = stored;
        this.emit(ctx, 'rulebook_set', { wallet_id: tokenId, rulebook: stored });
        return undefined;
      },
    );
  }

  async setFrozen(signer: string, tokenId: string, frozen: boolean): Promise<TxResult> {
    return this.ownerAction(signer, tokenId, 'set_frozen', { frozen }, async (ctx, w) => {
      w.frozen = frozen;
      this.emit(ctx, 'frozen_set', { wallet_id: tokenId, frozen });
      return undefined;
    });
  }

  async withdraw(signer: string, tokenId: string, amount: bigint, key: string): Promise<TxResult> {
    return this.ownerAction(
      signer,
      tokenId,
      'withdraw',
      { amount },
      async (ctx, w) => {
        // The registry refuses while any NEP-178 approval stands: a buyer pays for the wallet as
        // listed, so the seller unlists (revokes) first, which voids the listing.
        const [token] = await ctx.tx
          .select({ approvals: simNft.approvals })
          .from(simNft)
          .where(eq(simNft.tokenId, tokenId));
        require_(Object.keys(token?.approvals ?? {}).length === 0, 'listed');
        // Always to the current holder, never to an address the caller names.
        await this.ftMove(ctx, tokenId, w.owner_id, amount, 'withdraw');
        this.emit(ctx, 'withdrawn', { wallet_id: tokenId, receiver_id: w.owner_id, amount });
        return undefined;
      },
      key,
    );
  }

  async approveSpend(
    signer: string,
    tokenId: string,
    requestId: number,
  ): Promise<TxResult<SpendOutcome>> {
    const result = await this.ownerAction(
      signer,
      tokenId,
      'approve_spend',
      { request_id: requestId },
      async (ctx, w) => {
        const idx = w.pending.findIndex((p) => p.id === requestId);
        require_(idx >= 0, 'request_not_found');
        const [entry] = w.pending.splice(idx, 1);
        if (!entry) throw new Panic('request_not_found');
        const outcome = await this.executeSpend(
          ctx,
          tokenId,
          w,
          fromStoredRequest(entry.request),
          entry.id,
          true,
        );
        return outcome;
      },
    );
    return { txHash: result.txHash, value: { ...result.value, txHash: result.txHash } };
  }

  async denySpend(signer: string, tokenId: string, requestId: number): Promise<TxResult> {
    return this.ownerAction(
      signer,
      tokenId,
      'deny_spend',
      { request_id: requestId },
      async (ctx, w) => {
        const idx = w.pending.findIndex((p) => p.id === requestId);
        require_(idx >= 0, 'request_not_found');
        const [entry] = w.pending.splice(idx, 1);
        if (entry) {
          this.remember(w, entry.request.key, {
            status: 'denied',
            request_id: requestId,
            reason: 'denied_by_owner',
          });
        }
        this.emit(ctx, 'approval_denied', { wallet_id: tokenId, request_id: requestId });
        return undefined;
      },
    );
  }

  // ── Agent wallet ──────────────────────────────────────────────────────────────────────────────

  private async walletIn(tx: Tx, walletId: string): Promise<StoredWallet> {
    const [row] = await tx
      .select()
      .from(simWallets)
      .where(eq(simWallets.accountId, walletId))
      .for('update');
    require_(row !== undefined, 'wallet_not_found');
    return row?.state as StoredWallet;
  }

  private async saveWallet(tx: Tx, walletId: string, w: StoredWallet): Promise<void> {
    await tx.update(simWallets).set({ state: w }).where(eq(simWallets.accountId, walletId));
  }

  private rollDay(w: StoredWallet, nowMs: number): void {
    const day = Math.floor(nowMs / w.day_ms);
    if (day !== w.day) {
      w.day = day;
      w.spent_today = '0';
    }
  }

  /** Later stages (approval, denial, settlement) update the key's outcome in place, as the wallet does. */
  private remember(w: StoredWallet, key: string, outcome: StoredOutcome): void {
    const seen = w.recent.find(([k]) => k === key);
    if (seen) {
      seen[1] = outcome;
      return;
    }
    w.recent.push([key, outcome]);
    if (w.recent.length > MAX_RECENT) w.recent.shift();
  }

  private receiverRule(w: StoredWallet, walletId: string, r: SpendRequest): SpendReason | null {
    if (TREASURY_KINDS.has(r.kind)) {
      return r.receiverId === w.treasury_id ? null : 'vendor_not_allowed';
    }
    if (r.kind === 'tool') {
      return w.rulebook.any_vendor || w.rulebook.allowed_vendors.includes(r.receiverId)
        ? null
        : 'vendor_not_allowed';
    }
    if (!w.rulebook.may_hire) return 'hiring_disabled';
    if (!isAgentWallet(r.receiverId, w.registry_id)) return 'vendor_not_allowed';
    if (r.receiverId === walletId) return 'self_payment';
    return null;
  }

  private capRule(w: StoredWallet, r: SpendRequest): SpendReason | null {
    const rb = w.rulebook;
    if (r.kind === 'bond') {
      // A bond buys nothing; it only counts against what may leave the wallet today.
      return BigInt(w.spent_today) + r.amount > BigInt(rb.daily_cap) ? 'over_daily_cap' : null;
    }
    const jobSpent = r.jobId ? BigInt(w.job_spend.find(([j]) => j === r.jobId)?.[1] ?? '0') : 0n;
    if (r.amount > BigInt(rb.max_per_call)) return 'over_call_cap';
    if (r.jobId && jobSpent + r.amount > BigInt(rb.max_per_job)) return 'over_job_cap';
    if (BigInt(w.spent_today) + r.amount > BigInt(rb.daily_cap)) return 'over_daily_cap';
    if (r.kind === 'helper' && r.amount > BigInt(rb.helper_budget)) return 'over_helper_budget';
    return null;
  }

  /** Reserve, transfer, and on failure release the reservation: the wallet's `spend` tail. */
  private async executeSpend(
    ctx: CallContext,
    walletId: string,
    w: StoredWallet,
    r: SpendRequest,
    requestId: number,
    approved: boolean,
  ): Promise<SpendOutcome> {
    const done = (status: SpendOutcome['status'], reason: SpendReason | null) => {
      this.remember(w, r.key, { status, request_id: requestId, reason });
      return { status, reason, requestId: null, txHash: '' };
    };
    if (w.frozen) {
      this.emit(ctx, 'spend_blocked', {
        wallet_id: walletId,
        key: r.key,
        reason: 'frozen',
        amount: r.amount,
        receiver_id: r.receiverId,
      });
      return done('blocked', 'frozen');
    }
    const receiverReason = this.receiverRule(w, walletId, r);
    if (receiverReason) {
      this.emit(ctx, 'spend_blocked', {
        wallet_id: walletId,
        key: r.key,
        reason: receiverReason,
        amount: r.amount,
        receiver_id: r.receiverId,
        kind: r.kind,
      });
      return done('blocked', receiverReason);
    }
    this.rollDay(w, ctx.nowMs);
    // Reserve first, so a failed transfer can release exactly what it took.
    w.spent_today = (BigInt(w.spent_today) + r.amount).toString();
    // A bond doesn't use up the job's tool budget.
    const jobId = r.kind === 'bond' ? null : r.jobId;
    if (jobId) {
      const entry = w.job_spend.find(([j]) => j === jobId);
      if (entry) entry[1] = (BigInt(entry[1]) + r.amount).toString();
      else {
        w.job_spend.push([jobId, r.amount.toString()]);
        if (w.job_spend.length > MAX_JOB_SPEND) w.job_spend.shift();
      }
    }
    const bal = await this.ftBalanceIn(ctx.tx, walletId);
    const target = await this.ftBalanceIn(ctx.tx, r.receiverId);
    if (bal === null || bal < r.amount || target === null) {
      w.spent_today = (BigInt(w.spent_today) - r.amount).toString();
      const entry = jobId ? w.job_spend.find(([j]) => j === jobId) : undefined;
      if (entry) entry[1] = (BigInt(entry[1]) - r.amount).toString();
      this.emit(ctx, 'spend_failed', {
        wallet_id: walletId,
        key: r.key,
        reason: 'transfer_failed',
        amount: r.amount,
      });
      return done('failed', 'transfer_failed');
    }
    await this.ftMove(ctx, walletId, r.receiverId, r.amount, r.memo);
    this.emit(ctx, 'spend_settled', {
      wallet_id: walletId,
      key: r.key,
      kind: r.kind,
      receiver_id: r.receiverId,
      amount: r.amount,
      job_id: r.jobId,
      receipt: r.receipt,
      approved,
    });
    return done('settled', null);
  }

  async spend(walletId: string, request: SpendRequest): Promise<SpendOutcome> {
    const stored = toStoredRequest(request);
    const result = await this.call(
      this.ids.operator,
      walletId,
      'spend',
      { request: stored },
      0,
      request.key,
      async (ctx): Promise<StoredOutcome> => {
        require_(ctx.signer === this.ids.operator, 'not_operator');
        assertValidRequest(request);
        const w = await this.walletIn(ctx.tx, walletId);
        const seen = w.recent.find(([k]) => k === request.key);
        if (seen) return seen[1];
        this.rollDay(w, ctx.nowMs);
        // Every new request takes the next id, whatever its outcome, as the wallet does.
        const id = w.next_request_id++;
        const block = (reason: SpendReason): StoredOutcome => {
          this.emit(ctx, 'spend_blocked', {
            wallet_id: walletId,
            request_id: id,
            key: request.key,
            reason,
            amount: request.amount,
            receiver_id: request.receiverId,
            kind: request.kind,
          });
          const outcome: StoredOutcome = { status: 'blocked', request_id: id, reason };
          this.remember(w, request.key, outcome);
          return outcome;
        };
        let outcome: StoredOutcome;
        const receiverReason = w.frozen ? 'frozen' : this.receiverRule(w, walletId, request);
        const capReason = receiverReason ? null : this.capRule(w, request);
        if (receiverReason) {
          outcome = block(receiverReason);
        } else if (capReason && TREASURY_KINDS.has(request.kind)) {
          // Running costs and bonds are never queued: an agent can't run up a bill while its owner is away.
          outcome = block(capReason);
        } else if (capReason && w.pending.length >= MAX_PENDING) {
          outcome = block('approval_queue_full');
        } else if (capReason) {
          w.pending.push({ id, request: stored, reason: capReason });
          this.emit(ctx, 'approval_requested', {
            wallet_id: walletId,
            key: request.key,
            request_id: id,
            reason: capReason,
            amount: request.amount,
            receiver_id: request.receiverId,
            kind: request.kind,
          });
          outcome = { status: 'pending', request_id: id, reason: capReason };
          this.remember(w, request.key, outcome);
        } else {
          const done = await this.executeSpend(ctx, walletId, w, request, id, false);
          outcome = { status: done.status, request_id: id, reason: done.reason };
        }
        await this.saveWallet(ctx.tx, walletId, w);
        return outcome;
      },
    );
    const o = result.value;
    if (o.status === 'denied') {
      // A repeated key whose approval was denied: final, but not a status the game's type has.
      throw new ChainError(o.reason ?? 'denied_by_owner', result.txHash);
    }
    return {
      status: o.status,
      reason: o.reason as SpendReason | null,
      requestId: o.status === 'pending' ? o.request_id : null,
      txHash: result.txHash,
    };
  }

  async getWallet(walletId: string): Promise<WalletState> {
    const [row] = await this.db.select().from(simWallets).where(eq(simWallets.accountId, walletId));
    if (!row) throw new ChainError('wallet_not_found', null);
    const w = row.state as StoredWallet;
    const today = Math.floor(this.now() / w.day_ms);
    return {
      ownerId: w.owner_id,
      rulebook: fromStoredRulebook(w.rulebook),
      frozen: w.frozen,
      dayMs: w.day_ms,
      day: today,
      spentToday: today === w.day ? BigInt(w.spent_today) : 0n,
      jobSpent: Object.fromEntries(w.job_spend.map(([j, v]) => [j, BigInt(v)])),
      pending: w.pending.map(
        (p): PendingApproval => ({
          id: p.id,
          request: fromStoredRequest(p.request),
          reason: p.reason,
        }),
      ),
      rotationSeq: w.rotation_seq,
    };
  }

  // ── Job board ─────────────────────────────────────────────────────────────────────────────────

  private async jobIn(tx: Tx, jobId: string): Promise<StoredJob> {
    const [row] = await tx
      .select()
      .from(simJobs)
      .where(eq(simJobs.jobId, Number(jobId)))
      .for('update');
    require_(row !== undefined, 'not_found');
    return row?.state as StoredJob;
  }

  private async saveJob(tx: Tx, job: StoredJob): Promise<void> {
    await tx
      .update(simJobs)
      .set({ state: job })
      .where(eq(simJobs.jobId, Number(job.job_id)));
  }

  /**
   * Settled jobs leave storage but their key stays used, so a re-post of a finished job is refunded.
   * (The board forgets keys after 256 settlements; the simulator never does, which is stricter.)
   */
  private async removeJob(ctx: CallContext, jobId: string, settlement: Settlement): Promise<void> {
    const [row] = await ctx.tx
      .delete(simJobs)
      .where(eq(simJobs.jobId, Number(jobId)))
      .returning();
    if (row) {
      await ctx.tx
        .insert(simAccounts)
        .values({ accountId: this.settledKeyId(row.jobKey), kind: 'settled_job_key' })
        .onConflictDoNothing();
      this.emit(ctx, 'job_settled', { job_id: jobId, job_key: row.jobKey, settlement });
    }
  }

  /**
   * The board's `settle`: emits `job_settling`, pays each transfer out of escrow and removes the job
   * (`job_settled`). Transfers can't fail here, so a simulated job never reaches `payout_failed`.
   */
  private async settle(
    ctx: CallContext,
    job: StoredJob,
    settlement: Settlement,
    rating: number | null,
    transfers: EscrowTransfer[],
  ): Promise<void> {
    this.emit(ctx, 'job_settling', { job_id: job.job_id, settlement, rating, transfers });
    for (const t of transfers) {
      if (t.amount > 0n) {
        await this.ftMove(ctx, this.ids.jobs, t.receiver_id, t.amount, `job ${job.job_id}`);
      }
    }
    await this.removeJob(ctx, job.job_id, settlement);
  }

  private settledKeyId(jobKey: string): string {
    return `settledkey:${this.ids.jobs}:${jobKey}`;
  }

  /** Why the board would refuse this post (and refund it), as `ft_on_transfer` checks in order. */
  private async postRefusal(
    tx: Tx,
    budget: bigint,
    msg: { jobKey: string; specHash: string; reviewWindowMs: number; deliveryWindowMs?: number },
  ): Promise<string | null> {
    if (budget < MIN_BUDGET) return 'below_min_budget';
    if (budget > MAX_AMOUNT) return 'amount_too_large';
    if (msg.jobKey.length === 0 || msg.jobKey.length > MAX_JOB_KEY_LEN) return 'invalid_job_key';
    if (msg.specHash.length === 0 || msg.specHash.length > MAX_HASH_LEN) return 'invalid_hash';
    if (msg.reviewWindowMs < 0 || msg.reviewWindowMs > MAX_REVIEW_WINDOW_MS) {
      return 'invalid_review_window';
    }
    const delivery = msg.deliveryWindowMs ?? DEFAULT_DELIVERY_WINDOW_MS;
    if (delivery < MIN_DELIVERY_WINDOW_MS || delivery > MAX_DELIVERY_WINDOW_MS) {
      return 'invalid_delivery_window';
    }
    const [live] = await tx.select().from(simJobs).where(eq(simJobs.jobKey, msg.jobKey));
    const [settled] = await tx
      .select()
      .from(simAccounts)
      .where(eq(simAccounts.accountId, this.settledKeyId(msg.jobKey)));
    return live || settled ? 'duplicate_job_key' : null;
  }

  async postJob(
    signer: string,
    budget: bigint,
    msg: {
      jobKey: string;
      specHash: string;
      autoAward: boolean;
      reviewWindowMs: number;
      deliveryWindowMs?: number;
    },
  ): Promise<TxResult<string | null>> {
    const args = {
      receiver_id: this.ids.jobs,
      amount: budget,
      msg: JSON.stringify({
        post: {
          job_key: msg.jobKey,
          spec_hash: msg.specHash,
          auto_award: msg.autoAward,
          review_window_ms: msg.reviewWindowMs,
          delivery_window_ms: msg.deliveryWindowMs,
        },
      }),
    };
    return this.call(
      signer,
      this.ids.credits,
      'ft_transfer_call',
      args,
      ONE_YOCTO,
      `post:${msg.jobKey}`,
      async (ctx) => {
        await this.ftMove(ctx, signer, this.ids.jobs, budget, 'escrow');
        // ft_on_transfer on the job board: a refused post (dust, repeated key, bad bounds) returns the amount.
        const refusal = await this.postRefusal(ctx.tx, budget, msg);
        if (refusal) {
          await this.ftMove(ctx, this.ids.jobs, signer, budget, 'refund');
          this.emit(ctx, 'post_refunded', { sender_id: signer, amount: budget, reason: refusal });
          return null;
        }
        const [{ next } = { next: 1 }] = await ctx.tx
          .select({ next: sql<number>`coalesce(max(${simJobs.jobId}), 0)::int + 1` })
          .from(simJobs);
        // Ids must never repeat even after settled jobs are removed, so keep a high-water mark.
        const [mark] = await ctx.tx
          .select()
          .from(simAccounts)
          .where(eq(simAccounts.accountId, `jobseq:${this.ids.jobs}`))
          .for('update');
        const id = Math.max(next, Number(mark?.kind ?? 0) + 1);
        await ctx.tx
          .insert(simAccounts)
          .values({ accountId: `jobseq:${this.ids.jobs}`, kind: String(id) })
          .onConflictDoUpdate({ target: simAccounts.accountId, set: { kind: String(id) } });
        const job: StoredJob = {
          job_id: String(id),
          client_id: signer,
          budget: budget.toString(),
          price: null,
          agent_id: null,
          status: 'open',
          work_hash: null,
          auto_award: msg.autoAward,
          review_window_ms: msg.reviewWindowMs,
          delivered_at_ms: null,
          spec_hash: msg.specHash,
          delivery_window_ms: msg.deliveryWindowMs ?? DEFAULT_DELIVERY_WINDOW_MS,
          awarded_at_ms: null,
        };
        await ctx.tx.insert(simJobs).values({ jobId: id, jobKey: msg.jobKey, state: job });
        this.emit(ctx, 'job_posted', {
          job_id: String(id),
          client_id: signer,
          budget,
          spec_hash: msg.specHash,
        });
        return String(id);
      },
    );
  }

  async award(signer: string, jobId: string, agentId: string, price: bigint): Promise<TxResult> {
    return this.call(
      signer,
      this.ids.jobs,
      'award',
      { job_id: jobId, agent_id: agentId, price },
      0,
      `award:${jobId}`,
      async (ctx) => {
        const job = await this.jobIn(ctx.tx, jobId);
        require_(
          ctx.signer === job.client_id || (job.auto_award && ctx.signer === this.ids.operator),
          'not_client',
        );
        require_(job.status === 'open', 'wrong_status');
        require_(isAgentWallet(agentId, this.ids.registry), 'not_agent');
        require_(price > 0n && price <= BigInt(job.budget), 'invalid_price');
        const refund = BigInt(job.budget) - price;
        if (refund > 0n)
          await this.ftMove(ctx, this.ids.jobs, job.client_id, refund, 'award refund');
        // The budget stays as posted (the board reports it); the price is what remains escrowed.
        job.price = price.toString();
        job.agent_id = agentId;
        job.status = 'awarded';
        job.awarded_at_ms = ctx.nowMs;
        await this.saveJob(ctx.tx, job);
        this.emit(ctx, 'job_awarded', { job_id: jobId, agent_id: agentId, price, refund });
        return undefined;
      },
    );
  }

  async deliver(jobId: string, agentId: string, workHash: string): Promise<TxResult> {
    return this.call(
      this.ids.operator,
      this.ids.jobs,
      'deliver',
      { job_id: jobId, agent_id: agentId, work_hash: workHash },
      0,
      `deliver:${jobId}`,
      async (ctx) => {
        require_(ctx.signer === this.ids.operator, 'not_operator');
        require_(workHash.length > 0 && workHash.length <= MAX_HASH_LEN, 'invalid_hash');
        const job = await this.jobIn(ctx.tx, jobId);
        require_(job.status === 'awarded', 'wrong_status');
        require_(job.agent_id === agentId, 'wrong_agent');
        job.status = 'delivered';
        job.work_hash = workHash;
        job.delivered_at_ms = ctx.nowMs;
        await this.saveJob(ctx.tx, job);
        this.emit(ctx, 'job_delivered', { job_id: jobId, agent_id: agentId, work_hash: workHash });
        return undefined;
      },
    );
  }

  private async payout(
    ctx: CallContext,
    job: StoredJob,
    rating: number | null,
    outcome: RepOutcome,
  ): Promise<void> {
    const { feeBps } = await this.config(ctx.tx);
    const price = BigInt(job.price ?? '0');
    // Fee rounds down: the agent keeps the remainder.
    const fee = (price * BigInt(feeBps)) / 10_000n;
    const agent = job.agent_id ?? '';
    await this.settle(ctx, job, 'paid', rating, [
      { receiver_id: agent, amount: price - fee, purpose: 'agent_payout' },
      { receiver_id: this.ids.treasury, amount: fee, purpose: 'fee' },
    ]);
    // Kept alongside the board's events for readers written against the simulator.
    this.emit(ctx, 'job_paid', {
      job_id: job.job_id,
      agent_id: agent,
      payout: price - fee,
      fee,
      rating,
    });
    await this.recordRep(ctx, agent, job.job_id, outcome, rating);
  }

  private async recordRep(
    ctx: CallContext,
    agentId: string,
    jobId: string,
    outcome: RepOutcome,
    rating: number | null,
  ): Promise<void> {
    const [row] = await ctx.tx
      .select()
      .from(simReputation)
      .where(eq(simReputation.agentId, agentId))
      .for('update');
    const rep: StoredRep = (row?.state as StoredRep | undefined) ?? {
      jobs: 0,
      rating_sum: 0,
      rated_jobs: 0,
      disputes: 0,
      scams_blocked: 0,
      recent: [],
    };
    // As the reputation contract: a dispute won counts as a job but carries no rating.
    if (outcome === 'completed' || outcome === 'dispute_won') rep.jobs += 1;
    else if (outcome === 'dispute_lost') rep.disputes += 1;
    else rep.scams_blocked += 1;
    if (rating !== null) {
      rep.rating_sum += rating;
      rep.rated_jobs = (rep.rated_jobs ?? 0) + 1;
    }
    rep.recent.push({ job_id: jobId, outcome, rating });
    if (rep.recent.length > MAX_RECENT_OUTCOMES) rep.recent.shift();
    await ctx.tx
      .insert(simReputation)
      .values({ agentId, state: rep })
      .onConflictDoUpdate({ target: simReputation.agentId, set: { state: rep } });
    this.emit(ctx, 'outcome_recorded', { agent_id: agentId, job_id: jobId, outcome, rating });
  }

  async accept(signer: string, jobId: string, rating: number): Promise<TxResult> {
    return this.call(
      signer,
      this.ids.jobs,
      'accept',
      { job_id: jobId, rating },
      0,
      `accept:${jobId}`,
      async (ctx) => {
        require_(Number.isInteger(rating) && rating >= 1 && rating <= 5, 'invalid_rating');
        const job = await this.jobIn(ctx.tx, jobId);
        require_(ctx.signer === job.client_id, 'not_client');
        require_(job.status === 'delivered', 'wrong_status');
        await this.payout(ctx, job, rating, 'completed');
        return undefined;
      },
    );
  }

  /** Anyone may release a delivered job after its review window, at the default rating of 4. */
  async releaseExpired(signer: string, jobId: string): Promise<TxResult> {
    return this.call(
      signer,
      this.ids.jobs,
      'release_expired',
      { job_id: jobId },
      0,
      `release:${jobId}`,
      async (ctx) => {
        const job = await this.jobIn(ctx.tx, jobId);
        require_(job.status === 'delivered', 'wrong_status');
        require_(
          ctx.nowMs >= (job.delivered_at_ms ?? 0) + job.review_window_ms,
          'review_window_open',
        );
        await this.payout(ctx, job, 4, 'completed');
        return undefined;
      },
    );
  }

  async dispute(signer: string, jobId: string): Promise<TxResult> {
    return this.call(
      signer,
      this.ids.jobs,
      'dispute',
      { job_id: jobId },
      0,
      `dispute:${jobId}`,
      async (ctx) => {
        const job = await this.jobIn(ctx.tx, jobId);
        require_(ctx.signer === job.client_id, 'not_client');
        require_(job.status === 'delivered', 'wrong_status');
        require_(
          ctx.nowMs < (job.delivered_at_ms ?? 0) + job.review_window_ms,
          'review_window_closed',
        );
        job.status = 'disputed';
        await this.saveJob(ctx.tx, job);
        this.emit(ctx, 'job_disputed', { job_id: jobId });
        return undefined;
      },
    );
  }

  async resolve(jobId: string, refund: boolean): Promise<TxResult> {
    return this.call(
      this.ids.operator,
      this.ids.jobs,
      'resolve',
      { job_id: jobId, refund },
      0,
      `resolve:${jobId}`,
      async (ctx) => {
        require_(ctx.signer === this.ids.operator, 'not_operator');
        const job = await this.jobIn(ctx.tx, jobId);
        require_(job.status === 'disputed', 'wrong_status');
        if (refund) {
          await this.recordRep(ctx, job.agent_id ?? '', jobId, 'dispute_lost', null);
          await this.settle(ctx, job, 'refunded', null, [
            { receiver_id: job.client_id, amount: BigInt(job.price ?? '0'), purpose: 'refund' },
          ]);
          this.emit(ctx, 'job_refunded', { job_id: jobId, client_id: job.client_id });
        } else {
          await this.payout(ctx, job, null, 'dispute_won');
        }
        return undefined;
      },
    );
  }

  async cancel(signer: string, jobId: string): Promise<TxResult> {
    return this.call(
      signer,
      this.ids.jobs,
      'cancel',
      { job_id: jobId },
      0,
      `cancel:${jobId}`,
      async (ctx) => {
        const job = await this.jobIn(ctx.tx, jobId);
        // Only the client cancels, even an auto-award job: the operator may award it, not withdraw it.
        require_(ctx.signer === job.client_id, 'not_client');
        require_(job.status === 'open', 'wrong_status');
        await this.settle(ctx, job, 'cancelled', null, [
          { receiver_id: job.client_id, amount: BigInt(job.budget), purpose: 'refund' },
        ]);
        this.emit(ctx, 'job_cancelled', { job_id: jobId });
        return undefined;
      },
    );
  }

  /** Anyone: once the delivery window after award has passed with no delivery, refund the client. */
  async reclaimUndelivered(signer: string, jobId: string): Promise<TxResult> {
    return this.call(
      signer,
      this.ids.jobs,
      'reclaim_undelivered',
      { job_id: jobId },
      0,
      `reclaim:${jobId}`,
      async (ctx) => {
        const job = await this.jobIn(ctx.tx, jobId);
        require_(job.status === 'awarded', 'wrong_status');
        const window = job.delivery_window_ms ?? DEFAULT_DELIVERY_WINDOW_MS;
        require_(ctx.nowMs >= (job.awarded_at_ms ?? 0) + window, 'delivery_window_open');
        // Nothing goes to reputation: an award only checks the shape of the agent's id.
        await this.settle(ctx, job, 'reclaimed', null, [
          { receiver_id: job.client_id, amount: BigInt(job.price ?? '0'), purpose: 'refund' },
        ]);
        return undefined;
      },
    );
  }

  /**
   * Same checks as the board's. Simulated transfers never fail, so no job is ever `payout_failed`
   * and this always refuses with `wrong_status`; it exists so both gateways share one interface.
   */
  async reclaimFailedPayout(signer: string, jobId: string): Promise<TxResult> {
    return this.call(
      signer,
      this.ids.jobs,
      'reclaim_failed_payout',
      { job_id: jobId },
      0,
      `reclaim-payout:${jobId}`,
      async (ctx) => {
        const job = await this.jobIn(ctx.tx, jobId);
        require_(job.status === 'payout_failed', 'wrong_status');
        return undefined;
      },
    );
  }

  async getJob(jobId: string): Promise<ChainJob | null> {
    const [row] = await this.db
      .select()
      .from(simJobs)
      .where(eq(simJobs.jobId, Number(jobId)));
    if (!row) return null;
    const j = row.state as StoredJob;
    return {
      jobId: j.job_id,
      clientId: j.client_id,
      budget: BigInt(j.budget),
      price: j.price === null ? null : BigInt(j.price),
      agentId: j.agent_id,
      status: j.status,
      workHash: j.work_hash,
      deliveryWindowMs: j.delivery_window_ms ?? DEFAULT_DELIVERY_WINDOW_MS,
      awardedAtMs: j.awarded_at_ms ?? null,
    };
  }

  // ── Reputation ────────────────────────────────────────────────────────────────────────────────

  async recordScamBlocked(
    agentId: string,
    jobId: string,
    key = `scam:${agentId}:${jobId}`,
  ): Promise<TxResult> {
    return this.call(
      this.ids.operator,
      this.ids.rep,
      'record_scam_blocked',
      { agent_id: agentId, job_id: jobId },
      0,
      key,
      async (ctx) => {
        require_(ctx.signer === this.ids.operator, 'not_operator');
        require_(isAgentWallet(agentId, this.ids.registry), 'not_agent');
        require_(jobId.length > 0 && jobId.length <= MAX_JOB_ID_LEN, 'invalid_job_id');
        await this.recordRep(ctx, agentId, jobId, 'scam_blocked', null);
        return undefined;
      },
    );
  }

  async getReputation(agentId: string): Promise<Reputation> {
    const [row] = await this.db
      .select()
      .from(simReputation)
      .where(eq(simReputation.agentId, agentId));
    const rep = row?.state as StoredRep | undefined;
    return {
      jobs: rep?.jobs ?? 0,
      ratingSum: rep?.rating_sum ?? 0,
      ratedJobs: rep?.rated_jobs ?? 0,
      disputes: rep?.disputes ?? 0,
      scamsBlocked: rep?.scams_blocked ?? 0,
    };
  }

  // ── Badges (NEP-245, soulbound) ───────────────────────────────────────────────────────────────
  // Kept as JSON rows in sim_accounts (`badge:` types, `badges-held:` per agent), so the badges
  // need no table of their own.

  private badgeKey(tokenId: string): string {
    return `badge:${this.ids.badges}:${tokenId}`;
  }

  private heldKey(agentId: string): string {
    return `badges-held:${this.ids.badges}:${agentId}`;
  }

  private async badgeType(db: Db | Tx, tokenId: string): Promise<StoredBadge | null> {
    const [row] = await db
      .select()
      .from(simAccounts)
      .where(eq(simAccounts.accountId, this.badgeKey(tokenId)));
    return row ? (JSON.parse(row.kind) as StoredBadge) : null;
  }

  private async held(db: Db | Tx, agentId: string): Promise<string[]> {
    const [row] = await db
      .select()
      .from(simAccounts)
      .where(eq(simAccounts.accountId, this.heldKey(agentId)));
    return row ? (JSON.parse(row.kind) as string[]) : [];
  }

  private async putJson(tx: Tx, accountId: string, value: unknown): Promise<void> {
    const kind = JSON.stringify(value);
    await tx
      .insert(simAccounts)
      .values({ accountId, kind })
      .onConflictDoUpdate({ target: simAccounts.accountId, set: { kind } });
  }

  /** The owner defines a badge type, or updates its title and description (supply is kept). */
  private async registerBadge(badge: BadgeType): Promise<void> {
    const { tokenId, title, description } = badge;
    await this.call(
      this.ids.root,
      this.ids.badges,
      'register_badge',
      { token_id: tokenId, title, description },
      0,
      null,
      async (ctx) => {
        require_(ctx.signer === this.ids.root, 'not_owner');
        require_(BADGE_ID.test(tokenId), 'invalid_token_id');
        require_(title.length > 0 && title.length <= MAX_BADGE_TITLE_LEN, 'invalid_title');
        require_(description.length <= MAX_BADGE_DESCRIPTION_LEN, 'invalid_description');
        const existing = await this.badgeType(ctx.tx, tokenId);
        if (!existing) {
          const [{ n } = { n: 0 }] = await ctx.tx
            .select({ n: sql<number>`count(*)::int` })
            .from(simAccounts)
            .where(sql`${simAccounts.accountId} like ${`badge:${this.ids.badges}:%`}`);
          require_(n < MAX_BADGE_TYPES, 'too_many_badges');
        }
        const metadata = { title, description };
        this.emit(ctx, 'badge_registered', { token_id: tokenId, metadata });
        await this.putJson(ctx.tx, this.badgeKey(tokenId), {
          ...metadata,
          supply: existing?.supply ?? 0,
        });
        return undefined;
      },
    );
  }

  async mintBadge(
    agentId: string,
    tokenId: string,
    memo: string | null,
  ): Promise<TxResult<boolean>> {
    return this.call(
      this.ids.operator,
      this.ids.badges,
      'mint_badge',
      { agent_id: agentId, token_id: tokenId, memo },
      0,
      `badge:${agentId}:${tokenId}`,
      async (ctx) => {
        require_(ctx.signer === this.ids.operator, 'not_minter');
        require_(isAgentWallet(agentId, this.ids.registry), 'not_agent');
        if (memo !== null) require_(memo.length <= MAX_MEMO_LEN, 'memo_too_long');
        const badge = await this.badgeType(ctx.tx, tokenId);
        require_(badge !== null, 'unknown_badge');
        const held = await this.held(ctx.tx, agentId);
        if (!badge || held.includes(tokenId)) return false;
        await this.putJson(ctx.tx, this.heldKey(agentId), [...held, tokenId]);
        await this.putJson(ctx.tx, this.badgeKey(tokenId), { ...badge, supply: badge.supply + 1 });
        // NEP-245 `mt_mint`, one entry of its data array (the gateways split arrays per entry).
        this.emit(ctx, 'mt_mint', {
          owner_id: agentId,
          token_ids: [tokenId],
          amounts: ['1'],
          ...(memo === null ? {} : { memo }),
        });
        return true;
      },
    );
  }

  async badgesOf(agentId: string): Promise<BadgeType[]> {
    const out: BadgeType[] = [];
    // The contract pages at 100 and an agent holds at most 64, so one read is the whole list.
    for (const tokenId of await this.held(this.db, agentId)) {
      const badge = await this.badgeType(this.db, tokenId);
      if (badge) out.push({ tokenId, title: badge.title, description: badge.description });
    }
    return out;
  }

  // ── Market (listings by NEP-178 approval, bought with credits) ────────────────────────────────

  async listAgent(signer: string, tokenId: string, price: bigint): Promise<TxResult<Listing>> {
    const msg = JSON.stringify({ price: price.toString() });
    return this.call(
      signer,
      this.ids.registry,
      'nft_approve',
      { token_id: tokenId, account_id: this.ids.market, msg },
      approvalDeposit(this.ids.market),
      null,
      async (ctx) => {
        // The registry's nft_approve: the holder only; the approval takes the token's next id.
        const [token] = await ctx.tx
          .select()
          .from(simNft)
          .where(eq(simNft.tokenId, tokenId))
          .for('update');
        require_(token !== undefined, 'not_found');
        require_(token?.ownerId === signer, 'not_owner');
        const approvalId = token?.nextApprovalId ?? 1;
        await ctx.tx
          .update(simNft)
          .set({
            approvals: { ...token?.approvals, [this.ids.market]: approvalId },
            nextApprovalId: approvalId + 1,
          })
          .where(eq(simNft.tokenId, tokenId));
        // The market's nft_on_approve: creates or replaces the token's listing.
        require_(price > 0n && price <= MAX_LISTING_PRICE, 'invalid_price');
        const [existing] = await ctx.tx
          .select()
          .from(simListings)
          .where(eq(simListings.tokenId, tokenId))
          .for('update');
        if (!existing) {
          const [{ n } = { n: 0 }] = await ctx.tx.select({ n: count() }).from(simListings);
          require_(n < MAX_LISTINGS, 'too_many_listings');
        }
        const listing = { tokenId, sellerId: signer, price, approvalId };
        await ctx.tx
          .insert(simListings)
          .values(listing)
          .onConflictDoUpdate({
            target: simListings.tokenId,
            set: { sellerId: signer, price, approvalId },
          });
        this.emit(ctx, 'listed', {
          token_id: tokenId,
          seller_id: signer,
          price,
          approval_id: approvalId,
        });
        return listing;
      },
    );
  }

  async cancelListing(signer: string, tokenId: string): Promise<TxResult> {
    const cancelled = await this.call(
      signer,
      this.ids.market,
      'cancel_listing',
      { token_id: tokenId },
      ONE_YOCTO,
      null,
      async (ctx) => {
        const [listing] = await ctx.tx
          .delete(simListings)
          .where(eq(simListings.tokenId, tokenId))
          .returning();
        require_(listing !== undefined, 'not_found');
        require_(listing?.sellerId === signer, 'not_seller');
        this.emit(ctx, 'unlisted', { token_id: tokenId, seller_id: signer, reason: 'cancelled' });
        return undefined;
      },
    );
    // A seller whose token moved some other way has no approval left to revoke.
    if ((await this.nftOwner(tokenId)) === signer) {
      await this.call(
        signer,
        this.ids.registry,
        'nft_revoke',
        { token_id: tokenId, account_id: this.ids.market },
        ONE_YOCTO,
        null,
        async (ctx) => {
          const { ownerId } = await this.nftOwnerIn(ctx.tx, tokenId);
          require_(ownerId === signer, 'not_owner');
          const [token] = await ctx.tx.select().from(simNft).where(eq(simNft.tokenId, tokenId));
          const { [this.ids.market]: _revoked, ...rest } = token?.approvals ?? {};
          await ctx.tx.update(simNft).set({ approvals: rest }).where(eq(simNft.tokenId, tokenId));
          return undefined;
        },
      );
    }
    return cancelled;
  }

  async buyAgent(
    signer: string,
    tokenId: string,
    expectedPrice: bigint,
    key: string,
  ): Promise<TxResult<'bought' | 'refunded'>> {
    // A retried buy whose first call landed returns that result: sending again would only be
    // refunded, and would report a buy that succeeded as refunded.
    const prior = await this.findByKey(key);
    if (prior) return { txHash: prior.hash, value: buyResult(prior.events, signer, tokenId) };
    const msg = JSON.stringify({ token_id: tokenId, expected_price: expectedPrice.toString() });
    return this.call(
      signer,
      this.ids.credits,
      'ft_transfer_call',
      { receiver_id: this.ids.market, amount: expectedPrice, msg },
      ONE_YOCTO,
      key,
      async (ctx) => {
        await this.ftMove(ctx, signer, this.ids.market, expectedPrice, 'buy');
        const reason = await this.buyRefusal(ctx, signer, tokenId, expectedPrice);
        if (reason) {
          this.emit(ctx, 'buy_refunded', {
            token_id: tokenId,
            buyer_id: signer,
            amount: expectedPrice,
            reason,
          });
          await this.ftMove(ctx, this.ids.market, signer, expectedPrice, 'refund');
          return 'refunded' as const;
        }
        return 'bought' as const;
      },
    );
  }

  /**
   * The market's `ft_on_transfer` and `on_sale`: why the buy is refunded, or null once the NFT has
   * moved with the listing's approval and the seller and treasury are paid.
   */
  private async buyRefusal(
    ctx: CallContext,
    buyer: string,
    tokenId: string,
    amount: bigint,
  ): Promise<string | null> {
    const [listing] = await ctx.tx
      .select()
      .from(simListings)
      .where(eq(simListings.tokenId, tokenId))
      .for('update');
    if (!listing) return 'not_listed';
    if (listing.sellerId === buyer) return 'self_purchase';
    // `sale_in_flight` and `not_enough_gas` can't happen here: a simulated buy is one atomic step.
    if (amount !== listing.price) return 'price_changed';
    try {
      // A nested savepoint, so a refused transfer leaves no trace, as a failed receipt.
      await ctx.tx.transaction(async (inner) => {
        await this.transferToken(
          { ...ctx, tx: inner },
          this.ids.market,
          tokenId,
          buyer,
          listing.approvalId,
        );
      });
    } catch (err) {
      if (err instanceof Panic) return 'transfer_failed';
      throw err;
    }
    await ctx.tx.delete(simListings).where(eq(simListings.tokenId, tokenId));
    const { feeBps } = await this.marketConfig(ctx.tx);
    // Rounded down: the seller keeps the remainder.
    const fee = (listing.price * BigInt(feeBps)) / 10_000n;
    this.emit(ctx, 'sold', {
      token_id: tokenId,
      seller_id: listing.sellerId,
      buyer_id: buyer,
      price: listing.price,
      fee,
    });
    await this.marketPay(ctx, listing.sellerId, listing.price - fee);
    await this.marketPay(ctx, this.ids.treasury, fee);
    return null;
  }

  /** A payout out of the market; one to an unregistered account is kept as owed, as on chain. */
  private async marketPay(ctx: CallContext, receiverId: string, amount: bigint): Promise<void> {
    if (amount === 0n) return;
    if ((await this.ftBalanceIn(ctx.tx, receiverId)) === null) {
      const key = `owed:${this.ids.market}:${receiverId}`;
      const [row] = await ctx.tx.select().from(simAccounts).where(eq(simAccounts.accountId, key));
      const owed = BigInt(row?.kind ?? '0') + amount;
      await ctx.tx
        .insert(simAccounts)
        .values({ accountId: key, kind: owed.toString() })
        .onConflictDoUpdate({ target: simAccounts.accountId, set: { kind: owed.toString() } });
      this.emit(ctx, 'payout_failed', { receiver_id: receiverId, amount, owed_to: receiverId });
      return;
    }
    await this.ftMove(ctx, this.ids.market, receiverId, amount, 'market sale');
    this.emit(ctx, 'payout_sent', { receiver_id: receiverId, amount });
  }

  private async marketConfig(tx: Tx): Promise<{ feeBps: number }> {
    const [row] = await tx
      .select()
      .from(simAccounts)
      .where(eq(simAccounts.accountId, this.marketConfigKey()));
    require_(row !== undefined, 'not_initialized');
    return JSON.parse(row?.kind ?? '{}') as { feeBps: number };
  }

  async getListing(tokenId: string): Promise<Listing | null> {
    const [row] = await this.db.select().from(simListings).where(eq(simListings.tokenId, tokenId));
    return row ?? null;
  }

  async listings(): Promise<Listing[]> {
    return this.db.select().from(simListings).orderBy(asc(simListings.tokenId));
  }

  // ── Explorer ──────────────────────────────────────────────────────────────────────────────────

  txs(filter: TxFilter): Promise<ChainTxView[]> {
    return queryTxs(this.db, filter);
  }

  findByKey(key: string): Promise<ChainTxView | null> {
    return findTxByKey(this.db, key);
  }
}
