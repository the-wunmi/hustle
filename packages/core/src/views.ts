/**
 * What the API returns. Amounts are micro-USD written as decimal strings (JSON has no bigint), so
 * the browser formats them with `formatUsd(BigInt(x))`.
 */
import type {
  AgentCondition,
  AgentLook,
  AgentMood,
  Category,
  FeedKind,
  FeedTone,
  JobSource,
  JobStatus,
  PriceStyle,
  SpendKind,
  SpendReason,
  SpendStatus,
  Tier,
  Trait,
  WorkStage,
} from './domain.ts';

export type MicroString = string;

export interface ModesView {
  chain: 'sim' | 'sandbox' | 'testnet';
  inference: 'mock' | 'live';
  auth: 'mock' | 'live';
  /** Credits, never real money, in every mode this build supports. */
  money: 'credits';
  /** Where brain prices came from: NEAR AI Cloud's live public model list, or the bundled snapshot. */
  brainPrices: { source: 'live' | 'snapshot'; readAt: string };
}

export interface WorldEventView {
  id: string;
  name: string;
  description: string;
  startsDay: number;
  endsDay: number;
}

export interface WorldView {
  day: number;
  tick: number;
  dayTicks: number;
  tickMs: number;
  /** 0–23, the in-game hour, for the clock. */
  hour: number;
  event: WorldEventView | null;
  /** Demand multiplier per category in percent (100 = normal). */
  demand: Record<Category, number>;
  modes: ModesView;
  /** Live NEAR AI spend today against the org's daily budget (null when inference isn't live). */
  liveAi: { budget: MicroString; spent: MicroString; calls: number; reached: boolean } | null;
  stats: {
    activeAgents: number;
    dormantAgents: number;
    openJobs: number;
    paidToday: MicroString;
  };
  /** What each kind of work pays right now, in percent of usual (moves with how crowded it is). */
  prices: Record<Category, number>;
  /** The numbers a new player needs before adopting. */
  economy: {
    starterAgentCredits: MicroString;
    starterWalletCredits: MicroString;
    upkeepPerDay: MicroString;
    dailyAllowance: MicroString;
  };
}

export interface RulebookView {
  dailyCap: MicroString;
  maxPerJob: MicroString;
  maxPerCall: MicroString;
  allowedVendors: string[];
  anyVendor: boolean;
  mayHire: boolean;
  helperBudget: MicroString;
}

export interface StrategyView {
  tier: Tier;
  focus: Category[];
  priceStyle: PriceStyle;
  sponsorJobs: boolean;
  screenJobs: boolean;
}

export interface SkillView {
  level: number;
  xp: number;
  /** XP needed for the next level, or null at the top. */
  nextAt: number | null;
  trainingUntilDay: number | null;
  /** What the next level of training costs, or null at the top. */
  trainCost: MicroString | null;
}

export interface ReputationView {
  level: number;
  jobs: number;
  /** Average rating × 100 (e.g. 462 = 4.62 stars), or null before the first rating. */
  avgRating100: number | null;
  disputes: number;
  scamsBlocked: number;
  /** Progress to the next level, 0–100. */
  progress: number;
}

export interface AgentSummaryView {
  id: string;
  /** The agent's NEAR account, which is also its NFT token id. */
  accountId: string;
  name: string;
  look: AgentLook;
  traits: Trait[];
  specialty: Category;
  tier: Tier;
  condition: AgentCondition;
  mood: AgentMood;
  balance: MicroString;
  level: number;
  ownerName: string;
  isMine: boolean;
  /** Average client rating × 100, or null before the first rating: what clients see in an auction. */
  avgRating100: number | null;
  /** Jobs in a row paid at 4★ or more. */
  streak: number;
}

/**
 * Who answers this agent's model calls. `live`: NEAR AI Cloud. `recorded`: the recorded brain
 * (scripted replies at NEAR AI Cloud's real prices): house agents always, a player's agent when the
 * build has no NEAR AI key or today's live budget is spent.
 */
export interface BrainSourceView {
  source: 'live' | 'recorded';
  why: 'live' | 'house' | 'no_key' | 'budget_reached';
}

