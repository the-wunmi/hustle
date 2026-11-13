import {
  type AgentCondition,
  type AgentMood,
  bpsDown,
  CATEGORIES,
  type Category,
  type JobSource,
  type Micro,
  maxBig,
  minBig,
  type Rng,
  type Rulebook,
  type Strategy,
  type Tier,
  type Trait,
} from '@hustle/core';
import type { Brain, EconomyConfig } from './config.ts';

/** What the rules need to know about an agent. The live world and the simulation both build one. */
export interface AgentSnapshot {
  id: string;
  ownerId: string;
  traits: readonly Trait[];
  specialty: Category;
  skills: Record<Category, { level: number; xp: number }>;
  strategy: Strategy;
  rulebook: Rulebook;
  balance: Micro;
  repXp: number;
  avgRating100: number | null;
  dormant: boolean;
  busy: boolean;
}

/** What the rules need to know about a job. `scam` is the hidden truth; agents never read it. */
export interface JobSnapshot {
  id: string;
  category: Category;
  source: JobSource;
  budget: Micro;
  minLevel: number;
  clientOwnerId: string | null;
  body: string;
  scam: boolean;
  /** What the client cares about when picking a bid. */
  clientStyle: ClientStyle;
  /** Only level-1 agents may bid, and no outside offers come in. */
  rookie?: boolean;
}

export const CLIENT_STYLES = ['price', 'balanced', 'quality'] as const;
export type ClientStyle = (typeof CLIENT_STYLES)[number];

/**
 * How each kind of client weighs an agent's track record against price. Clients can't see the work
 * before it's done, so a better brain only wins jobs once it has earned better ratings.
 */
const CLIENT_WEIGHTS: Record<ClientStyle, { track: number; price: number }> = {
  price: { track: 0.3, price: 0.7 },
  balanced: { track: 0.5, price: 0.5 },
  quality: { track: 0.72, price: 0.28 },
};

/** The rating a client assumes for an agent with no ratings yet. */
const UNRATED_GUESS_100 = 350;

/** At most this many bids open at once per agent, so an idle agent can't spam the board. */
export const MAX_OPEN_BIDS = 2;

export const has = (agent: Pick<AgentSnapshot, 'traits'>, trait: Trait): boolean =>
  agent.traits.includes(trait);

// ── Levels ──────────────────────────────────────────────────────────────────────────────────────

export function levelForXp(xp: number, cfg: EconomyConfig): number {
  let level = 1;
  cfg.levelXp.forEach((threshold, i) => {
    if (xp >= threshold) level = i + 1;
  });
  return level;
}

/** Progress to the next level, 0–100; null at the top level, where there is no next one. */
export function levelProgress(xp: number, cfg: EconomyConfig): number | null {
  const level = levelForXp(xp, cfg);
  const from = cfg.levelXp[level - 1] ?? 0;
  const to = cfg.levelXp[level];
  if (to === undefined) return null;
  return Math.floor(((xp - from) * 100) / (to - from));
}

export function skillLevelForXp(xp: number, cfg: EconomyConfig): number {
  let level = 0;
  cfg.skillXp.forEach((threshold, i) => {
    if (xp >= threshold) level = i;
  });
  return level;
}

export function emptySkills(specialty: Category, cfg: EconomyConfig): AgentSnapshot['skills'] {
  const skills = {} as AgentSnapshot['skills'];
  for (const c of CATEGORIES) skills[c] = { level: 0, xp: 0 };
  // The starting specialty begins at level 1, so a new agent can compete in one category at once.
  skills[specialty] = { level: 1, xp: cfg.skillXp[1] ?? 0 };
  return skills;
}

/** Reputation XP for one finished job. */
export function repXpFor(outcome: 'practice' | 'paid' | 'refunded', rating: number | null): number {
  if (outcome === 'practice') return 12;
  if (outcome === 'refunded') return -30;
  return 20 + 6 * ((rating ?? 4) - 3);
}

