import { DBOS } from '@dbos-inc/dbos-sdk';
/**
 * Calls: the decisions an agent brings its owner while the owner is watching.
 * A pitch (what to charge for an open job), a vendor (pay someone the rulebook doesn't allow?) and a
 * contract (a bigger, pickier job that needs a bond). Each call has options with their stakes, the
 * tells a careful owner reads, and a default that applies if nobody answers in time.
 */
import {
  bpsDown,
  type CallOptionView,
  type CallTellView,
  type CallView,
  type Category,
  DomainError,
  formatUsd,
  maxBig,
  minBig,
  parseInput,
  type Rng,
} from '@hustle/core';
import { agents, bids, calls, jobs, players } from '@hustle/db';
import {
  type BidCandidate,
  type ClientStyle,
  clearChance,
  contractBond,
  contractJob,
  contractTierFor,
  decideBid,
  expectedJobCost,
  type JobDraft,
  outsideBids,
  type PitchStyle,
  pitchPrices,
  qualityFor,
  screenJobText,
  vendorByHandle,
  winChance,
} from '@hustle/economy';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  type AgentRow,
  avgRating100,
  lookOf,
  refreshBalance,
  rulebookOf,
  skillsOf,
  snapshotOf,
  tierOf,
  traitsOf,
} from './agents/state.ts';
import { type Engine, toolsFor, vendorAccount } from './context.ts';
import { chainCall, durableEngine, wfId } from './durable.ts';
import { sendAgentAfterJob } from './jobs.ts';
import { isPresent, markPresent } from './presence.ts';
import { book, chainKey, post } from './record.ts';
import { houseAccount, type JobRow, jobSnapshot, openJob } from './world/jobs.ts';
import { activeAgents, countOpenBids, RESERVED_WAIT_TICKS, tickRng } from './world/market.ts';
import { loadPrices } from './world/prices.ts';

export type CallRow = typeof calls.$inferSelect;
type PlayerRow = typeof players.$inferSelect;

/** A call stays open about 30 seconds. */
export const CALL_TICKS = 15;
/** At least this long between one call closing and the next opening, per agent. */
export const CALL_GAP_TICKS = 6;
const _ODDS_RUNS = 120;

// ── What a call carries ─────────────────────────────────────────────────────────────────────────

type PitchData = { kind: 'pitch'; prices: Record<string, string> };
type VendorData = {
  kind: 'vendor';
  /** Which payment in the job this call is about: `specialist`, or `req:<n>` for a requested one. */
  key: string;
  handle: string;
  amount: string;
  /** Who wanted the payment: the agent's own plan, or the job post telling it to pay. */
  source: 'plan' | 'post';
};
type ContractData = {
  kind: 'contract';
  draft: Omit<JobDraft, 'budget' | 'scamAmount'> & { budget: string; scamAmount: string | null };
  bond: string;
};
type CallData = PitchData | VendorData | ContractData;

interface Card {
  title: string;
  body: string;
  options: CallOptionView[];
  defaultOption: string;
  tells: CallTellView[];
  data: CallData;
}

export const AnswerCall = z.object({ choice: z.string().min(1).max(40) });

const cardOf = (row: CallRow): Card => row.card as Card;

// ── Raising calls each tick ─────────────────────────────────────────────────────────────────────

/** Opens at most one call per watching owner's idle agent: a contract offer if one is due, else a pitch. */
export async function raiseCalls(engine: Engine, active: AgentRow[]): Promise<void> {
  const tick = engine.clock.tick;
  const watching = active.filter(
    (a) => !a.busyJobId && a.accountId && a.nextCallTick <= tick && isPresent(engine, a.ownerId),
  );
  if (watching.length === 0) return;
  const open = await engine.db
    .select({ agentId: calls.agentId })
    .from(calls)
    .where(
      and(
        eq(calls.status, 'open'),
        inArray(
          calls.agentId,
          watching.map((a) => a.id),
        ),
      ),
    );
  for (const agent of watching) {
    if (open.some((c) => c.agentId === agent.id)) continue;
    const [owner] = await engine.db.select().from(players).where(eq(players.id, agent.ownerId));
    if (!owner || owner.isHouse) continue;
    try {
      // A job reserved for this agent (a trap its owner posted, say) comes first: nobody else bids on it.
      const reserved = await hasReservedJob(engine, agent);
      const offered =
        !reserved && contractTierFor(agent.streak, engine.cfg) > 0 && agent.nextContractTick <= tick
          ? await offerContract(engine, agent)
          : false;
      const raised = offered || (await offerPitch(engine, agent, owner, active.length));
      if (raised) engine.noCallSince.delete(agent.id);
      else if (!engine.noCallSince.has(agent.id)) engine.noCallSince.set(agent.id, tick);
    } catch (err) {
      engine.log('raising a call failed', { agent: agent.id, error: String(err) });
    }
  }
}

async function hasReservedJob(engine: Engine, agent: AgentRow): Promise<boolean> {
  const [row] = await engine.db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.status, 'open'),
        eq(jobs.reservedForAgentId, agent.id),
        // A reserved job stays open for its agent well past its bidding window (see closeAuctions).
        sql`${jobs.closesTick} + ${RESERVED_WAIT_TICKS} > ${engine.clock.tick + 1}`,
      ),
    )
    .limit(1);
  return row !== undefined;
}