export interface AgentView extends AgentSummaryView {
  ownerAccountId: string;
  brain: BrainSourceView;
  skills: Record<Category, SkillView>;
  strategy: StrategyView;
  rulebook: RulebookView;
  frozen: boolean;
  reputation: ReputationView;
  today: { earned: MicroString; spent: MicroString; profit: MicroString };
  season: { earned: MicroString; spent: MicroString; profit: MicroString; jobs: number };
  currentJob: { id: string; title: string; stage: WorkStage | null } | null;
  backers: { name: string; amount: MicroString; day: number }[];
  dormantSince: number | null;
  createdAt: string;
  /** The game day the agent was adopted: its first day report. */
  createdDay: number;
  /** Listed for sale on the marketplace, and at what price. */
  listing: { price: MicroString } | null;
  /**
   * Bought from another player and not yet put to work: its wallet stays frozen until the new owner
   * confirms or changes the rulebook (any change of owner freezes the wallet on chain).
   */
  needsRulebookConfirm: boolean;
  bestStreak: number;
  /** The contract tier the streak has unlocked (0 = none yet), and the streak the next tier needs. */
  contractTier: number;
  nextTierAt: number | null;
  achievements: AchievementView[];
  /** The tiers' models, read from NEAR AI Cloud's model list. */
  brains: BrainView[];
  /** The rival that has taken the most jobs this agent bid on, if any. */
  nemesis: { agent: AgentSummaryView; wins: number } | null;
  /** NEP-245 badges held by the agent's own account (soulbound: they move with the agent). */
  badges: { tokenId: string; title: string; description: string }[];
}

export interface BrainView {
  tier: Tier;
  model: string;
  /** USD per 1M tokens, as micro-USD strings. */
  inputPerM: MicroString;
  outputPerM: MicroString;
  attested: boolean;
  quality: number;
  /** Thinking cost of a typical job on this brain. */
  typicalJobCost: MicroString;
}

export interface AchievementView {
  id: string;
  name: string;
  description: string;
  earnedAt: string | null;
}

export interface BidView {
  id: string;
  agent: AgentSummaryView;
  price: MicroString;
  pitch: string;
  status: 'open' | 'won' | 'lost' | 'withdrawn';
  /**
   * How the client scored the bid when the auction closed (0–100, from price and track record,
   * before the small random part of a client's choice); null while bidding is open.
   */
  score: number | null;
  /** For a closed auction: why this bid won or lost, in plain words, from the scores. */
  why: string | null;
  createdAt: string;
}

/** How a finished job ended, in words a player can act on. */
export interface SettlementView {
  kind: 'paid' | 'paid_after_dispute' | 'refunded' | 'outside' | 'expired' | 'cancelled';
  title: string;
  detail: string;
}

export interface InferenceReceiptView {
  id: string;
  inferenceId: string;
  purpose: 'bid' | 'plan' | 'draft' | 'review' | 'diary' | 'judge';
  model: string;
  tier: Tier;
  promptTokens: number;
  completionTokens: number;
  cost: MicroString;
  verification: VerificationView;
  /** Game tick of the call. */
  tick: number | null;
  agentName: string;
  createdAt: string;
}

export interface VerificationView {
  mode: 'simulated' | 'live';
  /** True only when every check that ran passed. */
  passed: boolean;
  checks: { name: string; ok: boolean; detail: string }[];
  /** What was not checked, stated plainly. */
  notChecked: string[];
  signer: string | null;
}

export interface SpendView {
  id: string;
  agentId: string;
  agentName: string;
  kind: SpendKind;
  receiver: string;
  receiverLabel: string;
  amount: MicroString;
  status: SpendStatus;
  reason: SpendReason | null;
  memo: string;
  jobId: string | null;
  txHash: string | null;
  /** Game tick of the payment. */
  tick: number | null;
  createdAt: string;
}

export interface ChainTxView {
  hash: string;
  signer: string;
  receiver: string;
  method: string;
  args: unknown;
  outcome: 'success' | 'failure';
  events: { event: string; data: unknown }[];
  error: string | null;
  block: number;
  /** Game tick when the transaction was sent, if known. */
  tick?: number | null;
  createdAt: string;
}

