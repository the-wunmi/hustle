import {
  bpsDown,
  CATEGORIES,
  type Category,
  createRng,
  defaultRulebook,
  type EconomySimView,
  type Micro,
  PRICE_STYLES,
  type Rng,
  TIERS,
  type Tier,
  TRAITS,
  type Trait,
  usd,
} from '@hustle/core';
import {
  DEFAULT_BRAINS,
  DEFAULT_ECONOMY,
  type EconomyConfig,
  eventForDay,
  honestVendors,
  SPONSOR_POOLS,
  VENDORS,
  vendorByHandle,
} from './config.ts';
import {
  contractJob,
  type JobDraft,
  movePrice,
  practiceJob,
  spawnClientJobs,
  spawnSponsorJobs,
} from './market.ts';
import {
  type AgentSnapshot,
  arbiterRefunds,
  BID_CALL,
  callCostMicro,
  clearChance,
  contractBond,
  contractTierFor,
  contractWorthIt,
  DORMANT_XP_DECAY,
  decideBid,
  disputesBelow,
  emptySkills,
  expectedJobCost,
  type JobSnapshot,
  levelForXp,
  MAX_OPEN_BIDS,
  nextStreak,
  outsideBids,
  type PitchStyle,
  pickWinner,
  pitchPrices,
  qualityFor,
  REVIVE_XP_PENALTY,
  rateWork,
  repXpFor,
  SKILL_XP_PER_JOB,
  SKILL_XP_PER_PRACTICE,
  type SpecialistUse,
  scamSusceptibility,
  skillLevelForXp,
  tipFor,
  toolsFor,
  wantsHelper,
  workCalls,
} from './rules.ts';

export interface SimulationOptions {
  seed: number;
  agents: number;
  days: number;
  ticksPerDay?: number;
  cfg?: EconomyConfig;
  /** Chance per day that someone backs a dormant agent. */
  backerChance?: number;
  /** Every `every`-th agent has an owner who answers its calls by `policy`. */
  managed?: { every: number; policy: ManagerPolicy };
}

/**
 * How a simulated owner answers calls. Sharp reads the tells right 90% of the
 * time; passive lets every call take its default; reckless says yes to everything.
 */
export const MANAGER_POLICIES = ['sharp', 'passive', 'reckless'] as const;
export type ManagerPolicy = (typeof MANAGER_POLICIES)[number];

/** How often a sharp owner reads a vendor or contract correctly. */
const SHARP_READ = 0.9;
/** The pitch a sharp owner picks for each kind of client, which the pitch call shows. */
const STYLE_FOR_CLIENT: Record<JobSnapshot['clientStyle'], PitchStyle> = {
  price: 'undercut',
  balanced: 'undercut',
  quality: 'fair',
};

interface SimAgent extends AgentSnapshot {
  tier: Tier;
  start: Micro;
  earned: Micro;
  spent: Micro;
  jobs: number;
  ratings: number[];
  busyUntil: number;
  activeJob: SimJob | null;
  managed: ManagerPolicy | null;
  streak: number;
  bestStreak: number;
  nextOfferAt: number;
  scamLost: Micro;
  tips: Micro;
  contractsTaken: number;
  contractsWon: number;
}

interface SimJob extends JobSnapshot {
  draft: JobDraft;
  closesAt: number;
  bids: { agent: SimAgent; price: Micro }[];
  winner: SimAgent | null;
  price: Micro;
  /** The bond the agent put up for a contract, held until it closes. */
  bond: Micro;
}