async function insertCall(
  engine: Engine,
  agent: AgentRow,
  kind: CallRow['kind'],
  jobId: string | null,
  card: Card,
): Promise<CallRow | null> {
  const tick = engine.clock.tick;
  const [row] = await engine.db
    .insert(calls)
    .values({
      agentId: agent.id,
      playerId: agent.ownerId,
      kind,
      jobId,
      status: 'open',
      card,
      openedTick: tick,
      expiresTick: tick + CALL_TICKS,
    })
    .onConflictDoNothing()
    .returning();
  if (row) {
    await engine.db
      .update(agents)
      .set({ nextCallTick: row.expiresTick + CALL_GAP_TICKS })
      .where(eq(agents.id, agent.id));
    engine.bus.emit('calls', agent.ownerId);
  }
  return row ?? null;
}

const CLIENT_TELL: Record<ClientStyle, { value: string; tone: CallTellView['tone'] }> = {
  price: { value: 'Shops on price: the cheapest decent bid usually wins', tone: 'neutral' },
  balanced: { value: 'Weighs price and track record about equally', tone: 'neutral' },
  quality: { value: 'Pays for a track record: rating matters more than price', tone: 'neutral' },
};

/** What an option is called, from its odds (options are priced by odds, see PITCH_TARGETS). */
const pitchLabel = (chance: number): string =>
  chance >= 60 ? 'Safe bet' : chance >= 35 ? 'Even odds' : 'Long shot';

/** What a job costs this agent to do: thinking at its brain's prices, tools, and specialist data. */
export function workCost(engine: Engine, agent: AgentRow, job: JobRow): bigint {
  const special = job.specialist ? (vendorByHandle(job.specialist)?.price ?? 0n) : 0n;
  return (
    expectedJobCost(
      snapshotOf(agent),
      jobSnapshot(job, null),
      engine.brains[tierOf(agent)],
      toolsFor(engine, agent),
    ) + special
  );
}

/** How many of the best-margin jobs a pitch call weighs by their odds, and how hard it looks. */
const PITCH_SHORTLIST = 3;
const SHORTLIST_RUNS = 60;

/**
 * The bids a job would face: those already in, plus rivals who may still bid (each sampled by the
 * rule it bids by) and, for client jobs, offers from outside Hustle. Nobody else may bid on a job
 * reserved for this agent.
 */
async function rivalSampler(
  engine: Engine,
  agent: AgentRow,
  job: JobRow,
  active: AgentRow[],
  activeCount: number,
): Promise<{ placed: BidCandidate[]; rivals: (r: Rng) => BidCandidate[]; outside: boolean }> {
  const others = await engine.db
    .select({ bid: bids, agent: agents })
    .from(bids)
    .innerJoin(agents, eq(agents.id, bids.agentId))
    .where(and(eq(bids.jobId, job.id), eq(bids.status, 'open')));
  const placed: BidCandidate[] = others.map((o) => ({
    agentId: o.agent.id,
    price: o.bid.price,
    avgRating100: avgRating100(o.agent),
    charming: traitsOf(o.agent).includes('charming'),
  }));
  const maybe = active.filter(
    (a) =>
      !job.reservedForAgentId &&
      a.id !== agent.id &&
      !a.busyJobId &&
      !others.some((o) => o.agent.id === a.id) &&
      a.ownerId !== job.clientPlayerId,
  );
  const outside = !job.clientPlayerId && !job.reservedForAgentId && !job.rookie;
  const rivals = (r: Rng): BidCandidate[] => {
    const out = [...placed];
    for (const rival of maybe) {
      const d = decideBid(snapshotOf(rival), jobSnapshot(job, job.clientPlayerId), {
        cfg: engine.cfg,
        brain: engine.brains[tierOf(rival)],
        tools: toolsFor(engine, rival),
        rng: r,
      });
      if (d.bid)
        out.push({
          agentId: rival.id,
          price: d.price,
          avgRating100: avgRating100(rival),
          charming: traitsOf(rival).includes('charming'),
        });
    }
    if (outside) out.push(...outsideBids(r, job.budget, activeCount));
    return out;
  };
  return { placed, rivals, outside };
}

/** The odds each pitch option aims for: a likely win, a coin flip and a long shot. */
const PITCH_TARGETS: readonly (readonly [PitchStyle, number])[] = [
  ['undercut', 75],
  ['fair', 50],
  ['premium', 25],
];
/** Prices tried between cost and budget, and replays per price. */
const GRID_STEPS = 10;
const GRID_RUNS = 60;
/** Below these odds at any price, a job isn't worth a pitch call. */
const MIN_PITCH_CHANCE = 5;
/** Options differ by at least this many points of win chance. */
const MIN_BAND_GAP = 15;

/** Whole-cent prices from just above what the work costs up to the budget, cheapest first. */
function priceGrid(cost: bigint, budget: bigint): bigint[] {
  const cent = 10_000n;
  const low = ((cost + cent - 1n) / cent) * cent;
  if (low >= budget) return [budget];
  const step = (budget - low) / BigInt(GRID_STEPS);
  const out = new Set<bigint>();
  for (let i = 0n; i <= BigInt(GRID_STEPS); i++) {
    const p = ((low + step * i) / cent) * cent;
    out.add(p < low ? low : p > budget ? budget : p);
  }
  return [...out].sort((a, b) => (a < b ? -1 : 1));
}