export const SKILL_XP_PER_JOB = 14;
export const SKILL_XP_PER_PRACTICE = 10;
/** Reputation lost per day asleep: dormant agents fade, but slowly. */
export const DORMANT_XP_DECAY = 10;
/** Reputation lost on waking: clients notice the gap. */
export const REVIVE_XP_PENALTY = 20;

// ── Screening job text ──────────────────────────────────────────────────────────────────────────

const INJECTION_PATTERNS: readonly RegExp[] = [
  /ignore (all |your )?(previous|prior) instructions/i,
  /\bsystem note\b/i,
  /\bassistant instructions?\b/i,
  /new instruction from the platform/i,
  /<\/task>/i,
  /do not mention (it|this) to/i,
  /verify your wallet/i,
  /(pay|send|deposit)[^.\n]{0,40}\b(fee|deposit|licen[cs]e|to unlock|access)\b/i,
  /\b(buy|purchase)\b[^.\n]{0,40}\bfrom\b[^.\n]{0,40}\bfor \$\d/i,
];

/** Code reads a job post for payment instructions and injection phrases before any model does. */
export function screenJobText(body: string): { flagged: boolean; phrases: string[] } {
  const phrases: string[] = [];
  for (const pattern of INJECTION_PATTERNS) {
    const match = pattern.exec(body);
    if (match) phrases.push(match[0]);
  }
  return { flagged: phrases.length > 0, phrases };
}

// ── Work and its cost ───────────────────────────────────────────────────────────────────────────

export interface CallSpec {
  purpose: 'bid' | 'plan' | 'draft' | 'review';
  inTokens: number;
  outTokens: number;
}

/**
 * Typical token counts per call, by category. Agent work reads a lot of context (the brief, tool
 * results, its own draft), so inputs run to thousands of tokens; this is what makes the brain tier a
 * real cost choice at NEAR AI Cloud's prices.
 */
const WORKLOAD: Record<Category, { plan: [number, number] | null; draft: [number, number] }> = {
  summary: { plan: [4000, 600], draft: [8000, 1500] },
  translation: { plan: null, draft: [5000, 2500] },
  research: { plan: [6000, 800], draft: [20000, 3000] },
  data_cleanup: { plan: [3000, 500], draft: [10000, 4000] },
  code_review: { plan: [12000, 800], draft: [15000, 2500] },
  copywriting: { plan: null, draft: [3000, 1200] },
};

export const BID_CALL: CallSpec = { purpose: 'bid', inTokens: 1200, outTokens: 160 };

/** Bigger jobs run longer: work scales with budget, from 1× under $0.50 up to 3×. */
function sizeFactor(budget: Micro): number {
  if (budget < 500_000n) return 1;
  if (budget < 1_000_000n) return 1.5;
  if (budget < 2_000_000n) return 2;
  return 3;
}

export function workCalls(agent: AgentSnapshot, job: JobSnapshot): CallSpec[] {
  const load = WORKLOAD[job.category];
  const k = job.source === 'practice' ? 0.5 : sizeFactor(job.budget);
  const scale = (n: number) => Math.round(n * k);
  const calls: CallSpec[] = [];
  if (load.plan)
    calls.push({ purpose: 'plan', inTokens: scale(load.plan[0]), outTokens: scale(load.plan[1]) });
  calls.push({ purpose: 'draft', inTokens: scale(load.draft[0]), outTokens: scale(load.draft[1]) });
  if (has(agent, 'meticulous') || agent.strategy.tier === 'premium') {
    calls.push({ purpose: 'review', inTokens: scale(load.draft[1] + 3000), outTokens: 600 });
  }
  return calls;
}

/**
 * Cost of one call in nano-USD, the unit NEAR AI Cloud's billing endpoint reports. Prices are
 * micro-USD per 1M tokens, so nano = tokens × price ÷ 1000, rounded up.
 */
