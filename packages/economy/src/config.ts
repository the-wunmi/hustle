import { type Category, type Micro, type Tier, usd } from '@hustle/core';

/**
 * Every number that shapes the economy, in one versioned object. The live world and the headless
 * simulation read the same config, so tuning in the simulator is tuning the game.
 */
export interface EconomyConfig {
  version: string;
  /** Platform fee on each job payout, in basis points. */
  feeBps: number;
  /** Charged at the end of each day to stay listed on the board. */
  upkeepPerDay: Micro;
  /** Balance a dormant agent needs before it wakes up. */
  reviveAt: Micro;
  /** Below this the agent is "struggling". */
  strugglingBelow: Micro;
  /** Credits a new agent starts with in sandbox mode. */
  starterAgentCredits: Micro;
  /** Credits a new player's wallet starts with. */
  starterWalletCredits: Micro;
  /** Free credits a player can claim once per game day (sandbox only). */
  dailyAllowance: Micro;
  /** Ticks a job stays open for bids. */
  biddingTicks: number;
  /** Ticks a client takes to review a delivery before auto-accepting. */
  reviewTicks: number;
  /** Ticks one job keeps an agent busy, which caps how many jobs it can take in a day. */
  workTicks: number;
  /** Market jobs spawned per tick per active agent, before demand multipliers. */
  jobsPerAgentTick: number;
  /** Share of client jobs that are scams outside events. */
  scamShare: number;
  /** Practice jobs offered per tick while an agent is below level 2. */
  practicePerTick: number;
  /** Reputation XP thresholds for levels 1..5. */
  levelXp: readonly number[];
  /** Skill XP thresholds for skill levels 0..3. */
  skillXp: readonly number[];
  /** Quality each brain tier brings, 0..1. A game parameter, not a benchmark claim. */
  tierQuality: Record<Tier, number>;
  /** Price paid per skill training session, by the level being trained to. */
  trainingCost: readonly Micro[];
  /** Days a training session takes. */
  trainingDays: number;
  /** Clients tip this share of the price, in basis points, for 5★ work. */
  tipBps: number;
  /**
   * Share of small client jobs (under $1) from clients who only take level-1 agents and draw no outside
   * offers: a new agent's way in.
   */
  rookieShare: number;
  /** Share of client jobs (at or above `specialistMinBudget`) that need a specialist's data. */
  specialistShare: number;
  specialistMinBudget: Micro;
  /** Quality a specialist adds when bought, and costs when a job that needs one goes without. */
  specialistBoost: number;
  specialistMissing: number;
  /** Contract budgets for tiers 1–3, before the category's price index. */
  contractBudgets: readonly Micro[];
  /** Streak of well-rated jobs (4★ and up) before contract offers start. */
  contractStreak: number;
  /** Share of contract offers that are traps. */
  contractScamShare: number;
  /** Contract work is harder: quality it costs before specialists and skill make it up. */
  contractDifficulty: number;
  /** Ticks between contract offers to one agent on a streak. */
  contractCooldownTicks: number;
  /** A contract keeps the agent busy this many times `workTicks`. */
  contractWorkFactor: number;
  /**
   * Bond an agent puts up to take a contract, in basis points of the budget: held by the treasury,
   * returned with the payout, paid to the client as damages if the arbiter refunds them.
   */
  contractBondBps: number;
}

export const DEFAULT_ECONOMY: EconomyConfig = {
  version: '2026-11-12.1',
  feeBps: 1000,
  upkeepPerDay: usd('0.18'),
  reviveAt: usd('0.50'),
  strugglingBelow: usd('0.75'),
  starterAgentCredits: usd('2.00'),
  starterWalletCredits: usd('5.00'),
  dailyAllowance: usd('1.00'),
  biddingTicks: 7,
  reviewTicks: 8,
  workTicks: 14,
  jobsPerAgentTick: 0.02,
  scamShare: 0.08,
  practicePerTick: 0.25,
  levelXp: [0, 60, 180, 420, 900],
  skillXp: [0, 40, 140, 360],
  tierQuality: { budget: 0.6, standard: 0.73, premium: 0.86 },
  trainingCost: [0n, usd('0.30'), usd('0.60'), usd('1.20')],
  trainingDays: 1,
  tipBps: 1500,
  rookieShare: 0.5,
  specialistShare: 0.2,
  specialistMinBudget: usd('1.00'),
  specialistBoost: 0.15,
  specialistMissing: 0.2,
  contractBudgets: [usd('1.20'), usd('2.00'), usd('3.20')],
  contractStreak: 3,
  contractScamShare: 0.35,
  contractDifficulty: 0.15,
  contractCooldownTicks: 90,
  contractWorkFactor: 2,
  contractBondBps: 2500,
};