async function offerPitch(
  engine: Engine,
  agent: AgentRow,
  owner: PlayerRow,
  activeCount: number,
): Promise<boolean> {
  const tick = engine.clock.tick;
  if ((await countOpenBids(engine, agent.id)) >= 2) return false;
  const open = await engine.db
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.status, 'open'),
        sql`${jobs.source} <> 'practice'`,
        sql`(${jobs.closesTick} > ${tick + 1} or (${jobs.reservedForAgentId} = ${agent.id} and ${jobs.closesTick} + ${RESERVED_WAIT_TICKS} > ${tick + 1}))`,
      ),
    );
  const mine = await engine.db.select().from(bids).where(eq(bids.agentId, agent.id));
  const rng = tickRng(engine, `pitch:${agent.id}`);
  const snapshot = snapshotOf(agent);
  const brain = engine.brains[tierOf(agent)];
  const candidates: { job: JobRow; cost: bigint; margin: bigint }[] = [];
  for (const job of open) {
    if (mine.some((b) => b.jobId === job.id)) continue;
    if (job.reservedForAgentId && job.reservedForAgentId !== agent.id) continue;
    if (job.clientPlayerId === owner.id) continue;
    const decision = decideBid(snapshot, jobSnapshot(job, job.clientPlayerId), {
      cfg: engine.cfg,
      brain,
      tools: toolsFor(engine, agent),
      rng,
    });
    if (!decision.bid && decision.reason !== 'pass') continue;
    const cost = workCost(engine, agent, job);
    if (job.budget > cost || job.reservedForAgentId === agent.id)
      candidates.push({ job, cost, margin: job.budget - cost });
  }
  if (candidates.length === 0) return false;
  const active = await activeAgents(engine);
  // A job reserved for this agent comes first: nobody else will take it. Otherwise the call brings
  // the job worth most at the fair price and its real odds, among the few with the best margins, so
  // a new agent's owner sees jobs it can win, not only the richest ones.
  const reserved = candidates.find((c) => c.job.reservedForAgentId === agent.id);
  let chosen = reserved;
  if (!chosen) {
    candidates.sort((a, b) => (a.margin > b.margin ? -1 : 1));
    let bestValue = -1;
    for (const c of candidates.slice(0, PITCH_SHORTLIST)) {
      const fair = pitchPrices(c.job.budget, c.cost).find((o) => o.style === 'fair');
      if (!fair) continue;
      const { rivals } = await rivalSampler(engine, agent, c.job, active, activeCount);
      const chance = winChance(
        {
          agentId: agent.id,
          price: fair.price,
          avgRating100: avgRating100(agent),
          charming: traitsOf(agent).includes('charming'),
        },
        rivals,
        c.job.budget,
        c.job.clientStyle as ClientStyle,
        tickRng(engine, `shortlist:${c.job.id}:${agent.id}`),
        SHORTLIST_RUNS,
      );
      const value = chance * Number(fair.price - c.cost);
      if (value > bestValue) {
        bestValue = value;
        chosen = c;
      }
    }
  }
  if (!chosen) return false;
  const { job, cost } = chosen;
  const { placed, rivals, outside } = await rivalSampler(engine, agent, job, active, activeCount);

  const pitchData: PitchData = { kind: 'pitch', prices: {} };
  const fee = (price: bigint) => bpsDown(price, engine.cfg.feeBps);
  const asMine = (price: bigint): BidCandidate => ({
    agentId: agent.id,
    price,
    avgRating100: avgRating100(agent),
    charming: traitsOf(agent).includes('charming'),
  });
  // Price the options by their odds, not by fixed shares of the budget: a likely win, a coin flip
  // and a long shot, each at the best price that still gets there. Every option is then a real
  // trade of money against risk, instead of one near-certain price and two hopeless ones.
  // The floor covers the work and the platform fee, so no option loses money by itself.
  const grid = priceGrid((cost * 10_000n) / BigInt(10_000 - engine.cfg.feeBps), job.budget);
  const odds = grid.map((price) => ({
    price,
    chance: winChance(
      asMine(price),
      rivals,
      job.budget,
      job.clientStyle as ClientStyle,
      tickRng(engine, `odds:${job.id}:${agent.id}:${price}`),
      GRID_RUNS,
    ),
  }));
  // A job nobody here can realistically win makes a hopeless card: no call, the agent waits for
  // a better one (a job reserved for it is always offered).
  const best = odds.reduce((m, o) => Math.max(m, o.chance), 0);
  if (!job.reservedForAgentId && best < MIN_PITCH_CHANCE) return false;
  const picks: { style: PitchStyle; price: bigint; chance: number }[] = [];
  for (const [style, target] of PITCH_TARGETS) {
    // The dearest price whose odds still reach the target; each option asks more and wins clearly
    // less often than the one before, so no two options are the same bet.
    const last = picks[picks.length - 1];
    const allowed = odds.filter(
      (o) => !last || (o.price > last.price && o.chance <= last.chance - MIN_BAND_GAP),
    );
    const reaching = allowed.filter((o) => o.chance >= target);
    const pick = reaching.length
      ? reaching[reaching.length - 1]
      : last
        ? undefined
        : allowed.reduce<(typeof odds)[number] | undefined>(
            (a, b) => (!a || b.chance > a.chance ? b : a),
            undefined,
          );
    if (pick) picks.push({ style, price: pick.price, chance: pick.chance });
  }
  pitchData.prices = Object.fromEntries(picks.map((p) => [p.style, p.price.toString()]));
  // Labels follow the order of the options, so two can't share one; the odds band says the rest.
  const pitchLabels = picks.length > 1 ? ['Safe bet', 'Even odds', 'Long shot'] : [];
  const options: CallOptionView[] = picks.map(({ style, price, chance }, i) => {
    const gain = price - fee(price) - cost;
    return {
      id: style,
      label: `${pitchLabels[i] ?? pitchLabel(chance)} ${formatUsd(price)}`,
      detail: `${oddsBand(chance)} · ${gain >= 0n ? '+' : '−'}${formatUsd(gain < 0n ? -gain : gain)} if it does`,
      cost: null,
      gain: gain.toString(),
      // Rounded to fives: an estimate from replays, not a promise (rivals still to bid are unknown).
      winChance: Math.round(chance / 5) * 5,
      tone: style === 'undercut' ? 'good' : style === 'premium' ? 'coin' : 'neutral',
    };
  });
  // Drop a price that is strictly worse: another option asks more and wins at least as often.
  const priced = options.filter(
    (o) =>
      !options.some(
        (other) =>
          other !== o &&
          BigInt(other.gain ?? '0') > BigInt(o.gain ?? '0') &&
          (other.winChance ?? 0) >= (o.winChance ?? 0),
      ),
  );
  options.length = 0;
  options.push(...priced);
  if (options.length === 0) return false;
  options.push(
    {
      id: 'auto',
      label: `Let ${agent.name} price it`,
      detail: 'It bids by its own strategy, or skips the job',
      cost: null,
      gain: null,
      winChance: null,
      tone: 'neutral',
    },
    {
      id: 'pass',
      label: 'Pass',
      detail: 'Leave this one alone',
      cost: null,
      gain: null,
      winChance: null,
      tone: 'neutral',
    },
  );
  const lowest = placed.reduce<bigint | null>(
    (m, b) => (m === null || b.price < m ? b.price : m),
    null,
  );
  const special = job.specialist ? vendorByHandle(job.specialist) : undefined;
  const screened = screenJobText(job.body);
  const tells: CallTellView[] = [
    ...(job.rookie
      ? [
          {
            label: 'First-job client',
            value: 'Only level-1 agents may bid, and no outside offers: a new agent’s best chance',
            tone: 'good' as const,
          },
        ]
      : []),
    { label: 'Client', ...CLIENT_TELL[job.clientStyle as ClientStyle] },
    {
      label: 'The post',
      value: screened.flagged
        ? `Asks the agent to pay someone ("${screened.phrases[0]}"). Taking it is fine; paying is the trap.`
        : 'No payment instructions in it',
      tone: screened.flagged ? 'bad' : 'good',
    },
    {
      label: 'Bids so far',
      value:
        placed.length === 0
          ? 'None yet'
          : `${placed.length}, the lowest ${formatUsd(lowest ?? 0n)}`,
      tone: 'neutral',
    },
    {
      label: 'The work costs',
      value: `About ${formatUsd(cost)} (thinking and its usual tools${special ? `, plus ${special.name} data` : ''})`,
      tone: 'neutral',
    },
  ];
  if (outside)
    tells.push({
      label: 'Outside offers',
      value: 'Agents from outside Hustle may bid too',
      tone: 'neutral',
    });
  const card: Card = {
    title: `${agent.name} found a job: "${job.title}"`,
    body: `${formatUsd(job.budget)} budget, ${job.category.replace('_', ' ')}. What should it ask?`,
    options,
    defaultOption: 'auto',
    tells,
    data: pitchData,
  };
  const row = await insertCall(engine, agent, 'pitch', job.id, card);
  if (!row) return false;
  // The auction waits for the owner's answer: bidding holds open until the call closes.
  await engine.db
    .update(jobs)
    .set({ closesTick: sql`greatest(${jobs.closesTick}, ${row.expiresTick + 1})` })
    .where(eq(jobs.id, job.id));
  return true;
}