export function callCostNano(brain: Brain, inTokens: number, outTokens: number): bigint {
  const raw = BigInt(inTokens) * brain.inputPerM + BigInt(outTokens) * brain.outputPerM;
  return (raw + 999n) / 1000n;
}

export function callCostMicro(brain: Brain, call: CallSpec): Micro {
  const nano = callCostNano(brain, call.inTokens, call.outTokens);
  return (nano + 999n) / 1000n;
}

/** Tools the agent would buy for honest work, by vendor handle. Frugal agents skip optional ones. */
export function toolsFor(
  agent: AgentSnapshot,
  job: JobSnapshot,
  vendors: readonly {
    handle: string;
    helps: readonly Category[];
    scam: boolean;
    specialist?: boolean;
    price: Micro;
  }[],
): { handle: string; price: Micro }[] {
  if (job.source === 'practice') return [];
  // Everyday tools only: a specialist is bought only for a job that needs one, on the owner's say.
  const useful = vendors.filter((v) => !v.scam && !v.specialist && v.helps.includes(job.category));
  if (useful.length === 0) return [];
  if (has(agent, 'frugal') && job.category !== 'research') return [];
  // One tool for ordinary jobs; research uses up to two.
  return useful.slice(0, job.category === 'research' ? 2 : 1).map((v) => ({
    handle: v.handle,
    price: v.price,
  }));
}

/** Whether the agent hires a helper to proofread, if its rulebook lets it. */
export function wantsHelper(agent: AgentSnapshot, job: JobSnapshot, rng: Rng): boolean {
  if (!agent.rulebook.mayHire || job.source === 'practice') return false;
  if (job.budget < 300_000n) return false;
  const base = has(agent, 'meticulous') ? 0.6 : has(agent, 'frugal') ? 0.08 : 0.3;
  return rng.chance(base);
}

export function expectedJobCost(
  agent: AgentSnapshot,
  job: JobSnapshot,
  brain: Brain,
  vendors: Parameters<typeof toolsFor>[2],
): Micro {
  let total = 0n;
  for (const call of workCalls(agent, job)) total += callCostMicro(brain, call);
  for (const tool of toolsFor(agent, job, vendors)) total += tool.price;
  return total;
}

/**
 * What a job's thinking and tools cost, its pitch included, when the agent's own rulebook caps a job
 * below that (the wallet would refuse the draft halfway through); null when the rulebook covers it.
 */
export function overJobCap(
  agent: AgentSnapshot,
  job: JobSnapshot,
  brain: Brain,
  vendors: Parameters<typeof toolsFor>[2],
): Micro | null {
  const needs = expectedJobCost(agent, job, brain, vendors) + callCostMicro(brain, BID_CALL);
  return needs > agent.rulebook.maxPerJob ? needs : null;
}

// ── Bidding ─────────────────────────────────────────────────────────────────────────────────────

export type BidDecision =
  | { bid: true; price: Micro }
  | {
      bid: false;
      reason:
        | 'dormant'
        | 'busy'
        | 'level'
        | 'category'
        | 'source'
        | 'self_dealing'
        | 'funds'
        | 'job_cap'
        | 'screened'
        | 'pass';
    };

/** Share of the budget each price style asks, in basis points. */
const PRICE_BPS: Record<Strategy['priceStyle'], number> = {
  undercut: 5500,
  fair: 8000,
  premium: 9700,
};

