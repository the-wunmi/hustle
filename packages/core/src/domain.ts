import { z } from 'zod';
import { type Micro, MicroAmount, usd } from './money.ts';

// ── Work categories (also the skills an agent can train) ────────────────────────────────────────

export const CATEGORIES = [
  'summary',
  'translation',
  'research',
  'data_cleanup',
  'code_review',
  'copywriting',
] as const;
export const Category = z.enum(CATEGORIES);
export type Category = z.infer<typeof Category>;

export const CATEGORY_LABEL: Record<Category, string> = {
  summary: 'Summaries',
  translation: 'Translation',
  research: 'Research',
  data_cleanup: 'Data cleanup',
  code_review: 'Code review',
  copywriting: 'Copywriting',
};

/** Skill levels an agent can reach in one category. */
export const MAX_SKILL_LEVEL = 3;

// ── Personality ─────────────────────────────────────────────────────────────────────────────────

export const TRAITS = [
  'meticulous',
  'fast_and_loose',
  'charming',
  'frugal',
  'bold',
  'skeptical',
] as const;
export const Trait = z.enum(TRAITS);
export type Trait = z.infer<typeof Trait>;

export const TRAIT_LABEL: Record<Trait, string> = {
  meticulous: 'Meticulous',
  fast_and_loose: 'Fast and loose',
  charming: 'Charming negotiator',
  frugal: 'Frugal',
  bold: 'Bold',
  skeptical: 'Skeptical',
};

/**
 * Traits as one phrase for running text: the first capitalised, the rest in lower case, joined by
 * commas ("Fast and loose, charming negotiator"), since a label can itself contain "and".
 */
export function traitPhrase(traits: readonly Trait[]): string {
  return traits.map((t, i) => (i === 0 ? TRAIT_LABEL[t] : TRAIT_LABEL[t].toLowerCase())).join(', ');
}

export const TRAIT_BLURB: Record<Trait, string> = {
  meticulous: 'Checks everything twice. Better ratings, slower, spends a little more on review.',
  fast_and_loose:
    'Grabs jobs quickly and cuts corners. More wins, shakier ratings, falls for tricks.',
  charming: 'Writes bids clients like. Wins ties and can charge a bit more.',
  frugal: 'Hates spending. Skips paid tools when it can and bids low.',
  bold: 'Chases big jobs above its level. High risk, high reward.',
  skeptical: 'Reads job posts for traps. Hard to scam, sometimes turns down good work.',
};

// ── Brains ──────────────────────────────────────────────────────────────────────────────────────

export const TIERS = ['budget', 'standard', 'premium'] as const;
export const Tier = z.enum(TIERS);
export type Tier = z.infer<typeof Tier>;

export const TIER_LABEL: Record<Tier, string> = {
  budget: 'Budget brain',
  standard: 'Standard brain',
  premium: 'Premium brain',
};

// ── Looks ───────────────────────────────────────────────────────────────────────────────────────

export const BODIES = ['bolt', 'orb', 'boxy', 'tall', 'squat', 'antenna'] as const;
export const Body = z.enum(BODIES);
export type Body = z.infer<typeof Body>;

export const COLORS = ['tomato', 'marigold', 'mint', 'sky', 'grape', 'bubblegum'] as const;
export const Color = z.enum(COLORS);
export type Color = z.infer<typeof Color>;

export const AgentLook = z.object({ body: Body, color: Color });
export type AgentLook = z.infer<typeof AgentLook>;

// ── Agent name ──────────────────────────────────────────────────────────────────────────────────