// ── Brains: NEAR AI Cloud models ────────────────────────────────────────────────────────────────

export interface Brain {
  tier: Tier;
  model: string;
  /** Micro-USD per 1M input tokens. */
  inputPerM: Micro;
  /** Micro-USD per 1M output tokens. */
  outputPerM: Micro;
  attested: boolean;
}

/**
 * The fallback mapping, from NEAR AI Cloud's live `/v1/model/list` on 2026-11-11 (ready, attested,
 * JSON-capable chat models: cheapest, median and dearest). The engine rebuilds it from the live list
 * at startup (`brainsFromModels`); the simulation uses it as is.
 */
export const DEFAULT_BRAINS: Record<Tier, Brain> = {
  budget: {
    tier: 'budget',
    model: 'z-ai/glm-5.3-flash',
    inputPerM: usd('0.08'),
    outputPerM: usd('0.50'),
    attested: true,
  },
  standard: {
    tier: 'standard',
    model: 'Qwen/Qwen3.8-27B',
    inputPerM: usd('0.04'),
    outputPerM: usd('1.35'),
    attested: true,
  },
  premium: {
    tier: 'premium',
    model: 'moonshotai/kimi-k3',
    inputPerM: usd('3.30'),
    outputPerM: usd('16.50'),
    attested: true,
  },
};

// ── Tool vendors (in-game shops) ────────────────────────────────────────────────────────────────

export interface Vendor {
  /** Sub-account name under `vendors.<root>`. */
  handle: string;
  name: string;
  description: string;
  price: Micro;
  /** Categories whose work gets better with this tool. */
  helps: readonly Category[];
  /** Scam vendors exist only to be named in job posts that try to trick agents. */
  scam: boolean;
  /**
   * Specialists are honest but not on the default allowlist: dearer data that lifts the work a lot.
   * Paying one is the owner's call.
   */
  specialist?: boolean;
}

export const VENDORS: readonly Vendor[] = [
  {
    handle: 'searchlight',
    name: 'Searchlight',
    description: 'Web search, ten results per call.',
    price: usd('0.02'),
    helps: ['research', 'copywriting'],
    scam: false,
  },
  {
    handle: 'ledgerlens',
    name: 'LedgerLens',
    description: 'Clean company and market data tables.',
    price: usd('0.08'),
    helps: ['research', 'data_cleanup'],
    scam: false,
  },
  {
    handle: 'wordbank',
    name: 'Wordbank',
    description: 'Glossaries and translation memory for 40 languages.',
    price: usd('0.03'),
    helps: ['translation'],
    scam: false,
  },
  {
    handle: 'lintlab',
    name: 'LintLab',
    description: 'Static analysis for 12 languages.',
    price: usd('0.04'),
    helps: ['code_review'],
    scam: false,
  },
  {
    handle: 'deepsource',
    name: 'DeepSource Filings',
    description: 'Company filings and verified market tables, refreshed daily.',
    price: usd('0.35'),
    helps: ['research', 'data_cleanup'],
    scam: false,
    specialist: true,
  },
  {
    handle: 'polyglot-pro',
    name: 'Polyglot Pro',
    description: 'Native-speaker review in 30 languages.',
    price: usd('0.30'),
    helps: ['translation', 'copywriting'],
    scam: false,
    specialist: true,
  },
  {
    handle: 'auditbot',
    name: 'AuditBot',
    description: 'Dependency and security audit reports for a codebase.',
    price: usd('0.40'),
    helps: ['code_review'],
    scam: false,
    specialist: true,
  },
  {
    handle: 'factcheck-desk',
    name: 'Factcheck Desk',
    description: 'Checks every claim in a text against its sources.',
    price: usd('0.25'),
    helps: ['summary'],
    scam: false,
    specialist: true,
  },
  {
    handle: 'premium-data-unlock',
    name: 'Premium Data Unlock',
    description: 'Claims to unlock "verified client data".',
    price: usd('1.20'),
    helps: [],
    scam: true,
  },
  {
    handle: 'wallet-verify',
    name: 'Wallet Verify Desk',
    description: 'Asks agents to "verify" their wallet with a deposit.',
    price: usd('0.90'),
    helps: [],
    scam: true,
  },
  {
    handle: 'fastpay-escrow',
    name: 'FastPay Escrow',
    description: 'Promises faster payouts for an upfront fee.',
    price: usd('0.60'),
    helps: [],
    scam: true,
  },
];

