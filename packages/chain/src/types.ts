import type { ChainTxView, Rulebook, SpendKind, SpendReason } from '@hustle/core';

export interface SpendRequest {
  /** Idempotency key: a repeated key returns the first outcome and moves money once. */
  key: string;
  kind: SpendKind;
  receiverId: string;
  amount: bigint;
  jobId: string | null;
  memo: string;
  receipt: string | null;
}

export interface SpendOutcome {
  status: 'settled' | 'pending' | 'blocked' | 'failed';
  /** The approval request's id: set only when `status` is `pending`. */
  requestId: number | null;
  reason: SpendReason | null;
  txHash: string;
}

export interface PendingApproval {
  id: number;
  request: SpendRequest;
  reason: SpendReason;
}

export interface WalletState {
  ownerId: string;
  rulebook: Rulebook;
  frozen: boolean;
  dayMs: number;
  day: number;
  spentToday: bigint;
  pending: PendingApproval[];
  rotationSeq: number;
}

export interface ChainJob {
  jobId: string;
  clientId: string;
  budget: bigint;
  price: bigint | null;
  agentId: string | null;
  /**
   * `settling` and `payout_failed` only exist on a real chain: a settled job stays while its payout
   * receipts are in flight, or until `retry_payout` resends a failed one.
   */
  status: 'open' | 'awarded' | 'delivered' | 'disputed' | 'settling' | 'payout_failed';
  workHash: string | null;
  /** After award, the agent must deliver within this, or anyone may `reclaimUndelivered`. */
  deliveryWindowMs: number;
  awardedAtMs: number | null;
}

export interface Reputation {
  /** Jobs paid out: accepted, released after the review window, or a dispute won. */
  jobs: number;
  ratingSum: number;
  /** Jobs that carried a rating; a dispute won pays without one, so average over this, not `jobs`. */
  ratedJobs: number;
  disputes: number;
  scamsBlocked: number;
}

/** An agent for sale on the market: the registry approved the market for it at `approvalId`. */
export interface Listing {
  tokenId: string;
  sellerId: string;
  price: bigint;
  approvalId: number;
}

export interface TxResult<T = undefined> {
  txHash: string;
  value: T;
}

export interface ChainIds {
  root: string;
  credits: string;
  registry: string;
  jobs: string;
  rep: string;
  operator: string;
  treasury: string;
  /** Parent of vendor accounts: `<handle>.vendors.<root>`. */
  vendors: string;
  /** Soulbound NEP-245 badges, held by agent wallets. */
  badges: string;
  /** The agent market: listings by NEP-178 approval, bought with credits. */
  market: string;
}

/** A badge type the badges contract knows: what an agent earned, not something to trade. */
export interface BadgeType {
  /** 1..=64 chars of `[a-z0-9_-]`. */
  tokenId: string;
  /** 1..=64 chars. */
  title: string;
  /** Up to 256 chars. */
  description: string;
}

/** A contract call that panicked. `code` is the contract's snake_case error. */
export class ChainError extends Error {
  constructor(
    readonly code: string,
    readonly txHash: string | null,
  ) {
    super(`Chain call failed: ${code}`);
    this.name = 'ChainError';
  }
}

/** What `ensureSetup` deploys: the game's economy settings, vendors and badge types. */
export interface ChainSetup {
  feeBps: number;
  /** The market's cut of each sale, in basis points (at most 2000), rounded down. */
  marketFeeBps: number;
  dayMs: number;
  vendorHandles: string[];
  /** Registered (or updated) on every call, so new types reach an existing deployment. */
  badges?: BadgeType[];
  /**
   * Publish the wallet code as a global contract so new agents don't each store a copy (default
   * true). Off keeps every mint at about 2 NEAR but skips the one-off 10x burn.
   */
  globalWalletCode?: boolean;
}

/**
 * Everything the game asks of the chain. Owner actions take the signer (the player's account): in
 * production the player signs a delegate action and our relayer submits it; see `relayer.ts`.
 */
export interface ChainGateway {
  readonly mode: 'sim' | 'sandbox' | 'testnet';
  readonly ids: ChainIds;
  /** Deploys and initialises the contracts if they aren't yet (idempotent). */
  ensureSetup(cfg: ChainSetup): Promise<unknown>;
  /** Creates a player or vendor account and registers it with the credits token. */
  createAccount(accountId: string): Promise<TxResult>;
  /** Sandbox faucet: credits minted by the token owner. */
  mintCredits(accountId: string, amount: bigint, key: string): Promise<TxResult>;
  ftBalance(accountId: string): Promise<bigint>;
  ftTransfer(
    signer: string,
    receiverId: string,
    amount: bigint,
    memo: string,
    key: string,
  ): Promise<TxResult>;

  mintAgent(
    ownerId: string,
    name: string,
    metadata: Record<string, unknown>,
    rulebook: Rulebook,
    key: string,
  ): Promise<TxResult<string>>;
  nftTransfer(signer: string, tokenId: string, receiverId: string): Promise<TxResult>;
  nftOwner(tokenId: string): Promise<string | null>;
  setRulebook(signer: string, tokenId: string, rulebook: Rulebook): Promise<TxResult>;
  approveSpend(signer: string, tokenId: string, requestId: number): Promise<TxResult<SpendOutcome>>;
  denySpend(signer: string, tokenId: string, requestId: number): Promise<TxResult>;
  /**
   * To the current holder. Refused with `listed` while the agent is listed: cancel the listing first.
   * Once per key, like every keyed call.
   */
  withdraw(signer: string, tokenId: string, amount: bigint, key: string): Promise<TxResult>;
  setFrozen(signer: string, tokenId: string, frozen: boolean): Promise<TxResult>;
  spend(walletId: string, request: SpendRequest): Promise<SpendOutcome>;
  getWallet(walletId: string): Promise<WalletState>;