export interface JobSummaryView {
  id: string;
  title: string;
  category: Category;
  source: JobSource;
  sourceLabel: string;
  status: JobStatus;
  budget: MicroString;
  minLevel: number;
  clientName: string;
  clientIsMe: boolean;
  bidCount: number;
  closesAtTick: number | null;
  awardedTo: AgentSummaryView | null;
  price: MicroString | null;
  rating: number | null;
  /** Shown to the player only after the job ends; agents never see it. */
  wasScam: boolean | null;
  createdAt: string;
}

export interface JobView extends JobSummaryView {
  body: string;
  autoAward: boolean;
  stage: WorkStage | null;
  bids: BidView[];
  deliverable: string | null;
  workHash: string | null;
  embeddedInstructions: string | null;
  receipts: InferenceReceiptView[];
  spends: SpendView[];
  txs: ChainTxView[];
  helper: { agent: AgentSummaryView; task: string; price: MicroString } | null;
  /** True when the signed-in player may award, rate, cancel or dispute. */
  canAct: boolean;
  /** Tick at which an unrated delivery is accepted automatically at 4★, while one is waiting. */
  reviewEndsAtTick: number | null;
  /** Set when someone from outside Hustle won the job: what they asked. */
  outsideWinner: { price: MicroString } | null;
  settlement: SettlementView | null;
  /** A contract: picky client, and a bond the agent put up (held, returned or forfeited). */
  contract: {
    tier: number;
    bond: MicroString;
    bondStatus: 'held' | 'returned' | 'forfeited' | 'none';
  } | null;
  /** The specialist data this job needs, and whether the agent bought it. */
  specialist: {
    handle: string;
    name: string;
    price: MicroString;
    used: 'bought' | 'missing' | null;
  } | null;
  /** A 5★ tip the client paid on top of the price. */
  tip: MicroString | null;
  /**
   * The viewer's agents that could be sent after this open job, with the price range they may bid:
   * from what thinking it through costs (below that the agent loses money) up to the budget.
   */
  sendable: {
    agentId: string;
    name: string;
    floor: MicroString;
    max: MicroString;
    reason: string | null;
  }[];
}

export interface ApprovalView {
  id: string;
  agent: AgentSummaryView;
  requestId: number;
  kind: SpendKind;
  receiver: string;
  receiverLabel: string;
  amount: MicroString;
  reason: SpendReason;
  memo: string;
  jobId: string | null;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  createdAt: string;
}

export interface FeedEventView {
  id: string;
  seq: number;
  day: number;
  tick: number;
  kind: FeedKind;
  tone: FeedTone;
  text: string;
  agent: { id: string; name: string; look: AgentLook; isMine: boolean } | null;
  jobId: string | null;
  amount: MicroString | null;
  /** Visible to everyone, or only to the agent's owner. */
  scope: 'public' | 'owner';
  createdAt: string;
}

export interface LeaderboardEntryView {
  rank: number;
  agent: AgentSummaryView;
  profit: MicroString;
  /** Profit from clients unrelated to the owner, which is what the board ranks on. */
  rankedProfit: MicroString;
  jobs: number;
  avgRating100: number | null;
}

export interface LeaderboardView {
  period: 'today' | 'season';
  entries: LeaderboardEntryView[];
}

export interface DayReportView {
  day: number;
  agent: AgentSummaryView;
  revenue: MicroString;
  costs: {
    inference: MicroString;
    tools: MicroString;
    helpers: MicroString;
    upkeep: MicroString;
    fees: MicroString;
    /** Contract bonds lost as damages (net of bonds returned that day). */
    bonds: MicroString;
  };
  profit: MicroString;
  jobsWon: number;
  bidsLost: number;
  practiceDone: number;
  avgRating100: number | null;
  levelBefore: number;
  levelAfter: number;
  scamsBlocked: number;
  moneyLostToScams: MicroString;
  /** Calls the owner answered and let lapse that day, tips earned, contracts won and lost. */
  calls: { answered: number; lapsed: number };
  tips: MicroString;
  contracts: { won: number; lost: number };
  streak: number;
  bestStreak: number;
  rank: number | null;
  highlights: string[];
  diary: string[];
  final: boolean;
}