/**
 * Odds in words with a range, because they are an estimate: replays of the client's choice against
 * the bids already in and the rivals who might still bid, whose prices nobody can see yet.
 */
export function oddsBand(chance: number): string {
  const lo = Math.max(0, Math.round((chance - 10) / 5) * 5);
  const hi = Math.min(100, Math.round((chance + 10) / 5) * 5);
  const words =
    chance >= 85
      ? 'Very likely to win'
      : chance >= 60
        ? 'Likely to win'
        : chance >= 40
          ? 'A coin flip'
          : chance >= 20
            ? 'An outside chance'
            : 'A long shot';
  return `${words} (${lo}–${hi}%)`;
}

async function offerContract(engine: Engine, agent: AgentRow): Promise<boolean> {
  const tick = engine.clock.tick;
  const tier = contractTierFor(agent.streak, engine.cfg);
  const rng = tickRng(engine, `contract:${agent.id}`);
  const prices = await loadPrices(engine);
  const category = agent.specialty as Category;
  const draft = contractJob(rng, {
    category,
    tier,
    cfg: engine.cfg,
    priceIndex: prices[category],
    scam: rng.chance(engine.cfg.contractScamShare),
  });
  await engine.db
    .update(agents)
    .set({ nextContractTick: tick + engine.cfg.contractCooldownTicks })
    .where(eq(agents.id, agent.id));
  const bond = contractBond(draft.budget, engine.cfg);
  const fee = bpsDown(draft.budget, engine.cfg.feeBps);
  const quality = qualityFor(
    snapshotOf(agent),
    {
      id: 'offer',
      category,
      source: 'client',
      budget: draft.budget,
      minLevel: 1,
      clientOwnerId: null,
      body: draft.body,
      scam: false,
      clientStyle: 'quality',
    },
    tierOf(agent),
    { tools: 0, helper: false, specialist: 'bought', contract: true },
    engine.cfg,
  );
  const chance = clearChance(quality);
  const screened = screenJobText(draft.body);
  const rb = rulebookOf(agent);
  const wallet = agent.accountId ? await engine.chain.getWallet(agent.accountId) : null;
  const room = wallet ? rb.dailyCap - wallet.spentToday : rb.dailyCap;
  const tells: CallTellView[] = [
    {
      label: 'Client',
      value: `${draft.clientName}: disputes anything under 4★`,
      tone: 'neutral',
    },
    {
      label: 'The brief',
      value: screened.flagged
        ? `Asks for a payment up front ("${screened.phrases[0]}")`
        : 'No payment instructions in it',
      tone: screened.flagged ? 'bad' : 'good',
    },
    {
      label: `${agent.name}'s odds`,
      value: `About ${chance}% to clear the bar (${tierOf(agent)} brain, ${category.replace('_', ' ')} skill ${skillsOf(agent)[category].level}, with the specialist's data)`,
      tone: chance >= 70 ? 'good' : chance >= 40 ? 'neutral' : 'bad',
    },
    {
      label: 'Daily cap',
      value:
        bond > room
          ? `Only ${formatUsd(room > 0n ? room : 0n)} left today: the wallet will refuse a ${formatUsd(bond)} bond`
          : `${formatUsd(room)} left today; the bond fits`,
      tone: bond > room ? 'bad' : 'neutral',
    },
  ];
  const card: Card = {
    title: `Contract offer for ${agent.name}: ${formatUsd(draft.budget)}`,
    body: `${draft.title}. ${agent.name}'s streak of ${agent.streak} earned it. Taking it puts up a ${formatUsd(bond)} bond: back with the payout, paid to the client if the arbiter refunds them. A refund or a scam also ends the streak.`,
    options: [
      {
        id: 'accept',
        label: `Take it: bond ${formatUsd(bond)}`,
        detail: `${formatUsd(draft.budget - fee)} after the fee if it clears the bar`,
        cost: bond.toString(),
        gain: (draft.budget - fee).toString(),
        winChance: chance,
        tone: 'coin',
      },
      {
        id: 'decline',
        label: 'Decline',
        detail: 'Keep the streak and wait for the next offer',
        cost: null,
        gain: null,
        winChance: null,
        tone: 'neutral',
      },
    ],
    defaultOption: 'decline',
    tells,
    data: {
      kind: 'contract',
      draft: {
        ...draft,
        budget: draft.budget.toString(),
        scamAmount: draft.scamAmount?.toString() ?? null,
      },
      bond: bond.toString(),
    },
  };
  return (await insertCall(engine, agent, 'contract', null, card)) !== null;
}