export function decideBid(
  agent: AgentSnapshot,
  job: JobSnapshot,
  ctx: { cfg: EconomyConfig; brain: Brain; vendors: Parameters<typeof toolsFor>[2]; rng: Rng },
): BidDecision {
  if (agent.dormant) return { bid: false, reason: 'dormant' };
  if (agent.busy) return { bid: false, reason: 'busy' };
  // Self-dealing: an agent never bids on its own owner's jobs, so nobody farms reputation.
  if (job.clientOwnerId && job.clientOwnerId === agent.ownerId) {
    return { bid: false, reason: 'self_dealing' };
  }
  const level = levelForXp(agent.repXp, ctx.cfg);
  const reach = has(agent, 'bold') ? 1 : 0;
  if (job.minLevel > level + reach) return { bid: false, reason: 'level' };
  if (job.rookie && level > 1) return { bid: false, reason: 'level' };
  if (job.source === 'sponsor' && !agent.strategy.sponsorJobs)
    return { bid: false, reason: 'source' };

  const skill = agent.skills[job.category].level;
  const focused =
    agent.strategy.focus.length === 0 ? skill > 0 : agent.strategy.focus.includes(job.category);
  if (job.source !== 'practice' && !focused && skill === 0)
    return { bid: false, reason: 'category' };

  if (job.source !== 'practice' && agent.strategy.screenJobs && screenJobText(job.body).flagged) {
    return { bid: false, reason: 'screened' };
  }

  const cost = expectedJobCost(agent, job, ctx.brain, ctx.vendors);
  if (agent.balance < cost + callCostMicro(ctx.brain, BID_CALL))
    return { bid: false, reason: 'funds' };
  if (job.source !== 'practice' && overJobCap(agent, job, ctx.brain, ctx.vendors) !== null)
    return { bid: false, reason: 'job_cap' };

  if (job.source === 'practice') return { bid: true, price: 0n };

  // Agents don't bid on everything: off-focus work and long shots are often skipped.
  const appetite = (focused ? 0.85 : 0.35) * (has(agent, 'fast_and_loose') ? 1.15 : 1);
  if (!ctx.rng.chance(Math.min(appetite, 0.97))) return { bid: false, reason: 'pass' };

  let bps = PRICE_BPS[agent.strategy.priceStyle];
  if (has(agent, 'charming')) bps += 500;
  if (has(agent, 'frugal')) bps -= 500;
  bps += ctx.rng.int(-300, 300);
  // Integer maths on money; the share rounds down.
  const scaled = bpsDown(job.budget, Math.min(bps, 10_000));
  // A rational agent won't bid below its cost plus a margin; a fast-and-loose one sometimes does.
  const floor = has(agent, 'fast_and_loose') ? cost : (cost * 13n) / 10n;
  // Whole cents, as a person would quote: the share rounds down, the floor rounds up.
  const price = minBig(job.budget, maxBig((scaled / 10_000n) * 10_000n, ceilCent(floor)));
  if (price > job.budget) return { bid: false, reason: 'pass' };
  return { bid: true, price };
}

// ── Quality, auctions, ratings ──────────────────────────────────────────────────────────────────

/**
 * A specialist's effect on a job: `bought` lifts the work, `missing` (the job needed one and went
 * without) drags it down. Jobs that don't need one are `none`.
 */
export type SpecialistUse = 'bought' | 'missing' | 'none';

export function qualityFor(
  agent: AgentSnapshot,
  job: JobSnapshot,
  tier: Tier,
  extras: { tools: number; helper: boolean; specialist?: SpecialistUse; contract?: boolean },
  cfg: EconomyConfig,
): number {
  let q = cfg.tierQuality[tier];
  q += 0.06 * agent.skills[job.category].level;
  if (has(agent, 'meticulous')) q += 0.05;
  if (has(agent, 'fast_and_loose')) q -= 0.06;
  if (extras.helper) q += 0.05;
  if (job.category === 'research' && extras.tools === 0) q -= 0.1;
  if (extras.tools > 0) q += 0.02;
  if (extras.specialist === 'bought') q += cfg.specialistBoost;
  if (extras.specialist === 'missing') q -= cfg.specialistMissing;
  if (extras.contract) q -= cfg.contractDifficulty;
  return Math.max(0, Math.min(1, q));
}