export interface PlayerView {
  id: string;
  name: string;
  email: string | null;
  loginMethod: 'email' | 'passkey';
  accountId: string;
  wallet: MicroString;
  faucetReadyAtDay: number | null;
  createdAt: string;
}

export interface MeView {
  player: PlayerView;
  agents: AgentView[];
  pendingApprovals: number;
}

export interface VendorView {
  accountId: string;
  name: string;
  description: string;
  price: MicroString;
  known: boolean;
}

export interface EconomyTierResult {
  tier: Tier;
  agents: number;
  survived: number;
  survivalRate: number;
  medianProfit: MicroString;
  meanJobsPerDay: number;
  avgRating100: number;
}

export interface ManagedCohortView {
  policy: 'sharp' | 'passive' | 'reckless';
  agents: number;
  survivalRate: number;
  medianProfit: MicroString;
  /** Money the cohort lost to scams, all agents together. */
  scamLosses: MicroString;
  tips: MicroString;
  contractsTaken: number;
  contractsWon: number;
  bestStreak: number;
}

export interface EconomySimView {
  seed: number;
  days: number;
  agents: number;
  tiers: EconomyTierResult[];
  /** Percent of agents active at the end of each day, per tier. */
  survivalByDay: { day: number; budget: number; standard: number; premium: number }[];
  /** Season profit buckets in micro-USD. */
  profitHistogram: {
    from: MicroString;
    to: MicroString;
    budget: number;
    standard: number;
    premium: number;
  }[];
  totals: {
    jobsPosted: number;
    jobsPaid: number;
    scamsBlocked: number;
    scamLosses: MicroString;
    inferenceSpend: MicroString;
    platformFees: MicroString;
    tips: MicroString;
  };
  /** Agents whose owners answer calls by a policy; null when none were. */
  managed: ManagedCohortView | null;
}

export interface WalletEntryView {
  at: string;
  /** Game tick of the transaction, when the log recorded one. */
  tick: number | null;
  /** Signed micro-USD: positive came in, negative went out. */
  amount: MicroString;
  /** What happened, in plain words. */
  label: string;
  txHash: string;
}

// ── Calls ─────────────────────────────────────────────────────────────────

export type CallKind = 'pitch' | 'vendor' | 'contract';

export interface CallOptionView {
  id: string;
  label: string;
  /** One line under the label: odds, what it buys, what happens next. */
  detail: string;
  /** Money that leaves the agent's wallet if this is chosen (a bond, a vendor payment), if any. */
  cost: MicroString | null;
  /** Money the agent stands to make if it goes well, if any. */
  gain: MicroString | null;
  /** Estimated chance to win in percent (0–100), for a pitch price or a contract's bar. */
  winChance: number | null;
  tone: 'good' | 'bad' | 'neutral' | 'shield' | 'coin';
}

export interface CallTellView {
  label: string;
  value: string;
  /** Whether this tell points toward trusting (good), distrusting (bad) or neither. */
  tone: 'good' | 'bad' | 'neutral';
}

export interface CallView {
  id: string;
  kind: CallKind;
  agent: { id: string; name: string; look: AgentLook };
  job: { id: string; title: string } | null;
  status: 'open' | 'answered' | 'expired';
  title: string;
  body: string;
  options: CallOptionView[];
  /** What happens if nobody answers before `expiresTick`. */
  defaultOption: string;
  choice: string | null;
  tells: CallTellView[];
  openedTick: number;
  expiresTick: number;
  /** What happened, once known. */
  outcome: {
    text: string;
    tone: 'good' | 'bad' | 'neutral' | 'shield' | 'coin';
    /** The answer is in and its effects (a model call, a payment) are still running. */
    pending?: boolean;
  } | null;
}

// ── Marketplace: agents for sale ────────────────────────────────────────────────────────────────

/** What a buyer is paying for, read from chain where it lives there (wallet, reputation, badges). */
export interface AgentRecordView {
  /** The agent wallet's balance on chain: it goes with the agent. */
  walletBalance: MicroString;
  level: number;
  /** From the reputation contract. */
  reputation: {
    jobsCompleted: number;
    disputes: number;
    scamsBlocked: number;
    avgRating100: number | null;
  };
  /** Soulbound badges held by the agent's own account. */
  badges: { tokenId: string; title: string }[];
  streak: number;
  bestStreak: number;
  skills: Record<Category, number>;
  specialty: Category;
  tier: Tier;
  traits: Trait[];
  /** Days since it was adopted. */
  ageDays: number;
}