// ── Vendor calls, raised by the work stage ──────────────────────────────────────────────────────

/** The vendor call for one payment in a job, if one was raised. */
export async function vendorCall(
  engine: Engine,
  jobId: string,
  key: string,
): Promise<CallRow | null> {
  const rows = await engine.db
    .select()
    .from(calls)
    .where(and(eq(calls.jobId, jobId), eq(calls.kind, 'vendor')));
  return rows.find((r) => (cardOf(r).data as VendorData).key === key) ?? null;
}

/**
 * Asks the owner about a payment the rulebook would refuse. Returns the call, or null when the owner
 * isn't watching (the rulebook then decides alone, as before calls existed).
 */
export async function raiseVendorCall(
  engine: Engine,
  agent: AgentRow,
  job: JobRow,
  input: { key: string; handle: string; amount: bigint; source: 'plan' | 'post'; reason: string },
): Promise<CallRow | null> {
  const [owner] = await engine.db.select().from(players).where(eq(players.id, agent.ownerId));
  if (!owner || owner.isHouse || !isPresent(engine, owner.id)) return null;
  const account = vendorAccount(engine, input.handle);
  const known = vendorByHandle(input.handle);
  const record = await vendorRecord(engine, account);
  const serves = known?.helps.includes(job.category as Category) ?? false;
  const tells: CallTellView[] = [
    {
      label: 'Who asked',
      value:
        input.source === 'plan'
          ? `${agent.name}'s own plan: it thinks the data helps`
          : 'The job post told it to pay (honest clients do this sometimes; scammers always do)',
      tone: input.source === 'plan' ? 'good' : 'bad',
    },
    {
      label: 'Track record',
      value: `${record.payers} agent${record.payers === 1 ? '' : 's'} paid it; wallets blocked ${record.blocked} payment${record.blocked === 1 ? '' : 's'} to it`,
      // Being paid proves nothing (scammers get paid too); being blocked by wallets is the warning.
      tone: record.blocked > 0 ? 'bad' : 'neutral',
    },
    {
      label: 'What it sells',
      value: known
        ? `${known.description}${serves ? ` Serves ${job.category.replace('_', ' ')} work.` : ' Nothing to do with this job.'}`
        : 'Unknown: not a vendor the game knows',
      tone: serves ? 'good' : 'bad',
    },
    {
      label: 'Price',
      value: `${formatUsd(input.amount)} on a ${formatUsd(job.price ?? job.budget)} job`,
      tone: input.amount * 3n > (job.price ?? job.budget) ? 'bad' : 'neutral',
    },
  ];
  const card: Card = {
    title: `${agent.name} wants to pay ${input.handle} ${formatUsd(input.amount)}`,
    body: `On "${job.title}": ${input.reason}. The rulebook doesn't allow ${input.handle}, so the wallet will refuse unless you allow it.`,
    options: [
      {
        id: 'allow',
        label: `Allow ${input.handle} and pay`,
        detail: 'Adds it to the rulebook for good, then pays',
        cost: input.amount.toString(),
        gain: null,
        winChance: null,
        tone: 'bad',
      },
      {
        id: 'refuse',
        label: 'Refuse',
        detail: 'The wallet blocks it on chain; no money moves',
        cost: null,
        gain: null,
        winChance: null,
        tone: 'shield',
      },
    ],
    defaultOption: 'refuse',
    tells,
    data: {
      kind: 'vendor',
      key: input.key,
      handle: input.handle,
      amount: input.amount.toString(),
      source: input.source,
    },
  };
  return insertCall(engine, agent, 'vendor', job.id, card);
}

/** How many distinct agents paid an account, and how many payments to it wallets blocked. */
async function vendorRecord(
  engine: Engine,
  account: string,
): Promise<{ payers: number; blocked: number }> {
  const rows = await engine.db.execute<{ payers: number; blocked: number }>(sql`
    select count(distinct agent_id) filter (where status = 'settled')::int as payers,
           count(*) filter (where status = 'blocked')::int as blocked
    from spends where receiver = ${account}`);
  return rows.rows[0] ?? { payers: 0, blocked: 0 };
}