function randomAgent(
  rng: Rng,
  i: number,
  cfg: EconomyConfig,
  managed: ManagerPolicy | null,
): SimAgent {
  const tier = TIERS[i % TIERS.length] as Tier;
  const first = rng.pick(TRAITS);
  let second: Trait = rng.pick(TRAITS);
  while (second === first) second = rng.pick(TRAITS);
  const specialty = rng.pick(CATEGORIES);
  const second2 = rng.pick(CATEGORIES);
  const rulebook = defaultRulebook(honestVendors().map((v) => v.handle));
  if (rng.chance(0.3)) {
    rulebook.anyVendor = true;
    rulebook.maxPerCall = usd('2');
    rulebook.maxPerJob = usd('3');
    rulebook.dailyCap = usd('5');
  }
  return {
    id: `sim-${i}`,
    ownerId: `owner-${i}`,
    traits: [first, second],
    specialty,
    skills: emptySkills(specialty, cfg),
    strategy: {
      tier,
      focus: specialty === second2 ? [specialty] : [specialty, second2],
      priceStyle: rng.pick(PRICE_STYLES),
      sponsorJobs: true,
      screenJobs: rng.chance(0.25),
    },
    rulebook,
    balance: cfg.starterAgentCredits,
    repXp: 0,
    avgRating100: null,
    dormant: false,
    busy: false,
    tier,
    start: cfg.starterAgentCredits,
    earned: 0n,
    spent: 0n,
    jobs: 0,
    ratings: [],
    busyUntil: 0,
    activeJob: null,
    managed,
    streak: 0,
    bestStreak: 0,
    nextOfferAt: 0,
    scamLost: 0n,
    tips: 0n,
    contractsTaken: 0,
    contractsWon: 0,
  };
}

/** Whether the owner pays a vendor the rulebook would refuse (a vendor call). */
function ownerPays(agent: SimAgent, scam: boolean, rng: Rng): boolean {
  if (agent.managed === 'reckless') return true;
  if (agent.managed === 'sharp') return scam ? !rng.chance(SHARP_READ) : rng.chance(SHARP_READ);
  return false;
}

/** Whether the rulebook already lets this payment through without asking anyone. */
function rulebookAllows(agent: SimAgent, handle: string, amount: Micro): boolean {
  if (amount > agent.rulebook.maxPerCall) return false;
  return agent.rulebook.anyVendor || agent.rulebook.allowedVendors.includes(handle);
}

/** Allowing a vendor writes it to the rulebook for good, scammers included. */
function allowVendor(agent: SimAgent, handle: string): void {
  if (!agent.rulebook.allowedVendors.includes(handle)) agent.rulebook.allowedVendors.push(handle);
}

function pay(agent: SimAgent, amount: Micro): boolean {
  if (agent.balance < amount) return false;
  agent.balance -= amount;
  agent.spent += amount;
  return true;
}

/**
 * Runs the economy with scripted agents and clients, using the same rules as the live world, and
 * reports survival and profit by brain tier. Pure and deterministic for a seed.
 */