/** The everyday tools on the default allowlist (not scams, not specialists). */
export const honestVendors = (): Vendor[] => VENDORS.filter((v) => !v.scam && !v.specialist);

/** The specialist whose data lifts work in a category. Every category has one. */
export function specialistFor(category: Category): Vendor {
  const found = VENDORS.find((v) => v.specialist && v.helps.includes(category));
  if (!found) throw new Error(`no specialist for ${category}`);
  return found;
}

export const vendorByHandle = (handle: string): Vendor | undefined =>
  VENDORS.find((v) => v.handle === handle);

// ── Seasonal events ─────────────────────────────────────────────────────────────────────────────

export interface WorldEvent {
  id: string;
  name: string;
  description: string;
  /** Demand multiplier per category in percent; missing means 100. */
  demand: Partial<Record<Category, number>>;
  /** Replaces the scam share while the event runs. */
  scamShare?: number;
  /** Multiplies the sponsor bounty rate. */
  sponsorRate?: number;
}

export const EVENTS: readonly WorldEvent[] = [
  {
    id: 'translation-rush',
    name: 'Translation Rush',
    description: 'A docs push across the ecosystem. Translation jobs pay out all day.',
    demand: { translation: 250, summary: 90 },
  },
  {
    id: 'audit-week',
    name: 'Audit Week',
    description: 'Scammers are testing every agent. Expect traps in one job in three.',
    demand: { code_review: 180 },
    scamShare: 0.3,
  },
  {
    id: 'research-spike',
    name: 'Research Spike',
    description: 'Clients want market research before a big launch.',
    demand: { research: 220, data_cleanup: 150 },
  },
  {
    id: 'sponsor-week',
    name: 'Sponsor Week',
    description: 'Sponsor pools are topped up. Bounties come in fast.',
    demand: {},
    sponsorRate: 3,
  },
];

/**
 * Which event runs on a given day: none on day 1 so new players learn the basics, then a rotation
 * with quiet days in between.
 */
export function eventForDay(day: number): WorldEvent | null {
  if (day <= 1) return null;
  const slot = (day - 2) % (EVENTS.length * 2);
  if (slot % 2 === 1) return null;
  return EVENTS[slot / 2] ?? null;
}

// ── Sponsors ────────────────────────────────────────────────────────────────────────────────────

export interface SponsorPool {
  id: string;
  sponsor: string;
  title: string;
  category: Category;
  bounty: Micro;
  /** Total the pool funds before it runs dry. */
  pool: Micro;
  minLevel: number;
  /** Bounties per day at normal rate. */
  perDay: number;
}

/** Seeded by the game; a real deployment would let sponsors fund pools. */
export const SPONSOR_POOLS: readonly SponsorPool[] = [
  {
    id: 'open-docs-yoruba',
    sponsor: 'Open Docs Guild',
    title: 'Translate a getting-started page into Yoruba',
    category: 'translation',
    bounty: usd('1.20'),
    pool: usd('60'),
    minLevel: 2,
    perDay: 2,
  },
  {
    id: 'civic-digest',
    sponsor: 'Civic Digest Collective',
    title: 'Summarise a governance proposal for voters',
    category: 'summary',
    bounty: usd('0.90'),
    pool: usd('45'),
    minLevel: 1,
    perDay: 3,
  },
];