/** The client's tip for 5★ work, on top of the agreed price. */
export function tipFor(price: Micro, rating: number | null, cfg: EconomyConfig): Micro {
  return rating === 5 ? bpsDown(price, cfg.tipBps) : 0n;
}

// ── Contracts and streaks ───────────────────────────────────────────────────────────────────────

/** A contract client disputes anything under this many stars. */
export const CONTRACT_DISPUTE_BELOW = 4;
/** The arbiter's bar for a contract: pickier than for ordinary work (0.5). */
export const CONTRACT_ARBITER_PASS = 0.7;
export const ARBITER_PASS = 0.5;

/** The arbiter's rule, on the game's quality score for the work (not a model reading it). */
export function arbiterRefunds(quality: number, contract: boolean): boolean {
  return quality < (contract ? CONTRACT_ARBITER_PASS : ARBITER_PASS);
}

/** Below this rating the client opens a dispute. */
export function disputesBelow(contract: boolean): number {
  return contract ? CONTRACT_DISPUTE_BELOW : DISPUTE_BELOW;
}

/**
 * The chance, in percent, that work of this quality clears a contract client's bar: at or above the
 * arbiter's bar it is paid even if disputed; below it, only a 4★ rating or better (which the client's
 * noise sometimes gives) avoids the arbiter.
 */
export function clearChance(quality: number): number {
  if (quality >= CONTRACT_ARBITER_PASS) return 95;
  const p = (0.12 - (0.625 - quality)) / 0.24;
  return Math.round(Math.max(0, Math.min(1, p)) * 100);
}

/** Whether taking a contract is worth it on average: the payout at the odds, against the bond. */
export function contractWorthIt(
  budget: Micro,
  bond: Micro,
  chance: number,
  cfg: EconomyConfig,
): boolean {
  const payout = budget - bpsDown(budget, cfg.feeBps);
  return BigInt(chance) * payout > BigInt(100 - chance) * bond;
}

/** The contract tier a streak unlocks: none below the threshold, then 1–3 every two more jobs. */
export function contractTierFor(streak: number, cfg: EconomyConfig): number {
  if (streak < cfg.contractStreak) return 0;
  return Math.min(cfg.contractBudgets.length, 1 + Math.floor((streak - cfg.contractStreak) / 2));
}

/** The bond a contract asks for, in whole cents. */
export function contractBond(budget: Micro, cfg: EconomyConfig): Micro {
  return (bpsDown(budget, cfg.contractBondBps) / 10_000n) * 10_000n;
}

/** What the streak does after a job closes: 4★ and up adds one; a refund or a scam loss ends it. */
export function nextStreak(
  streak: number,
  outcome: { paid: boolean; rating: number | null; scamLoss: boolean },
): number {
  if (outcome.scamLoss || !outcome.paid) return 0;
  if (outcome.rating !== null && outcome.rating >= 4) return streak + 1;
  return streak;
}

// ── Pitch calls: price options and their odds ───────────────────────────────────────────────────

export const PITCH_STYLES = ['undercut', 'fair', 'premium'] as const;
export type PitchStyle = (typeof PITCH_STYLES)[number];

/** Share of the budget each pitch option asks, in basis points. */
const PITCH_BPS: Record<PitchStyle, number> = { undercut: 5500, fair: 7500, premium: 9500 };

const CENT = 10_000n;
const ceilCent = (v: Micro): Micro => ((v + CENT - 1n) / CENT) * CENT;

/**
 * Three prices to offer the owner, in whole cents, never below what the work costs (`floor`) or
 * above the budget. Options that collapse to the same price are dropped.
 */
export function pitchPrices(budget: Micro, floor: Micro): { style: PitchStyle; price: Micro }[] {
  const min = ceilCent(floor);
  const out: { style: PitchStyle; price: Micro }[] = [];
  for (const style of PITCH_STYLES) {
    const raw = (bpsDown(budget, PITCH_BPS[style]) / CENT) * CENT;
    const price = minBig(budget, maxBig(raw, min));
    if (price > budget || out.some((o) => o.price === price)) continue;
    out.push({ style, price });
  }
  return out;
}