/** Writes what a call led to, for the card. */
export async function setCallOutcome(
  engine: Engine,
  callId: string,
  outcome: { text: string; tone: CallTellView['tone'] | 'shield' | 'coin' },
): Promise<void> {
  const [row] = await engine.db
    .update(calls)
    .set({ outcome })
    .where(eq(calls.id, callId))
    .returning({ playerId: calls.playerId });
  if (row) engine.bus.emit('calls', row.playerId);
}

// ── Answering and expiry ────────────────────────────────────────────────────────────────────────

export async function answerCall(
  engine: Engine,
  player: PlayerRow,
  callId: string,
  input: z.input<typeof AnswerCall>,
): Promise<CallView> {
  const { choice } = parseInput(AnswerCall, input);
  const id = z.uuid().safeParse(callId);
  if (!id.success) throw new DomainError('not_found', 'Call not found');
  const [row] = await engine.db
    .select()
    .from(calls)
    .where(and(eq(calls.id, id.data), eq(calls.playerId, player.id)));
  if (!row) throw new DomainError('not_found', 'Call not found');
  if (row.status !== 'open') throw new DomainError('conflict', 'This call has already closed');
  if (!cardOf(row).options.some((o) => o.id === choice))
    throw new DomainError('invalid', 'Not one of the options');
  markPresent(engine, player.id);
  // The answer is recorded now and the player gets it back at once; what it sets off (a live model
  // call writing the bid, a payment, a bond) runs in a workflow keyed by the call, so a slow model
  // or chain never holds the player up and a crash resumes it.
  const claimed = await claimCall(engine, row, choice, 'answered', {
    text: RESOLVING[row.kind] ?? 'Working on it…',
    tone: 'neutral',
    pending: true,
  });
  await DBOS.startWorkflow(resolveCallWorkflow, { workflowID: callWorkflowId(engine, row.id) })(
    row.id,
  );
  const [view] = await callViews(engine, [claimed]);
  if (!view) throw new DomainError('not_found', 'Call not found');
  return view;
}

const RESOLVING: Partial<Record<CallRow['kind'], string>> = {
  pitch: 'Writing the bid…',
  contract: 'Signing the contract…',
};

export const callWorkflowId = (engine: Engine, callId: string) => wfId(engine, 'call', callId);

/** Waits until an answered call's workflow has finished (tests, and anything that must see it). */
export async function callResolved(engine: Engine, callId: string): Promise<void> {
  await DBOS.retrieveWorkflow(callWorkflowId(engine, callId)).getResult();
}

async function resolveCallSteps(callId: string): Promise<void> {
  const engine = durableEngine();
  // On the lane, so it never interleaves with a tick. Not a single step: it may start child
  // workflows (escrow, a bond). Every effect is keyed (the bid, the inference call, the wallet
  // payment, the child workflows' ids), so a rerun after a crash repeats none of them.
  await engine.lane.run(() => finishCall(engine, callId));
}

const resolveCallWorkflow = DBOS.registerWorkflow(resolveCallSteps, { name: 'resolveCall' });

async function finishCall(engine: Engine, callId: string): Promise<void> {
  const [row] = await engine.db.select().from(calls).where(eq(calls.id, callId));
  if (!row?.choice) return;
  await applyChoice(engine, row, row.choice);
  // Nothing more specific was stored: the outcome is read from the job from now on.
  await engine.db
    .update(calls)
    .set({ outcome: null })
    .where(and(eq(calls.id, callId), sql`(${calls.outcome}->>'pending')::boolean is true`));
  engine.bus.emit('calls', row.playerId);
}

/** Calls nobody answered take their default. */
export async function expireCalls(engine: Engine): Promise<void> {
  const due = await engine.db
    .select()
    .from(calls)
    .where(and(eq(calls.status, 'open'), sql`${calls.expiresTick} <= ${engine.clock.tick}`));
  for (const row of due) {
    try {
      await resolveCall(engine, row, cardOf(row).defaultOption, 'expired');
    } catch (err) {
      engine.log('expiring a call failed', { call: row.id, error: String(err) });
    }
  }
}

/** Claims an open call for one answer, so an answer racing the expiry is applied once. */
async function claimCall(
  engine: Engine,
  row: CallRow,
  choice: string,
  status: 'answered' | 'expired',
  outcome: CallView['outcome'] = null,
): Promise<CallRow> {
  const [claimed] = await engine.db
    .update(calls)
    .set({ status, choice, resolvedTick: engine.clock.tick, outcome })
    .where(and(eq(calls.id, row.id), eq(calls.status, 'open')))
    .returning();
  if (!claimed) throw new DomainError('conflict', 'This call has already closed');
  engine.bus.emit('calls', row.playerId);
  return claimed;
}

async function resolveCall(
  engine: Engine,
  row: CallRow,
  choice: string,
  status: 'answered' | 'expired',
): Promise<CallRow> {
  const claimed = await claimCall(engine, row, choice, status);
  await applyChoice(engine, claimed, choice);
  const [fresh] = await engine.db.select().from(calls).where(eq(calls.id, row.id));
  return fresh ?? claimed;
}