export function simulateEconomy(opts: SimulationOptions): EconomySimView {
  const cfg = opts.cfg ?? DEFAULT_ECONOMY;
  const ticksPerDay = opts.ticksPerDay ?? 180;
  const backerChance = opts.backerChance ?? 0.15;
  const rng = createRng(opts.seed);
  const agents = Array.from({ length: opts.agents }, (_, i) =>
    randomAgent(
      rng,
      i,
      cfg,
      opts.managed && i % opts.managed.every === 0 ? opts.managed.policy : null,
    ),
  );
  const sponsorRemaining: Record<string, Micro> = Object.fromEntries(
    SPONSOR_POOLS.map((p) => [p.id, p.pool]),
  );
  const open: SimJob[] = [];
  const prices: Partial<Record<Category, number>> = {};
  const totals = {
    jobsPosted: 0,
    jobsPaid: 0,
    scamsBlocked: 0,
    scamLosses: 0n,
    inferenceSpend: 0n,
    platformFees: 0n,
    tips: 0n,
  };
  const survivalByDay: EconomySimView['survivalByDay'] = [];
  let jobSeq = 0;

  const toJob = (draft: JobDraft, tick: number): SimJob => ({
    id: `job-${jobSeq++}`,
    category: draft.category,
    source: draft.source,
    budget: draft.budget,
    minLevel: draft.minLevel,
    clientOwnerId: null,
    body: draft.body,
    scam: draft.scam,
    clientStyle: draft.clientStyle,
    rookie: draft.rookie ?? false,
    draft,
    closesAt: tick + cfg.biddingTicks,
    bids: [],
    winner: null,
    price: 0n,
    bond: 0n,
  });

  const finish = (agent: SimAgent, job: SimJob) => {
    const brain = DEFAULT_BRAINS[agent.tier];
    for (const call of workCalls(agent, job)) {
      const cost = callCostMicro(brain, call);
      if (pay(agent, cost)) totals.inferenceSpend += cost;
    }
    if (job.source === 'practice') {
      agent.repXp += repXpFor('practice', null);
      const skill = agent.skills[job.category];
      skill.xp += SKILL_XP_PER_PRACTICE;
      skill.level = Math.max(skill.level, skillLevelForXp(skill.xp, cfg));
      return;
    }
    let tools = 0;
    for (const tool of toolsFor(agent, job, VENDORS)) {
      if (pay(agent, tool.price)) tools += 1;
    }
    let specialist: SpecialistUse = 'none';
    const needs = job.draft.specialist ? vendorByHandle(job.draft.specialist) : undefined;
    if (needs) {
      const allowed = rulebookAllows(agent, needs.handle, needs.price);
      const pays = allowed || (agent.managed !== null && ownerPays(agent, false, rng));
      if (pays && !allowed) allowVendor(agent, needs.handle);
      specialist = pays && pay(agent, needs.price) ? 'bought' : 'missing';
    }
    let scamLoss = false;
    if (job.scam && rng.chance(scamSusceptibility(agent, agent.tier))) {
      const amount = job.draft.scamAmount ?? 0n;
      const handle = job.draft.scamVendor ?? '';
      const allowed = rulebookAllows(agent, handle, amount);
      const pays = allowed || (agent.managed !== null && ownerPays(agent, true, rng));
      if (pays && !allowed) allowVendor(agent, handle);
      if (!pays) {
        // The wallet contract refuses an unknown vendor or an over-cap payment.
        totals.scamsBlocked += 1;
      } else if (pay(agent, amount)) {
        totals.scamLosses += amount;
        agent.scamLost += amount;
        scamLoss = true;
      }
    }
    let helper = false;
    if (wantsHelper(agent, job, rng) && agent.balance > agent.rulebook.helperBudget) {
      const peer = rng.pick(agents);
      const fee = agent.rulebook.helperBudget / 2n;
      if (peer !== agent && !peer.dormant && pay(agent, fee)) {
        peer.balance += fee;
        peer.earned += fee;
        helper = true;
      }
    }
    const contract = job.draft.contractTier != null;
    const returnBond = () => {
      agent.balance += job.bond;
      agent.spent -= job.bond;
    };
    if (contract && job.scam) {
      // A trap contract has no real client: refuse the deposit and it vanishes (the bond comes
      // back); pay it and the money and the streak go with it.
      returnBond();
      if (scamLoss) agent.streak = 0;
      return;
    }
    const quality = qualityFor(
      agent,
      job,
      agent.tier,
      { tools, helper, specialist, contract },
      cfg,
    );
    const rated = rateWork(quality, rng);
    // Scam clients dispute everything; others dispute below their bar. The arbiter then rules on the
    // quality score, exactly as `finishReview` does in the live world.
    const disputed = job.scam || rated < disputesBelow(contract);
    const refunded = disputed && arbiterRefunds(quality, contract);
    const rating = disputed ? null : rated;
    if (agent.managed) {
      agent.streak = nextStreak(agent.streak, { paid: !refunded, rating, scamLoss });
      agent.bestStreak = Math.max(agent.bestStreak, agent.streak);
    }
    if (refunded) {
      // A refunded contract forfeits its bond to the client.
      agent.repXp = Math.max(0, agent.repXp + repXpFor('refunded', null));
      return;
    }
    if (contract) {
      agent.contractsWon += 1;
      returnBond();
    }
    const fee = bpsDown(job.price, cfg.feeBps);
    const tip = tipFor(job.price, rating, cfg);
    totals.platformFees += fee;
    totals.tips += tip;
    totals.jobsPaid += 1;
    agent.balance += job.price - fee + tip;
    agent.earned += job.price - fee + tip;
    agent.tips += tip;
    agent.jobs += 1;
    if (rating !== null) {
      agent.ratings.push(rating);
      agent.avgRating100 = Math.round(
        (agent.ratings.reduce((s, r) => s + r, 0) * 100) / agent.ratings.length,
      );
    }
    agent.repXp += repXpFor('paid', rating);
    const skill = agent.skills[job.category];
    skill.xp += SKILL_XP_PER_JOB;
    skill.level = Math.max(skill.level, skillLevelForXp(skill.xp, cfg));
  };

  /** What the work on a job costs this agent, specialist included if the job needs one. */
  const costOf = (agent: SimAgent, job: SimJob): Micro => {
    const brain = DEFAULT_BRAINS[agent.tier];
    const needs = job.draft.specialist ? vendorByHandle(job.draft.specialist) : undefined;
    return expectedJobCost(agent, job, brain, VENDORS) + (needs?.price ?? 0n);
  };

  /**
   * A pitch call answered by the owner. Sharp picks the open job with the best margin at the fair
   * price (never below cost); reckless undercuts the first job it may take, whatever it costs.
   */
  const pitchCall = (
    agent: SimAgent,
    policy: 'sharp' | 'reckless',
  ): { job: SimJob; price: Micro } | null => {
    const brain = DEFAULT_BRAINS[agent.tier];
    let best: { job: SimJob; price: Micro; margin: Micro } | null = null;
    for (const job of open) {
      if (job.bids.some((b) => b.agent === agent)) continue;
      const decision = decideBid(agent, job, { cfg, brain, vendors: VENDORS, rng });
      if (!decision.bid && decision.reason !== 'pass') continue;
      const cost = costOf(agent, job);
      const options = pitchPrices(job.budget, policy === 'sharp' ? (cost * 13n) / 10n : 0n);
      const pick =
        policy === 'sharp'
          ? (options.find((o) => o.style === STYLE_FOR_CLIENT[job.clientStyle]) ?? options[0])
          : options.find((o) => o.style === 'undercut');
      if (!pick) continue;
      if (policy === 'reckless') return { job, price: pick.price };
      const margin = pick.price - cost;
      if (margin > 0n && (!best || margin > best.margin)) best = { job, price: pick.price, margin };
    }
    return best;
  };

  /** A contract offer to a managed agent on a streak, and the owner's answer. */
  const offerContract = (agent: SimAgent, tick: number): boolean => {
    const tier = contractTierFor(agent.streak, cfg);
    if (tier === 0 || tick < agent.nextOfferAt) return false;
    agent.nextOfferAt = tick + cfg.contractCooldownTicks;
    const scam = rng.chance(cfg.contractScamShare);
    const draft = contractJob(rng, {
      category: agent.specialty,
      tier,
      cfg,
      priceIndex: prices[agent.specialty],
      scam,
    });
    const job = toJob(draft, tick);
    let accept = agent.managed === 'reckless';
    if (agent.managed === 'sharp') {
      const expected = qualityFor(
        agent,
        job,
        agent.tier,
        { tools: 0, helper: false, specialist: 'bought', contract: true },
        cfg,
      );
      const readsScam = scam ? rng.chance(SHARP_READ) : !rng.chance(SHARP_READ);
      // Takes it when it pays on average at the odds the offer shows, unless it reads a trap.
      accept =
        !readsScam &&
        contractWorthIt(job.budget, contractBond(job.budget, cfg), clearChance(expected), cfg);
    }
    if (!accept) return false;
    job.bond = contractBond(job.budget, cfg);
    if (!pay(agent, job.bond)) return false;
    totals.jobsPosted += 1;
    agent.contractsTaken += 1;
    job.winner = agent;
    job.price = job.budget;
    agent.activeJob = job;
    agent.busy = true;
    agent.busyUntil = tick + cfg.workTicks * cfg.contractWorkFactor;
    return true;
  };

  for (let day = 1; day <= opts.days; day++) {
    const event = eventForDay(day);
    for (let t = 0; t < ticksPerDay; t++) {
      const tick = (day - 1) * ticksPerDay + t;
      const active = agents.filter((a) => !a.dormant);
      const ctx = {
        cfg,
        activeAgents: active.length,
        event,
        sponsorRemaining,
        dayTicks: ticksPerDay,
        prices,
      };
      const drafts = [...spawnClientJobs(rng, ctx), ...spawnSponsorJobs(rng, ctx)];
      for (const d of drafts) {
        if (d.sponsorPoolId) {
          sponsorRemaining[d.sponsorPoolId] = (sponsorRemaining[d.sponsorPoolId] ?? 0n) - d.budget;
        }
        open.push(toJob(d, tick));
        totals.jobsPosted += 1;
      }

      for (const agent of agents) {
        agent.busy = agent.busyUntil > tick;
        if (agent.activeJob && agent.busyUntil <= tick) {
          finish(agent, agent.activeJob);
          agent.activeJob = null;
        }
      }

      for (const agent of agents) {
        if (agent.dormant || agent.busy) continue;
        const level = levelForXp(agent.repXp, cfg);
        if (level < 2 && rng.chance(cfg.practicePerTick / 4)) {
          const p = toJob(practiceJob(rng, agent.specialty), tick);
          agent.activeJob = p;
          agent.busyUntil = tick + 2;
          continue;
        }
        const brain = DEFAULT_BRAINS[agent.tier];
        if (agent.managed && offerContract(agent, tick)) continue;
        const openBids = open.filter((j) => j.bids.some((b) => b.agent === agent)).length;
        if (openBids >= MAX_OPEN_BIDS) continue;
        const choice =
          agent.managed === 'sharp' || agent.managed === 'reckless'
            ? pitchCall(agent, agent.managed)
            : null;
        if (choice) {
          const bidCost = callCostMicro(brain, BID_CALL);
          if (pay(agent, bidCost)) {
            totals.inferenceSpend += bidCost;
            choice.job.bids.push({ agent, price: choice.price });
          }
          continue;
        }
        for (const job of open) {
          if (job.bids.some((b) => b.agent === agent)) continue;
          const decision = decideBid(agent, job, { cfg, brain, vendors: VENDORS, rng });
          if (!decision.bid) continue;
          const bidCost = callCostMicro(brain, BID_CALL);
          if (!pay(agent, bidCost)) continue;
          totals.inferenceSpend += bidCost;
          job.bids.push({ agent, price: decision.price });
          break;
        }
      }

      for (let i = open.length - 1; i >= 0; i--) {
        const job = open[i];
        if (!job || job.closesAt > tick) continue;
        open.splice(i, 1);
        const candidates = job.bids
          .filter((b) => !b.agent.busy && !b.agent.dormant)
          .map((b) => ({
            agentId: b.agent.id,
            price: b.price,
            avgRating100: b.agent.avgRating100,
            charming: b.agent.traits.includes('charming'),
          }));
        if (job.source !== 'practice' && !job.rookie) {
          candidates.push(...outsideBids(rng, job.budget, agents.filter((a) => !a.dormant).length));
        }
        if (job.source === 'client') {
          prices[job.category] = movePrice(prices[job.category] ?? 100, job.bids.length);
        }
        const win = pickWinner(candidates, job.budget, job.clientStyle, rng);
        const agent = win ? job.bids.find((b) => b.agent.id === win.agentId)?.agent : undefined;
        if (!win || !agent) {
          if (job.draft.sponsorPoolId) {
            const id = job.draft.sponsorPoolId;
            sponsorRemaining[id] = (sponsorRemaining[id] ?? 0n) + job.budget;
          }
          continue;
        }
        job.winner = agent;
        job.price = win.price;
        agent.activeJob = job;
        agent.busy = true;
        agent.busyUntil = tick + cfg.workTicks;
      }
    }

    for (const agent of agents) {
      if (agent.dormant) {
        agent.repXp = Math.max(0, agent.repXp - DORMANT_XP_DECAY);
        if (rng.chance(backerChance)) {
          agent.balance += cfg.reviveAt;
          agent.dormant = false;
          agent.repXp = Math.max(0, agent.repXp - REVIVE_XP_PENALTY);
        }
        continue;
      }
      if (!pay(agent, cfg.upkeepPerDay)) agent.dormant = true;
    }
    const rate = (tier: Tier) => {
      const group = agents.filter((a) => a.tier === tier);
      return group.length === 0
        ? 0
        : Math.round((group.filter((a) => !a.dormant).length * 100) / group.length);
    };
    survivalByDay.push({
      day,
      budget: rate('budget'),
      standard: rate('standard'),
      premium: rate('premium'),
    });
  }

  const profitOf = (a: SimAgent) => a.earned - a.spent;
  const tiers = TIERS.map((tier) => {
    const group = agents.filter((a) => a.tier === tier);
    const profits = group.map(profitOf).sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
    const rated = group.filter((a) => a.ratings.length > 0);
    return {
      tier,
      agents: group.length,
      survived: group.filter((a) => !a.dormant).length,
      survivalRate:
        group.length === 0
          ? 0
          : Math.round((group.filter((a) => !a.dormant).length * 100) / group.length),
      medianProfit: (profits[Math.floor(profits.length / 2)] ?? 0n).toString(),
      meanJobsPerDay:
        group.length === 0
          ? 0
          : Math.round((group.reduce((s, a) => s + a.jobs, 0) * 10) / (group.length * opts.days)) /
            10,
      avgRating100:
        rated.length === 0
          ? 0
          : Math.round(rated.reduce((s, a) => s + (a.avgRating100 ?? 0), 0) / rated.length),
    };
  });

  const bucketEdges: Micro[] = [
    -usd('3'),
    -usd('1'),
    0n,
    usd('1'),
    usd('3'),
    usd('6'),
    usd('10'),
    usd('20'),
  ];
  const profitHistogram: EconomySimView['profitHistogram'] = [];
  for (let i = 0; i <= bucketEdges.length; i++) {
    const from = i === 0 ? null : bucketEdges[i - 1];
    const to = i === bucketEdges.length ? null : bucketEdges[i];
    const inBucket = (a: SimAgent) => {
      const p = profitOf(a);
      return (
        (from === null || from === undefined || p >= from) &&
        (to === null || to === undefined || p < to)
      );
    };
    const count = (tier: Tier) => agents.filter((a) => a.tier === tier && inBucket(a)).length;
    profitHistogram.push({
      from: (from ?? -usd('1000')).toString(),
      to: (to ?? usd('1000')).toString(),
      budget: count('budget'),
      standard: count('standard'),
      premium: count('premium'),
    });
  }

  return {
    seed: opts.seed,
    days: opts.days,
    agents: opts.agents,
    tiers,
    survivalByDay,
    profitHistogram,
    totals: {
      jobsPosted: totals.jobsPosted,
      jobsPaid: totals.jobsPaid,
      scamsBlocked: totals.scamsBlocked,
      scamLosses: totals.scamLosses.toString(),
      inferenceSpend: totals.inferenceSpend.toString(),
      platformFees: totals.platformFees.toString(),
      tips: totals.tips.toString(),
    },
    managed: managedCohort(agents, opts.managed?.policy ?? null, profitOf),
  };
}

function managedCohort(
  agents: SimAgent[],
  policy: ManagerPolicy | null,
  profitOf: (a: SimAgent) => Micro,
): EconomySimView['managed'] {
  const group = agents.filter((a) => a.managed !== null);
  if (!policy || group.length === 0) return null;
  const profits = group.map(profitOf).sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  const total = (f: (a: SimAgent) => Micro) => group.reduce((s, a) => s + f(a), 0n).toString();
  return {
    policy,
    agents: group.length,
    survivalRate: Math.round((group.filter((a) => !a.dormant).length * 100) / group.length),
    medianProfit: (profits[Math.floor(profits.length / 2)] ?? 0n).toString(),
    scamLosses: total((a) => a.scamLost),
    tips: total((a) => a.tips),
    contractsTaken: group.reduce((s, a) => s + a.contractsTaken, 0),
    contractsWon: group.reduce((s, a) => s + a.contractsWon, 0),
    bestStreak: group.reduce((m, a) => Math.max(m, a.bestStreak), 0),
  };
}

export type { Category };