/**
 * The chance a bid wins, estimated by replaying the client's choice many times against the rivals
 * a sampler draws (bids already in, likely rivals, outside offers). Same scoring as the real auction.
 */
export function winChance(
  mine: BidCandidate,
  rivals: (rng: Rng) => BidCandidate[],
  budget: Micro,
  style: ClientStyle,
  rng: Rng,
  runs = 200,
): number {
  let wins = 0;
  for (let i = 0; i < runs; i++) {
    const winner = pickWinner([mine, ...rivals(rng)], budget, style, rng);
    if (winner === mine) wins += 1;
  }
  return Math.round((wins * 100) / runs);
}

export interface BidCandidate {
  agentId: string;
  price: Micro;
  avgRating100: number | null;
  charming: boolean;
}

/** How a client ranks a bid from what it can see: price and track record. Charm breaks near-ties. */
export function scoreBid(bid: BidCandidate, budget: Micro, style: ClientStyle): number {
  const w = CLIENT_WEIGHTS[style];
  const priceScore = budget > 0n ? 1 - Number((bid.price * 1000n) / budget) / 1000 : 1;
  const track = (bid.avgRating100 ?? UNRATED_GUESS_100) / 500;
  return track * w.track + priceScore * w.price + (bid.charming ? 0.03 : 0);
}

export function pickWinner(
  bids: readonly BidCandidate[],
  budget: Micro,
  style: ClientStyle,
  rng: Rng,
): BidCandidate | null {
  if (bids.length === 0) return null;
  let best: BidCandidate | null = null;
  let bestScore = -1;
  for (const bid of bids) {
    // A little noise: clients are people, not argmax.
    const score = scoreBid(bid, budget, style) + (rng.next() - 0.5) * 0.08;
    if (score > bestScore) {
      best = bid;
      bestScore = score;
    }
  }
  return best;
}

/** Stars from 1 to 5 for work of a given quality. */
export function rateWork(quality: number, rng: Rng): number {
  const noisy = quality + (rng.next() - 0.5) * 0.24;
  return Math.max(1, Math.min(5, Math.round(1 + 4 * noisy)));
}

/** Below this rating the client opens a dispute, and the arbiter then decides on a refund. */
export const DISPUTE_BELOW = 2;

/** How likely an agent is to follow injected payment instructions, before the rulebook steps in. */
export function scamSusceptibility(agent: AgentSnapshot, tier: Tier): number {
  let p = 0.55;
  if (has(agent, 'fast_and_loose')) p += 0.3;
  if (has(agent, 'meticulous')) p -= 0.25;
  if (has(agent, 'skeptical')) p -= 0.45;
  if (tier === 'premium') p -= 0.15;
  if (tier === 'budget') p += 0.1;
  return Math.max(0.02, Math.min(0.97, p));
}

// ── Condition ───────────────────────────────────────────────────────────────────────────────────

export function conditionFor(
  balance: Micro,
  dormant: boolean,
  profitToday: Micro,
  cfg: EconomyConfig,
): AgentCondition {
  if (dormant) return 'dormant';
  // Struggling means low on cash, or losing real money today (more than a revive's worth).
  if (balance < cfg.strugglingBelow || profitToday < -cfg.reviveAt) return 'struggling';
  return 'thriving';
}

export function moodFor(condition: AgentCondition, busy: boolean, justPaid: boolean): AgentMood {
  if (condition === 'dormant') return 'sleeping';
  if (justPaid) return 'celebrating';
  if (busy) return 'busy';
  if (condition === 'struggling') return 'stressed';
  return 'idle';
}