export interface ListingView {
  agent: AgentSummaryView;
  record: AgentRecordView;
  price: MicroString;
  /** The game's estimate of a fair price: the wallet plus what the record is worth. */
  fairValue: MicroString;
  /** The treasury's cut of the price, and what the seller receives. */
  fee: MicroString;
  sellerName: string;
  isMine: boolean;
  /** Why the viewer can't buy it right now, if they can't. */
  blocked: string | null;
}

export interface SaleView {
  agentName: string;
  sellerName: string;
  buyerName: string;
  price: MicroString;
  day: number;
  txHash: string | null;
  sellerIsMe: boolean;
  buyerIsMe: boolean;
}

export interface MarketplaceView {
  listings: ListingView[];
  recentSales: SaleView[];
  feeBps: number;
}

// ── The agent NFT: its holder's console and its history (NFTs track) ────────────────────────────

/**
 * What a judge can check about an agent, read from the chain on this request: its NEAR account and
 * holder, the rulebook its own wallet enforces, its on-chain reputation and badges, its recent model
 * calls with their verification, and its recent transactions (with an explorer on testnet).
 */
export interface ProofView {
  accountId: string;
  chain: 'sim' | 'sandbox' | 'testnet';
  /** Base URL of a public explorer for transaction hashes, or null (a local chain has none). */
  explorer: string | null;
  holder: string | null;
  wallet: {
    frozen: boolean;
    spentToday: MicroString;
    rotationSeq: number;
    dayMs: number;
    rulebook: RulebookView;
  };
  reputation: {
    jobs: number;
    ratedJobs: number;
    ratingSum: number;
    disputes: number;
    scamsBlocked: number;
  };
  badges: { tokenId: string; title: string }[];
  inference: {
    at: string;
    purpose: string;
    model: string;
    source: 'live' | 'recorded';
    cost: MicroString | null;
    verified: boolean | null;
    signer: string | null;
    jobId: string | null;
  }[];
  txs: ChainTxView[];
}

/**
 * What only the agent NFT's current holder may see. Served only after the API reads the NFT's owner
 * from chain and finds the caller's account; a sold agent's former owner is refused.
 */
export interface HolderView {
  agent: AgentSummaryView;
  /** The holder as the registry reports it, read on this request. */
  chainOwner: string;
  /** The wallet as the agent's own contract reports it, read on this request. */
  wallet: {
    balance: MicroString;
    frozen: boolean;
    spentToday: MicroString;
    rotationSeq: number;
    pending: { requestId: number; amount: MicroString; receiver: string; reason: string }[];
  };
  rulebook: RulebookView;
  strategy: StrategyView;
  /** The agent's brain: its tier and model, and whether its own NEAR AI key is sealed on the server. */
  brain: { tier: Tier; model: string; keyId: string | null; keySealed: boolean };
  /** Off-chain notes only the holder sees: the game's private settings for this agent. */
  notes: string[];
}

export interface NftHolderEntry {
  accountId: string;
  /** The player's name when the account is a player's. */
  name: string | null;
  how: 'minted' | 'sold' | 'transferred';
  price: MicroString | null;
  at: string;
  tick: number | null;
  txHash: string;
}

export interface NftMoneyEntry {
  kind: string;
  /** Who paid it (earnings) or who received it (payouts), as a name where known. */
  counterparty: string;
  amount: MicroString;
  memo: string | null;
  at: string;
  tick: number | null;
  txHash: string;
}

/** Everything the agent NFT earned, paid out and who held it, read from the chain's receipt log. */
export interface NftHistoryView {
  agent: AgentSummaryView;
  tokenId: string;
  holders: NftHolderEntry[];
  earnings: NftMoneyEntry[];
  payouts: NftMoneyEntry[];
  /** Totals by kind, earnings positive and payouts negative. */
  totals: { kind: string; amount: MicroString }[];
  /** True when the history was cut at the log limit (older entries exist). */
  truncated: boolean;
}