/** Short enough for the feed and the leaderboard on a phone. */
export const MAX_AGENT_NAME = 16;
export const AgentName = z
  .string()
  .trim()
  .min(2)
  .max(MAX_AGENT_NAME)
  .regex(/^[\p{L}\p{N}][\p{L}\p{N} '-]*$/u, "Use letters, numbers, spaces, - or '");

// ── Rulebook (mirrors the agent wallet contract) ───────────────────────────────────────────────

/** A vendor or wallet account id: NEAR account id rules, short enough to show. */
export const AccountId = z
  .string()
  .min(2)
  .max(64)
  .regex(/^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/);

/** Bounds the allowlist the contract stores, which the wallet pays storage for. */
export const MAX_ALLOWED_VENDORS = 12;

export const Rulebook = z.object({
  dailyCap: MicroAmount,
  maxPerJob: MicroAmount,
  maxPerCall: MicroAmount,
  allowedVendors: z.array(AccountId).max(MAX_ALLOWED_VENDORS),
  anyVendor: z.boolean(),
  mayHire: z.boolean(),
  helperBudget: MicroAmount,
});
export type Rulebook = z.infer<typeof Rulebook>;

/** The rulebook a new agent starts with: tight enough to block the usual scams, loose enough to work. */
export function defaultRulebook(knownVendors: string[]): Rulebook {
  return {
    dailyCap: usd('1.50'),
    maxPerJob: usd('0.40'),
    maxPerCall: usd('0.25'),
    allowedVendors: knownVendors.slice(0, MAX_ALLOWED_VENDORS),
    anyVendor: false,
    mayHire: true,
    helperBudget: usd('0.10'),
  };
}

// ── Strategy (off-chain, the player's management choices) ──────────────────────────────────────

export const PRICE_STYLES = ['undercut', 'fair', 'premium'] as const;
export const PriceStyle = z.enum(PRICE_STYLES);
export type PriceStyle = z.infer<typeof PriceStyle>;

export const Strategy = z.object({
  tier: Tier,
  /** Categories the agent chases. Empty means any category it has skill in. */
  focus: z.array(Category).max(3),
  priceStyle: PriceStyle,
  /** Bid on sponsor bounties. */
  sponsorJobs: z.boolean(),
  /** Code reads each job post for payment instructions before the model sees it. */
  screenJobs: z.boolean(),
});
export type Strategy = z.infer<typeof Strategy>;

export function defaultStrategy(specialty: Category): Strategy {
  return {
    tier: 'standard',
    focus: [specialty],
    priceStyle: 'fair',
    sponsorJobs: true,
    screenJobs: false,
  };
}

// ── Jobs ────────────────────────────────────────────────────────────────────────────────────────

export const JOB_SOURCES = ['practice', 'player', 'client', 'sponsor'] as const;
export const JobSource = z.enum(JOB_SOURCES);
export type JobSource = z.infer<typeof JobSource>;

export const JOB_STATUSES = [
  /** Written, its budget on its way into escrow (or in doubt until the chain answers). */
  'posting',
  'open',
  'awarded',
  'working',
  'delivered',
  'paid',
  'disputed',
  'refunded',
  'cancelled',
  'expired',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** The stages an awarded job moves through, one per world tick, each with its own outside effect. */
export const WORK_STAGES = [
  'plan',
  'tools',
  'helper',
  'draft',
  'deliver',
  'review',
  'settle',
] as const;
export type WorkStage = (typeof WORK_STAGES)[number];

/** Longest job text a player can post. Caps what a model reads, so nobody can run up an agent's bill. */
export const MAX_JOB_BODY = 4_000;
export const MAX_JOB_TITLE = 80;

// ── Spending ────────────────────────────────────────────────────────────────────────────────────

/** `bond`: collateral for a contract job, paid only to the treasury. */
export const SPEND_KINDS = ['inference', 'tool', 'helper', 'upkeep', 'bond'] as const;
export type SpendKind = (typeof SPEND_KINDS)[number];

export const SPEND_STATUSES = ['settled', 'pending', 'blocked', 'failed'] as const;
export type SpendStatus = (typeof SPEND_STATUSES)[number];

/** Reason codes from the agent wallet contract. */
export const SPEND_REASONS = [
  'frozen',
  'vendor_not_allowed',
  'hiring_disabled',
  'self_payment',
  'over_call_cap',
  'over_job_cap',
  'over_daily_cap',
  'over_helper_budget',
  'approval_queue_full',
  'transfer_failed',
] as const;
export type SpendReason = (typeof SPEND_REASONS)[number];

export const SPEND_REASON_TEXT: Record<SpendReason, string> = {
  frozen: 'the wallet is frozen',
  vendor_not_allowed: 'payment to a vendor that is not on the rulebook',
  hiring_disabled: 'hiring is switched off in the rulebook',
  self_payment: 'an agent cannot pay itself',
  over_call_cap: 'over the per-payment cap',
  over_job_cap: 'over the per-job cap',
  over_daily_cap: 'over the daily cap',
  over_helper_budget: 'over the helper budget',
  approval_queue_full: 'too many requests are waiting for approval',
  transfer_failed: 'the transfer failed',
};

// ── Agent condition ─────────────────────────────────────────────────────────────────────────────

export type AgentCondition = 'thriving' | 'struggling' | 'dormant';
export type AgentMood = 'idle' | 'busy' | 'celebrating' | 'stressed' | 'sleeping';

// ── Feed ────────────────────────────────────────────────────────────────────────────────────────

export const FEED_KINDS = [
  'minted',
  'job_posted',
  'bid',
  'bid_won',
  'bid_lost',
  'work',
  'inference',
  'tool_bought',
  'helper_hired',
  'delivered',
  'rated',
  'paid',
  'refunded',
  'spend_blocked',
  'approval_requested',
  'approval_resolved',
  'scam_spotted',
  'dormant',
  'revived',
  'backed',
  'upkeep',
  'level_up',
  'skill_trained',
  'diary',
  'day_ended',
  'event',
  'wallet',
  'transfer',
] as const;
export type FeedKind = (typeof FEED_KINDS)[number];

export type FeedTone = 'good' | 'bad' | 'neutral' | 'shield' | 'money';

export type { Micro };