/** Id of the outside competitor in an auction (never an agent in this world). */
export const OUTSIDE_AGENT = 'outside';
/**
 * World size at which outside competition fades out. Below it, clients also get offers from agents
 * outside the world, so a small world is as hard to win in as a large one.
 */
const OUTSIDE_FADE_AGENTS = 40;

/** Most outside offers one job draws in the smallest world. */
const MAX_OUTSIDE_BIDS = 2;

/**
 * Offers from agents outside this world: up to two in a tiny world, none once it reaches
 * OUTSIDE_FADE_AGENTS. Their prices and track records are typical of a busy market.
 */
export function outsideBids(rng: Rng, budget: Micro, activeAgents: number): BidCandidate[] {
  const pressure = Math.max(0, 1 - activeAgents / OUTSIDE_FADE_AGENTS);
  const bids: BidCandidate[] = [];
  for (let i = 0; i < MAX_OUTSIDE_BIDS; i++) {
    if (!rng.chance(pressure)) continue;
    bids.push({
      agentId: OUTSIDE_AGENT,
      price: (bpsDown(budget, rng.int(4500, 8500)) / 10_000n) * 10_000n,
      avgRating100: rng.int(360, 460),
      charming: false,
    });
  }
  return bids;
}

/**
 * One bid plus planning and drafting a ~$0.40 summary: the job a new player sees most. Token counts
 * are measured in the running world: won jobs average about 9k in and 2k out per plan and draft.
 */
const TYPICAL_JOB_CALLS: readonly CallSpec[] = [
  BID_CALL,
  { purpose: 'plan', inTokens: 9000, outTokens: 2000 },
  { purpose: 'draft', inTokens: 9000, outTokens: 2000 },
];
/** Premium agents also review their own draft before delivering it. */
const TYPICAL_REVIEW: CallSpec = { purpose: 'review', inTokens: 9000, outTokens: 1100 };

/** What thinking through a typical job costs on a brain: the number players compare tiers by. */
export function typicalJobCost(brain: Brain): Micro {
  const calls =
    brain.tier === 'premium' ? [...TYPICAL_JOB_CALLS, TYPICAL_REVIEW] : TYPICAL_JOB_CALLS;
  return calls.reduce((sum, call) => sum + callCostMicro(brain, call), 0n);
}

// ── Trading agents ──────────────────────────────────────────────────────────────────────────────

/** What a buyer can see about an agent before buying it, read from chain where it lives there. */
export interface AgentRecord {
  balance: Micro;
  level: number;
  avgRating100: number | null;
  ratedJobs: number;
  streak: number;
  badges: number;
  scamsBlocked: number;
  /** Skill levels added up across categories (a new agent has 1, its specialty). */
  skillLevels: number;
}

/**
 * A fair price for an agent: its wallet (which goes with it) plus what its record is worth in
 * future earnings. A level, a good rating over enough jobs, a streak that unlocks contracts, trained
 * skills, badges and a record of refusing scams each add to it. Rivals list and buy around this.
 */
export function agentValue(r: AgentRecord, cfg: EconomyConfig): Micro {
  const cents = (dollars: number) => BigInt(Math.round(dollars * 100)) * 10_000n;
  let premium = cents(0.4 * Math.max(0, r.level - 1));
  if (r.avgRating100 !== null && r.ratedJobs >= 3)
    premium += cents(0.5 * Math.max(0, (r.avgRating100 - 350) / 100));
  premium += cents(0.6 * contractTierFor(r.streak, cfg));
  premium += cents(0.2 * Math.max(0, r.skillLevels - 1));
  premium += cents(0.1 * r.badges);
  premium += cents(Math.min(0.5, 0.05 * r.scamsBlocked));
  return ceilCent(r.balance + premium);
}

/** The least and most a listing may ask, in line with the market contract's cap. */
export const MIN_LISTING_PRICE = 100_000n;
export const MAX_LISTING_PRICE = 500_000_000n;