  /** `ft_transfer_call` into escrow. Returns null when the board refunded the budget. */
  postJob(
    signer: string,
    budget: bigint,
    msg: {
      jobKey: string;
      specHash: string;
      autoAward: boolean;
      reviewWindowMs: number;
      /** Deadline to deliver after award; the board defaults to one day (60_000 ms..7 days). */
      deliveryWindowMs?: number;
    },
  ): Promise<TxResult<string | null>>;
  award(signer: string, jobId: string, agentId: string, price: bigint): Promise<TxResult>;
  deliver(jobId: string, agentId: string, workHash: string): Promise<TxResult>;
  accept(signer: string, jobId: string, rating: number): Promise<TxResult>;
  releaseExpired(signer: string, jobId: string): Promise<TxResult>;
  dispute(signer: string, jobId: string): Promise<TxResult>;
  resolve(jobId: string, refund: boolean): Promise<TxResult>;
  cancel(signer: string, jobId: string): Promise<TxResult>;
  /** Anyone; refunds the client once an awarded job is past its delivery window undelivered. */
  reclaimUndelivered(signer: string, jobId: string): Promise<TxResult>;
  /**
   * Anyone; redirects an agent payout that is still failing one delivery window after settlement to
   * the client. Only a real chain has failed payouts.
   */
  reclaimFailedPayout(signer: string, jobId: string): Promise<TxResult>;
  getJob(jobId: string): Promise<ChainJob | null>;

  /** Once per key (default `scam:<agent>:<job>`): pass a key per blocked payment to count each. */
  recordScamBlocked(agentId: string, jobId: string, key?: string): Promise<TxResult>;
  /**
   * Operator mints one badge to an agent wallet. Resolves false (and changes nothing) if the agent
   * already holds it: each agent holds at most one of each.
   */
  mintBadge(agentId: string, tokenId: string, memo: string | null): Promise<TxResult<boolean>>;
  badgesOf(agentId: string): Promise<BadgeType[]>;
  getReputation(agentId: string): Promise<Reputation>;

  /**
   * Lists the signer's agent: registry `nft_approve(market, {price})` with the approval's storage
   * deposit. Listing again replaces the price (and the approval id). Returns the listing as stored.
   */
  listAgent(signer: string, tokenId: string, price: bigint): Promise<TxResult<Listing>>;
  /** The seller: `market.cancel_listing`, then registry `nft_revoke(market)` if they still hold it. */
  cancelListing(signer: string, tokenId: string): Promise<TxResult>;
  /**
   * credits `ft_transfer_call(market, expectedPrice, {token_id, expected_price})`. 'refunded' when
   * the market returned the credits (not listed, price changed, the transfer failed). A repeated
   * `key` returns the first call's result and sends nothing.
   */
  buyAgent(
    signer: string,
    tokenId: string,
    expectedPrice: bigint,
    key: string,
  ): Promise<TxResult<'bought' | 'refunded'>>;
  getListing(tokenId: string): Promise<Listing | null>;
  listings(): Promise<Listing[]>;

  /** Transactions touching a job id or an account, newest first: the explorer view. */
  txs(filter: TxFilter): Promise<ChainTxView[]>;
  /** Reconciliation for a call with no answer: did a transaction with this key land? */
  findByKey(key: string): Promise<ChainTxView | null>;
}

/**
 * Which transactions to list. `jobId` is the job board's id; `gameJobId` is the game's own job id,
 * which agent-wallet spends carry in their request, so a job's model calls and tool buys show too.
 */
export interface TxFilter {
  jobId?: string;
  gameJobId?: string;
  account?: string;
  limit: number;
}

/** A keyed transaction signed and about to be broadcast: what an in-doubt call is resolved from. */
export interface PendingTx {
  key: string;
  hash: string;
  signer: string;
  receiver: string;
  method: string;
  args: unknown;
  /** The signed transaction (base64), so the same transaction can be broadcast again. */
  signed: string;
}

/** A finished keyed call, with the value the contract returned (for replaying it to a retry). */
export interface SettledTx extends ChainTxView {
  result: unknown;
}

/**
 * Where a gateway records the transactions it sends, so the explorer view and in-doubt
 * reconciliation survive a restart (a local NEAR node has no indexer to ask). A keyed transaction
 * is noted as pending before it is broadcast, so a process that dies before the answer arrives
 * leaves its hash behind for the node to be asked about.
 */
export interface TxLog {
  record(
    tx: ChainTxView & {
      key: string | null;
      chainBlock: number | null;
      timestampMs: number;
      result: unknown;
    },
  ): Promise<void>;
  txs(filter: TxFilter): Promise<ChainTxView[]>;
  findByKey(key: string): Promise<ChainTxView | null>;
  /** The successful transaction with this key and its returned value, if there is one. */
  settledByKey(key: string): Promise<SettledTx | null>;
  notePending(tx: PendingTx): Promise<void>;
  pendingByKey(key: string): Promise<PendingTx | null>;
  dropPending(hash: string): Promise<void>;
}