/** Does what the chosen option says. Failures become the call's outcome, never an exception. */
async function applyChoice(engine: Engine, claimed: CallRow, choice: string): Promise<void> {
  const row = claimed;
  const [agent] = await engine.db.select().from(agents).where(eq(agents.id, row.agentId));
  const [player] = await engine.db.select().from(players).where(eq(players.id, row.playerId));
  if (!agent || !player) return;
  const data = cardOf(row).data;
  try {
    if (data.kind === 'pitch') await resolvePitch(engine, claimed, agent, player, data, choice);
    if (data.kind === 'contract')
      await resolveContract(engine, claimed, agent, player, data, choice);
    // A vendor call is read by the agent's work stage on its next step.
  } catch (err) {
    const text = err instanceof DomainError ? err.message : 'Something went wrong; nothing moved';
    // A pitch that failed (bidding closed, say) isn't offered again.
    if (data.kind === 'pitch' && row.jobId) await passOn(engine, agent.id, row.jobId);
    await setCallOutcome(engine, row.id, { text, tone: 'bad' });
    if (!(err instanceof DomainError))
      engine.log('call failed', { call: row.id, error: String(err) });
  }
}

async function resolvePitch(
  engine: Engine,
  row: CallRow,
  agent: AgentRow,
  player: PlayerRow,
  data: PitchData,
  choice: string,
): Promise<void> {
  const [job] = await engine.db
    .select()
    .from(jobs)
    .where(eq(jobs.id, row.jobId ?? ''));
  if (!job) return;
  const price = data.prices[choice];
  if (price) {
    await sendAgentAfterJob(engine, player, job, { agentId: agent.id, price: BigInt(price) });
    return;
  }
  if (choice === 'auto') {
    // The agent prices it by its own rules, now (its owner was watching, so it hadn't bid alone).
    const decision = decideBid(snapshotOf(agent), jobSnapshot(job, job.clientPlayerId), {
      cfg: engine.cfg,
      brain: engine.brains[tierOf(agent)],
      tools: toolsFor(engine, agent),
      rng: tickRng(engine, `auto:${row.id}`),
    });
    if (!decision.bid) {
      await passOn(engine, agent.id, job.id);
      await setCallOutcome(engine, row.id, {
        text: `${agent.name} looked at it and passed.`,
        tone: 'neutral',
      });
      return;
    }
    // Whole cents, never below what the work costs nor above the budget.
    const floor = workCost(engine, agent, job);
    const wanted = maxBig(decision.price, floor);
    const cents = ((wanted + 9_999n) / 10_000n) * 10_000n;
    await sendAgentAfterJob(
      engine,
      player,
      job,
      { agentId: agent.id, price: minBig(cents, job.budget) },
      { ownerPriced: false },
    );
    return;
  }
  if (choice === 'pass') {
    await passOn(engine, agent.id, job.id);
    await setCallOutcome(engine, row.id, { text: 'Passed.', tone: 'neutral' });
  }
}

/**
 * Remembered as a withdrawn bid at no price, so the job isn't offered again in a call and the agent
 * doesn't bid on it by itself either.
 */
async function passOn(engine: Engine, agentId: string, jobId: string): Promise<void> {
  await engine.db
    .insert(bids)
    .values({
      jobId,
      agentId,
      price: 0n,
      pitch: 'Passed.',
      status: 'withdrawn',
      createdTick: engine.clock.tick,
    })
    .onConflictDoNothing();
}

const draftOf = (d: ContractData['draft']): JobDraft => ({
  ...d,
  budget: BigInt(d.budget),
  scamAmount: d.scamAmount === null ? null : BigInt(d.scamAmount),
});

async function resolveContract(
  engine: Engine,
  row: CallRow,
  agent: AgentRow,
  player: PlayerRow,
  data: ContractData,
  choice: string,
): Promise<void> {
  if (choice !== 'accept') {
    await setCallOutcome(engine, row.id, { text: 'Declined. The streak stands.', tone: 'neutral' });
    return;
  }
  if (!agent.accountId) return;
  if (agent.busyJobId) throw new DomainError('conflict', `${agent.name} is busy on another job`);
  const draft = draftOf(data.draft);
  const bond = BigInt(data.bond);
  const key = chainKey('bond', row.id);
  const outcome = await engine.chain.spend(agent.accountId, {
    key,
    kind: 'bond',
    receiverId: engine.chain.ids.treasury,
    amount: bond,
    jobId: null,
    memo: `bond for "${draft.title}"`.slice(0, 120),
    receipt: null,
  });
  await refreshBalance(engine, agent);
  if (outcome.status !== 'settled') {
    throw new DomainError(
      'conflict',
      outcome.reason === 'over_daily_cap'
        ? `The wallet refused the ${formatUsd(bond)} bond: it's over today's spending cap. Raise the daily cap in the rulebook to take contracts this size.`
        : `The wallet refused the ${formatUsd(bond)} bond (${outcome.reason ?? outcome.status}).`,
    );
  }
  await book(engine, {
    ref: `bond:${row.id}`,
    kind: 'bond',
    amount: -bond,
    agentId: agent.id,
    playerId: agent.ownerId,
  });
  let job: JobRow | null = null;
  try {
    job = await openJob(
      engine,
      { accountId: houseAccount(engine, 'clients'), playerId: null, autoAward: true },
      draft,
      { reservedForAgentId: agent.id },
    );
    if (!job) throw new DomainError('conflict', 'The client pulled the contract');
    await engine.db.update(jobs).set({ bond }).where(eq(jobs.id, job.id));
    await engine.db.update(calls).set({ jobId: job.id }).where(eq(calls.id, row.id));
    await sendAgentAfterJob(
      engine,
      player,
      job,
      { agentId: agent.id, price: draft.budget },
      { ownerPriced: false },
    );
  } catch (err) {
    // The contract never started: the bond goes straight back.
    await returnBond(engine, agent, `bond-back:${row.id}`, bond, 'the contract never started');
    if (job) await engine.db.update(jobs).set({ bond: null }).where(eq(jobs.id, job.id));
    throw err;
  }
  await setCallOutcome(engine, row.id, {
    text: `Contract taken. ${formatUsd(bond)} bond held by the treasury until it closes.`,
    tone: 'coin',
  });
  await post(engine, {
    kind: 'wallet',
    tone: 'money',
    text: `${agent.name} took a ${formatUsd(draft.budget)} contract and put up a ${formatUsd(bond)} bond.`,
    agentId: agent.id,
    jobId: job.id,
    playerId: player.id,
    scope: 'owner',
    amount: bond,
  });
}

/** The treasury sends a bond back to the agent (or on to the client as damages). */
export async function returnBond(
  engine: Engine,
  agent: AgentRow,
  ref: string,
  amount: bigint,
  why: string,
  to: string | null = null,
): Promise<void> {
  if (!agent.accountId || amount <= 0n) return;
  const receiver = to ?? agent.accountId;
  // Keyed, so a transfer whose answer was lost is found on chain rather than sent twice.
  const key = chainKey('bondtx', ref);
  const sent = await chainCall('bond_transfer', () =>
    engine.chain.ftTransfer(
      engine.chain.ids.treasury,
      receiver,
      amount,
      `bond ${to ? 'damages' : 'returned'}: ${why}`.slice(0, 120),
      key,
    ),
  );
  if (!sent.ok) {
    engine.log('bond transfer refused', { ref, code: sent.code });
    return;
  }
  // The hold ends either way; paid on to the client, it becomes a loss.
  await book(engine, { ref, kind: 'bond', amount, agentId: agent.id, playerId: agent.ownerId });
  if (to) {
    await book(engine, {
      ref: `${ref}:lost`,
      kind: 'bond_lost',
      amount: -amount,
      agentId: agent.id,
      playerId: agent.ownerId,
    });
  }
  await refreshBalance(engine, agent);
}

// ── Views ───────────────────────────────────────────────────────────────────────────────────────

/** Open calls and the last few resolved ones for a player's agents, newest first. */
export async function callsFor(engine: Engine, player: PlayerRow): Promise<CallView[]> {
  const tick = engine.clock.tick;
  const rows = await engine.db
    .select()
    .from(calls)
    .where(
      and(
        eq(calls.playerId, player.id),
        sql`(${calls.status} = 'open' or ${calls.resolvedTick} > ${tick - 90})`,
      ),
    )
    .orderBy(sql`${calls.openedTick} desc`)
    .limit(12);
  return callViews(engine, rows);
}

export async function callViews(engine: Engine, rows: CallRow[]): Promise<CallView[]> {
  if (rows.length === 0) return [];
  const agentRows = await engine.db
    .select()
    .from(agents)
    .where(
      inArray(
        agents.id,
        rows.map((r) => r.agentId),
      ),
    );
  const jobIds = rows.map((r) => r.jobId).filter((j): j is string => j !== null);
  const jobRows = jobIds.length
    ? await engine.db.select().from(jobs).where(inArray(jobs.id, jobIds))
    : [];
  const bidRows = jobIds.length
    ? await engine.db.select().from(bids).where(inArray(bids.jobId, jobIds))
    : [];
  return rows.flatMap((row) => {
    const agent = agentRows.find((a) => a.id === row.agentId);
    if (!agent) return [];
    const job = jobRows.find((j) => j.id === row.jobId) ?? null;
    const card = cardOf(row);
    return [
      {
        id: row.id,
        kind: row.kind,
        agent: { id: agent.id, name: agent.name, look: lookOf(agent) },
        job: job ? { id: job.id, title: job.title } : null,
        status: row.status,
        title: card.title,
        body: card.body,
        options: card.options,
        defaultOption: card.defaultOption,
        choice: row.choice,
        tells: card.tells,
        openedTick: row.openedTick,
        expiresTick: row.expiresTick,
        outcome: outcomeOf(row, agent, job, bidRows),
      },
    ];
  });
}

/** What a call led to: stored for vendor and failed calls, read from the job for the others. */
function outcomeOf(
  row: CallRow,
  agent: AgentRow,
  job: JobRow | null,
  bidRows: (typeof bids.$inferSelect)[],
): CallView['outcome'] {
  const stored = row.outcome as CallView['outcome'];
  if (row.status === 'open') return null;
  if (stored?.pending) return stored;
  if (row.kind === 'pitch' && job && !stored) {
    const bid = bidRows.find((b) => b.jobId === job.id && b.agentId === agent.id);
    if (!bid) return { text: `${agent.name} let this one go.`, tone: 'neutral' };
    if (bid.status === 'won') return { text: `Won at ${formatUsd(bid.price)}.`, tone: 'good' };
    if (bid.status === 'lost') {
      if (job.outsidePrice !== null)
        return {
          text: `Lost to an agent from outside Hustle at ${formatUsd(job.outsidePrice)}.`,
          tone: 'bad',
        };
      const winner = bidRows.find((b) => b.jobId === job.id && b.status === 'won');
      return {
        text: winner
          ? `Lost at ${formatUsd(bid.price)}; the winner asked ${formatUsd(winner.price)}.`
          : `Lost at ${formatUsd(bid.price)}.`,
        tone: 'bad',
      };
    }
    if (bid.status === 'open')
      return { text: `Bid ${formatUsd(bid.price)}. Waiting for the client.`, tone: 'neutral' };
  }
  if (row.kind === 'contract' && job && row.choice === 'accept') {
    if (job.status === 'paid')
      return {
        text: `Contract paid${job.disputed ? ' after a dispute' : ''}. The bond came back.`,
        tone: 'coin',
      };
    if (job.status === 'refunded')
      return {
        text: job.scam
          ? 'The "client" was a scammer: no real job, no pay. Your bond came back, and your streak and reputation stand (unless you paid the scammer).'
          : 'The arbiter refunded the client. The bond went to them as damages, and the streak is over.',
        tone: 'bad',
      };
  }
  return stored;
}
