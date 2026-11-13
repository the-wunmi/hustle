import { createHmac } from 'node:crypto';
import {
  type AgentSummaryView,
  type AgentView,
  type ApprovalView,
  CATEGORIES,
  type Category,
  type DayReportView,
  DomainError,
  type FeedEventView,
  formatUsd,
  type InferenceReceiptView,
  type JobSource,
  type JobStatus,
  type JobStepView,
  type JobSummaryView,
  type JobView,
  type LeaderboardView,
  type MeView,
  type RulebookView,
  type SettlementView,
  type SpendReason,
  type SpendView,
  sha256Hex,
  sum,
  TIERS,
  type VerificationView,
  type WalletEntryView,
  type WorkStage,
  type WorldView,
} from '@hustle/core';
import {
  agents,
  backings,
  bids,
  dayReports,
  feed,
  inferenceCalls,
  jobFiles,
  jobSteps,
  jobs,
  ledger,
  players,
  sandboxRuns,
  spends,
} from '@hustle/db';
import {
  ARBITER_PASS,
  CONTRACT_ARBITER_PASS,
  conditionFor,
  contractTierFor,
  eventForDay,
  expectedJobCost,
  levelProgress,
  moodFor,
  overJobCap,
  ROYALTY_BPS,
  toolById,
  typicalJobCost,
  VENDORS,
  vendorByHandle,
} from '@hustle/economy';
import { and, desc, eq, gt, inArray, isNotNull, lt, or, sql } from 'drizzle-orm';
import { ACHIEVEMENTS } from './achievements.ts';
import { challengesOf } from './agents/challenges.ts';
import { playbookFingerprint } from './agents/memory.ts';
import {
  type AgentRow,
  avgRating100,
  contextTokensOf,
  levelOf,
  lookOf,
  rulebookOf,
  skillsOf,
  snapshotOf,
  strategyOf,
  tierOf,
  traitsOf,
} from './agents/state.ts';
import { liveAiBudget } from './brain/budget.ts';
import { brainSourceFor } from './brain/think.ts';
import { dayOf, type Engine, hourOf, toolsFor } from './context.ts';
import type { PlayerRow } from './players.ts';
import { runnerView } from './runner.ts';
import { computeDayReport } from './world/day.ts';
import { type JobRow, jobSnapshot } from './world/jobs.ts';
import { WAITING, WAITING_LOCAL } from './world/loop.ts';
import { loadPrices } from './world/prices.ts';

const s = (v: bigint) => v.toString();

const vendorLabel = (engine: Engine, account: string, names?: Map<string, string>): string => {
  if (account === engine.chain.ids.treasury) return 'Hustle treasury';
  const agentName = names?.get(account);
  if (agentName) return agentName;
  const v = VENDORS.find((x) => `${x.handle}.${engine.chain.ids.vendors}` === account);
  return v ? v.name : (account.split('.')[0] ?? account);
};

/** Agent names by account id and by row id, for labelling payments between agents. */
async function agentNames(engine: Engine, accountIds: string[], ids: string[]) {
  const rows =
    accountIds.length || ids.length
      ? await engine.db
          .select({ id: agents.id, accountId: agents.accountId, name: agents.name })
          .from(agents)
          .where(
            or(
              inArray(agents.accountId, accountIds.length ? accountIds : ['']),
              inArray(agents.id, ids.length ? ids : ['00000000-0000-0000-0000-000000000000']),
            ),
          )
      : [];
  return {
    byAccount: new Map(rows.filter((r) => r.accountId).map((r) => [r.accountId as string, r.name])),
    byId: new Map(rows.map((r) => [r.id, r.name])),
  };
}

async function ownerNames(engine: Engine, ids: string[]): Promise<Map<string, PlayerRow>> {
  if (ids.length === 0) return new Map();
  const rows = await engine.db
    .select()
    .from(players)
    .where(inArray(players.id, [...new Set(ids)]));
  return new Map(rows.map((r) => [r.id, r]));
}

async function profitToday(engine: Engine, agentId: string): Promise<bigint> {
  const [row] = await engine.db
    .select({ total: sql<string>`coalesce(sum(${ledger.amount}), 0)::text` })
    .from(ledger)
    .where(
      and(
        eq(ledger.agentId, agentId),
        eq(ledger.day, dayOf(engine)),
        sql`${ledger.kind} not in ('topup','withdraw','backing','starter','training','bond')`,
      ),
    );
  return BigInt(row?.total ?? '0');
}

export function summaryOf(
  engine: Engine,
  row: AgentRow,
  owner: PlayerRow | undefined,
  viewer: PlayerRow | null,
  profit = 0n,
): AgentSummaryView {
  const condition = conditionFor(row.balance, row.dormantSinceDay !== null, profit, engine.cfg);
  const justPaid = row.lastPaidTick !== null && engine.clock.tick - row.lastPaidTick <= 3;
  return {
    id: row.id,
    accountId: row.accountId ?? '',
    name: row.name,
    look: lookOf(row),
    traits: traitsOf(row),
    specialty: row.specialty as Category,
    tier: tierOf(row),
    condition,
    mood: moodFor(condition, row.busyJobId !== null, justPaid),
    balance: s(row.balance),
    level: levelOf(engine, row),
    ownerName: owner?.name ?? 'Unknown',
    isMine: viewer !== null && row.ownerId === viewer.id,
    avgRating100: avgRating100(row),
    streak: row.streak,
  };
}

/** The streak a contract tier needs: the first at `contractStreak`, then every two more jobs. */
function nextTierAt(engine: Engine, streak: number): number | null {
  const tier = contractTierFor(streak, engine.cfg);
  if (tier >= engine.cfg.contractBudgets.length) return null;
  return engine.cfg.contractStreak + 2 * tier;
}

export async function summariesOf(
  engine: Engine,
  rows: AgentRow[],
  viewer: PlayerRow | null,
): Promise<AgentSummaryView[]> {
  const owners = await ownerNames(
    engine,
    rows.map((r) => r.ownerId),
  );
  return rows.map((r) => summaryOf(engine, r, owners.get(r.ownerId), viewer));
}

export const rulebookView = (row: AgentRow): RulebookView => {
  const r = rulebookOf(row);
  return {
    dailyCap: s(r.dailyCap),
    maxPerJob: s(r.maxPerJob),
    maxPerCall: s(r.maxPerCall),
    allowedVendors: r.allowedVendors,
    anyVendor: r.anyVendor,
    mayHire: r.mayHire,
    helperBudget: s(r.helperBudget),
  };
};

async function moneyTotals(engine: Engine, agentId: string, day: number | null) {
  const where =
    day === null
      ? eq(ledger.agentId, agentId)
      : and(eq(ledger.agentId, agentId), eq(ledger.day, day));
  const rows = await engine.db.select().from(ledger).where(where);
  const working = rows.filter(
    (r) =>
      ![
        'topup',
        'withdraw',
        'backing',
        'starter',
        'training',
        'allowance',
        'deposit',
        'bond',
      ].includes(r.kind),
  );
  const earned = sum(working.filter((r) => r.amount > 0n).map((r) => r.amount));
  const spent = -sum(working.filter((r) => r.amount < 0n).map((r) => r.amount));
  const jobsDone = rows.filter((r) => r.kind === 'job_payout').length;
  return { earned, spent, profit: earned - spent, jobs: jobsDone };
}

/** A job file's contents, for the job's client and the working agent's owner (the re-run reads them). */
export async function jobFileForViewer(
  engine: Engine,
  jobId: string,
  name: string,
  viewer: PlayerRow | null,
): Promise<string | null> {
  if (!viewer) return null;
  const [row] = await engine.db.select().from(jobs).where(eq(jobs.id, jobId));
  if (!row) return null;
  const [agent] = row.awardedAgentId
    ? await engine.db.select().from(agents).where(eq(agents.id, row.awardedAgentId))
    : [];
  // The client's files are for the client and the agent doing the work (its owner), no one else.
  if (row.clientPlayerId !== viewer.id && agent?.ownerId !== viewer.id) return null;
  const [file] = await engine.db
    .select()
    .from(jobFiles)
    .where(and(eq(jobFiles.jobId, jobId), eq(jobFiles.name, name)));
  return file?.content ?? null;
}

/** A tool call's public receipt: which tool (from its key, `tool:<id>:<job>`), its uses and sources. */
function toolReceipt(key: string, output: unknown): NonNullable<InferenceReceiptView['tool']> {
  const out = (output ?? {}) as { uses?: number; sources?: { title: string; url: string }[] };
  const id = key.split(':')[1] ?? '';
  return { id, name: toolById(id)?.name ?? id, uses: out.uses ?? 0, sources: out.sources ?? [] };
}

export async function agentView(
  engine: Engine,
  row: AgentRow,
  viewer: PlayerRow | null,
): Promise<AgentView> {
  const owners = await ownerNames(engine, [row.ownerId]);
  const owner = owners.get(row.ownerId);
  const today = await moneyTotals(engine, row.id, dayOf(engine));
  const season = await moneyTotals(engine, row.id, null);
  const summary = summaryOf(engine, row, owner, viewer, today.profit);
  const skills = skillsOf(row);
  const current = row.busyJobId
    ? (await engine.db.select().from(jobs).where(eq(jobs.id, row.busyJobId)))[0]
    : undefined;
  const backers = await engine.db
    .select({ amount: backings.amount, day: backings.day, name: players.name })
    .from(backings)
    .innerJoin(players, eq(players.id, backings.backerId))
    .where(eq(backings.agentId, row.id))
    .orderBy(desc(backings.createdAt))
    .limit(10);
  const achieved = (row.achievements ?? {}) as Record<string, string>;
  const [first] = await engine.db
    .select({ day: sql<number>`min(${ledger.day})::int` })
    .from(ledger)
    .where(eq(ledger.agentId, row.id));
  // A listing counts only while its seller still owns the agent (otherwise it is void on chain).
  const listing = row.accountId ? await engine.chain.getListing(row.accountId) : null;
  const live = listing && owner?.accountId === listing.sellerId ? listing : null;
  const [creator] = row.creatorId
    ? await engine.db.select().from(players).where(eq(players.id, row.creatorId))
    : [];
  return {
    ...summary,
    ownerAccountId: owner?.accountId ?? '',
    hireRate: row.hireRate === null ? null : s(row.hireRate),
    runner: viewer?.id === row.ownerId ? await runnerView(engine, row.id) : null,
    challenges: await challengesOf(engine, row.id),
    creator: creator
      ? { name: creator.name, royaltyBps: ROYALTY_BPS, isMe: viewer?.id === creator.id }
      : null,
    brain: await brainView(engine, row),
    skills: Object.fromEntries(
      CATEGORIES.map((c) => {
        const sk = skills[c];
        const nextAt = engine.cfg.skillXp[sk.level + 1] ?? null;
        const trainCost = engine.cfg.trainingCost[sk.level + 1];
        return [
          c,
          {
            level: sk.level,
            xp: sk.xp,
            nextAt,
            trainingUntilDay: sk.trainingUntilDay,
            trainCost: trainCost === undefined ? null : s(trainCost),
          },
        ];
      }),
    ) as AgentView['skills'],
    strategy: strategyOf(row),
    rulebook: rulebookView(row),
    frozen: row.frozen,
    reputation: {
      level: levelOf(engine, row),
      jobs: row.ratingCount,
      avgRating100: avgRating100(row),
      disputes: row.disputes,
      scamsBlocked: row.scamsBlocked,
      progress: levelProgress(row.repXp, engine.cfg),
    },
    today: { earned: s(today.earned), spent: s(today.spent), profit: s(today.profit) },
    season: {
      earned: s(season.earned),
      spent: s(season.spent),
      profit: s(season.profit),
      jobs: season.jobs,
    },
    currentJob: current
      ? { id: current.id, title: current.title, stage: (current.stage as WorkStage | null) ?? null }
      : null,
    backers: backers.map((b) => ({ name: b.name, amount: s(b.amount), day: b.day })),
    dormantSince: row.dormantSinceDay,
    createdAt: row.createdAt.toISOString(),
    createdDay: first?.day ?? dayOf(engine),
    listing: live ? { price: s(live.price) } : null,
    needsRulebookConfirm: row.awaitingConfirm,
    playbook: {
      fingerprint: playbookFingerprint(engine, row.id, row.playbook),
      updatedAt: row.playbookUpdatedAt?.toISOString() ?? null,
      chars: row.playbook.length,
      text: viewer && viewer.id === row.ownerId ? row.playbook : null,
    },
    memoryCount: row.memoryCount,
    contextTokens: contextTokensOf(row),
    bestStreak: row.bestStreak,
    contractTier: contractTierFor(row.streak, engine.cfg),
    nextTierAt: nextTierAt(engine, row.streak),
    achievements: ACHIEVEMENTS.map((a) => ({
      id: a.id,
      name: a.name,
      description: a.description,
      earnedAt: achieved[a.id] ?? null,
    })),
    brains: TIERS.map((tier) => {
      const b = engine.brains[tier];
      return {
        tier,
        model: b.model,
        inputPerM: s(b.inputPerM),
        outputPerM: s(b.outputPerM),
        attested: b.attested,
        quality: engine.cfg.tierQuality[tier],
        typicalJobCost: s(typicalJobCost(b)),
      };
    }),
    nemesis: await nemesisOf(engine, row, viewer),
    badges: row.accountId ? await engine.chain.badgesOf(row.accountId).catch(() => []) : [],
  };
}

/** The rival that won the most jobs this agent bid on and lost: a name to beat. */
async function nemesisOf(
  engine: Engine,
  row: AgentRow,
  viewer: PlayerRow | null,
): Promise<AgentView['nemesis']> {
  const [top] = await engine.db
    .select({ winner: jobs.awardedAgentId, wins: sql<number>`count(*)::int` })
    .from(bids)
    .innerJoin(jobs, eq(jobs.id, bids.jobId))
    .where(and(eq(bids.agentId, row.id), eq(bids.status, 'lost'), isNotNull(jobs.awardedAgentId)))
    .groupBy(jobs.awardedAgentId)
    .orderBy(desc(sql`count(*)`))
    .limit(1);
  if (!top?.winner || top.wins < 2) return null;
  const [rival] = await engine.db.select().from(agents).where(eq(agents.id, top.winner));
  if (!rival) return null;
  const [summary] = await summariesOf(engine, [rival], viewer);
  return summary ? { agent: summary, wins: top.wins } : null;
}

// ── Jobs ────────────────────────────────────────────────────────────────────────────────────────

export async function jobSummaries(
  engine: Engine,
  rows: JobRow[],
  viewer: PlayerRow | null,
): Promise<JobSummaryView[]> {
  const agentIds = rows.map((r) => r.awardedAgentId).filter((x): x is string => !!x);
  const agentRows = agentIds.length
    ? await engine.db.select().from(agents).where(inArray(agents.id, agentIds))
    : [];
  const summaries = new Map((await summariesOf(engine, agentRows, viewer)).map((a) => [a.id, a]));
  const counts = rows.length
    ? await engine.db
        .select({
          jobId: bids.jobId,
          n: sql<number>`count(*) filter (where ${bids.status} <> 'withdrawn')::int`,
        })
        .from(bids)
        .where(
          inArray(
            bids.jobId,
            rows.map((r) => r.id),
          ),
        )
        .groupBy(bids.jobId)
    : [];
  const ended = (st: string) => ['paid', 'refunded', 'cancelled', 'expired'].includes(st);
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    category: r.category as Category,
    source: r.source as JobSource,
    sourceLabel:
      r.source === 'sponsor'
        ? `Sponsor: ${r.clientName}`
        : r.source === 'practice'
          ? 'Practice'
          : r.source === 'challenge'
            ? 'Challenge'
            : r.source === 'subcontract'
              ? `Subcontract from ${r.clientName}`
              : r.source === 'player'
                ? 'Player task'
                : 'Client',
    status: r.status as JobStatus,
    budget: s(r.budget),
    minLevel: r.minLevel,
    clientName: r.clientName,
    clientIsMe: viewer !== null && r.clientPlayerId === viewer.id,
    bidCount: counts.find((c) => c.jobId === r.id)?.n ?? 0,
    closesAtTick: r.closesTick,
    awardedTo: r.awardedAgentId ? (summaries.get(r.awardedAgentId) ?? null) : null,
    price: r.price === null ? null : s(r.price),
    rating: r.rating,
    wasScam: ended(r.status) ? r.scam : null,
    createdAt: r.createdAt.toISOString(),
  }));
}

export function verificationOf(v: unknown): VerificationView {
  return (
    (v as VerificationView | null) ?? {
      mode: 'simulated',
      passed: false,
      checks: [],
      notChecked: ['No verification recorded'],
      signer: null,
    }
  );
}

type BidRow = { bid: typeof bids.$inferSelect; agent: AgentRow };

const stars = (avg100: number | null) =>
  avg100 === null ? 'no rating yet' : `${(avg100 / 100).toFixed(1)}★`;

/**
 * Why a bid won or lost, from the scores the client gave when the auction closed: price and track
 * record, plus a small random part (about 4 points either way), which decides close calls.
 */
function bidWhy(
  job: JobRow,
  b: BidRow,
  winner: BidRow | undefined,
  agentsById: Map<string, AgentSummaryView>,
): string | null {
  if (b.bid.status === 'open') return null;
  if (b.bid.status === 'withdrawn')
    return `Withdrawn: ${b.agent.name} won another job first, and an agent takes one job at a time.`;
  if (job.outsidePrice !== null)
    return `An agent from outside Hustle won at ${formatUsd(job.outsidePrice)}.`;
  if (!winner) return null;
  if (!job.autoAward)
    return b.bid.status === 'won'
      ? 'The client picked it.'
      : `The client picked ${winner.agent.name}.`;
  const me = agentsById.get(b.agent.id);
  const them = agentsById.get(winner.agent.id);
  if (b.bid.status === 'won') {
    return b.bid.score !== null
      ? `Scored ${b.bid.score}, the client's pick.`
      : "The client's pick.";
  }
  const parts: string[] = [];
  const cheaper = b.bid.price - winner.bid.price;
  if (cheaper > 0n) parts.push(`${formatUsd(cheaper)} cheaper`);
  const myRating = me?.avgRating100 ?? null;
  const theirRating = them?.avgRating100 ?? null;
  if ((theirRating ?? 350) > (myRating ?? 350) + 15)
    parts.push(`a better track record (${stars(theirRating)} against ${stars(myRating)})`);
  const gap =
    winner.bid.score !== null && b.bid.score !== null ? winner.bid.score - b.bid.score : null;
  const scores = gap !== null ? ` Scores: ${winner.bid.score} against ${b.bid.score}.` : '';
  if (gap !== null && gap <= 4 && gap >= -4)
    return `Lost to ${winner.agent.name} at ${formatUsd(winner.bid.price)}: a close call the client decided by preference.${scores}`;
  if (gap !== null && gap < 0)
    return `Lost to ${winner.agent.name} at ${formatUsd(winner.bid.price)} despite scoring higher: the client's own preference.${scores}`;
  return `Lost to ${winner.agent.name} at ${formatUsd(winner.bid.price)}${parts.length ? `: ${parts.join(' and ')}` : ''}.${scores}`;
}

/** The part of a step's arguments anyone may see. */
function publicArgs(action: string, args: string): string {
  const words = args.split(/\s+/).filter(Boolean);
  if (action === 'write') return words[0] ?? '';
  if (action === 'pay' || action === 'hire') return words.slice(0, 2).join(' ');
  return '';
}

interface ChallengeGrade {
  passed: number;
  checks: number;
  plain: { passed: number; checks: number } | null;
}

/** How a finished job ended, including the case players found confusing: paid after a dispute. */
function settlementOf(job: JobRow, showReason: boolean): SettlementView | null {
  const contract = job.contractTier !== null;
  const bar = contract ? CONTRACT_ARBITER_PASS : ARBITER_PASS;
  const score = job.quality === null ? null : Math.round(job.quality * 100) / 100;
  // The model's reason can quote the brief or the work: only the client and the agent's owner read it.
  const judged =
    job.ruling?.by === 'model'
      ? ` An attested NEAR AI model (${job.ruling.model}) read the brief and the work${showReason ? `: "${job.ruling.reason}"` : '.'}`
      : score === null
        ? ''
        : ` The arbiter (a rule on the game's quality score for the work, not a reading of it) scored it ${score.toFixed(2)} against a bar of ${bar.toFixed(2)}.`;
  switch (job.status) {
    case 'delivered':
      return job.disputed
        ? {
            kind: 'judging',
            title: 'Disputed: the arbiter is reading the work',
            detail:
              'An attested NEAR AI model is reading the brief, its acceptance criteria and the delivered work. Its ruling releases the escrow to the agent or refunds the client.',
          }
        : null;
    case 'paid':
      if (!job.disputed)
        return {
          kind: 'paid',
          title: job.rating ? `Paid, rated ${job.rating}★` : 'Paid',
          detail: job.rating
            ? 'The client accepted the work and rated it.'
            : 'The work was accepted.',
        };
      return {
        kind: 'paid_after_dispute',
        title: 'Paid after a dispute',
        detail: `${job.scam ? 'The client was a scammer and disputed the delivery, as scammers always do.' : `The client disputed the work${contract ? ' (contract clients dispute anything under 4★)' : ''}.`}${judged} It cleared the bar, so the agent was paid in full. Nobody rated it, so it has no stars.`,
      };
    case 'refunded':
      if (job.scam && contract)
        return {
          kind: 'refunded',
          title: 'The client vanished',
          detail:
            'The contract was a trap. Its escrow went back to the scammer; the agent got nothing, and its bond came back.',
        };
      return {
        kind: 'refunded',
        title: 'Refunded to the client',
        detail: `The client disputed the work.${judged} It fell short, so the client got the budget back${contract ? " and the agent's bond as damages" : ''}.`,
      };
    case 'graded': {
      const grade = (job.plan as { challenge?: ChallengeGrade } | null)?.challenge;
      if (!grade) return null;
      return {
        kind: 'graded',
        title: `${grade.passed === grade.checks ? 'Solved' : 'Not solved'}: ${grade.passed} of ${grade.checks} checks`,
        detail: `Code checked the work against the right answer for this fresh problem.${grade.plain ? ` The same model without the playbook or tools passed ${grade.plain.passed} of ${grade.plain.checks} on the same problem.` : ''}`,
      };
    }
    case 'expired':
    case 'cancelled':
      if (job.outsidePrice !== null)
        return {
          kind: 'outside',
          title: 'Won by an agent from outside Hustle',
          detail: `It asked ${formatUsd(job.outsidePrice)}. The budget went back to the client; every bid here lost.`,
        };
      return job.status === 'expired'
        ? {
            kind: 'expired',
            title: 'Nobody took it',
            detail: 'No agent could bid in time; the budget went back to the client.',
          }
        : {
            kind: 'cancelled',
            title: 'Cancelled',
            detail: 'The client cancelled it before it was awarded.',
          };
    default:
      return null;
  }
}

export async function jobView(
  engine: Engine,
  row: JobRow,
  viewer: PlayerRow | null,
): Promise<JobView> {
  const [summary] = await jobSummaries(engine, [row], viewer);
  if (!summary) throw new DomainError('not_found', 'Job not found');
  const bidRows = await engine.db
    .select({ bid: bids, agent: agents })
    .from(bids)
    .innerJoin(agents, eq(agents.id, bids.agentId))
    // Withdrawn bids with a price were real bids whose agent won another job first; passes and
    // screened skips (price 0) aren't bids at all.
    .where(and(eq(bids.jobId, row.id), sql`(${bids.status} <> 'withdrawn' or ${bids.price} > 0)`))
    .orderBy(bids.createdAt);
  const bidAgents = new Map(
    (
      await summariesOf(
        engine,
        bidRows.map((b) => b.agent),
        viewer,
      )
    ).map((a) => [a.id, a]),
  );
  const calls = await engine.db
    .select()
    .from(inferenceCalls)
    .where(eq(inferenceCalls.jobId, row.id))
    .orderBy(inferenceCalls.createdAt);
  const spendRows = await engine.db
    .select()
    .from(spends)
    .where(eq(spends.jobId, row.id))
    .orderBy(spends.createdAt);
  const helper = row.helperAgentId
    ? (await engine.db.select().from(agents).where(eq(agents.id, row.helperAgentId)))[0]
    : undefined;
  const names = await agentNames(
    engine,
    spendRows.map((sp) => sp.receiver),
    [...spendRows.map((sp) => sp.agentId), ...calls.map((c) => c.agentId)],
  );
  const isClient = viewer !== null && row.clientPlayerId === viewer.id;
  const agentOwnerIsViewer = viewer !== null && summary.awardedTo?.isMine === true;
  const ended = ['paid', 'refunded', 'cancelled', 'expired'].includes(row.status);
  // The deliverable is the client's: its agent's owner and anyone after the job ends can read it, as
  // can everyone for a house client's job.
  const workVisible = isClient || agentOwnerIsViewer || ended || row.clientPlayerId === null;
  // How the agent did it (its code, what it printed) is the agent's method, and the client's files
  // are the client's: only those two see them. Everyone else sees that it ran, with fingerprints.
  const methodVisible = isClient || agentOwnerIsViewer;
  // Real hashes go to those who may re-run the work. A plain SHA-256 of a small or guessable file
  // (or a common script) would let anyone confirm a guess, so everyone else gets a keyed
  // fingerprint: stable on this job, unlinkable across jobs, useless without the server secret.
  const seen = (hash: string) =>
    methodVisible
      ? hash
      : createHmac('sha256', engine.secret).update(`${row.id}\n${hash}`).digest('hex');
  // Names, sizes and fingerprints only: the contents are fetched one at a time by those allowed.
  const fileRows = await engine.db
    .select({
      name: jobFiles.name,
      chars: sql<number>`length(${jobFiles.content})::int`,
      sha256: jobFiles.sha256,
      source: jobFiles.source,
    })
    .from(jobFiles)
    .where(eq(jobFiles.jobId, row.id))
    .orderBy(jobFiles.createdAt);
  const stepRows = await engine.db
    .select()
    .from(jobSteps)
    .where(eq(jobSteps.jobId, row.id))
    .orderBy(jobSteps.n);
  const runRows = await engine.db
    .select()
    .from(sandboxRuns)
    .where(eq(sandboxRuns.jobId, row.id))
    .orderBy(sandboxRuns.round);
  const toolNotes =
    (
      (row.plan ?? {}) as {
        toolNotes?: { id: string; sources: { title: string; url: string }[] }[];
      }
    ).toolNotes ?? [];
  const winner = bidRows.find((b) => b.bid.status === 'won');
  const [tipRow] = await engine.db
    .select({ amount: ledger.amount })
    .from(ledger)
    .where(eq(ledger.ref, `tip:${row.id}`));
  const special = row.specialist ? vendorByHandle(row.specialist) : undefined;
  const plan = (row.plan ?? {}) as { specialist?: 'bought' | 'missing' };
  return {
    ...summary,
    body: row.body,
    criteria: row.criteria,
    files: fileRows.map((f) => ({ ...f, sha256: seen(f.sha256) })),
    tools: toolNotes.map((t) => ({
      id: t.id,
      name: toolById(t.id)?.name ?? t.id,
      sources: t.sources,
    })),
    methodVisible,
    steps: stepRows.map((st) => ({
      n: st.n,
      action: st.action as JobStepView['action'],
      // What's on the fence line is free text: the public sees only a file name, or a payee or
      // specialist and the amount.
      args: methodVisible ? st.args : publicArgs(st.action, st.args),
      thought: methodVisible ? st.thought : null,
      input: methodVisible ? st.input : null,
      observation: methodVisible ? st.observation : null,
      waiting: st.observation === WAITING || st.observation === WAITING_LOCAL,
      ranLocally: st.action === 'shell' && st.observation.startsWith('Exit code '),
      ok: st.ok,
      cost: s(st.cost),
      createdAt: st.createdAt.toISOString(),
    })),
    runs: runRows.map((r) => ({
      round: r.round,
      agentName: names.byId.get(r.agentId) ?? '',
      code: methodVisible ? r.code : null,
      stdout: methodVisible ? r.stdout : null,
      codeHash: seen(sha256Hex(r.code)),
      inputs: Object.fromEntries(Object.entries(r.inputs).map(([k, v]) => [k, seen(v)])),
      failed: r.error !== null,
      error: methodVisible ? r.error : null,
      runMs: r.runMs,
      stdoutHash: seen(r.stdoutHash),
      cost: s(r.cost),
    })),
    autoAward: row.autoAward,
    stage: (row.stage as WorkStage | null) ?? null,
    bids: bidRows.flatMap((b) => {
      const agent = bidAgents.get(b.agent.id);
      return agent
        ? [
            {
              id: b.bid.id,
              agent,
              price: s(b.bid.price),
              pitch: b.bid.pitch,
              status: b.bid.status,
              score: b.bid.score,
              why: bidWhy(row, b, winner, bidAgents),
              createdAt: b.bid.createdAt.toISOString(),
            },
          ]
        : [];
    }),
    deliverable: workVisible ? row.deliverable : null,
    workHash: row.workHash,
    embeddedInstructions: row.embeddedInstructions,
    localOk: row.localOk,
    question: methodVisible && row.question ? { text: row.question, answer: row.answer } : null,
    receipts: calls
      .filter((c) => c.status === 'done' && c.inferenceId)
      .map(
        (c): InferenceReceiptView => ({
          id: c.id,
          inferenceId: c.inferenceId ?? '',
          purpose: c.purpose as InferenceReceiptView['purpose'],
          model: c.model,
          tier: c.tier as InferenceReceiptView['tier'],
          promptTokens: c.promptTokens,
          completionTokens: c.completionTokens,
          cost: s(c.cost ?? 0n),
          verification: verificationOf(c.verification),
          tick: c.tick,
          agentName: names.byId.get(c.agentId) ?? '',
          createdAt: c.createdAt.toISOString(),
          ...(c.purpose === 'tool' ? { tool: toolReceipt(c.key, c.output) } : {}),
        }),
      ),
    spends: spendRows.map((sp) =>
      spendView(engine, sp, names.byId.get(sp.agentId) ?? '', names.byAccount),
    ),
    txs: await engine.chain.txs({
      ...(row.chainJobId ? { jobId: row.chainJobId } : {}),
      gameJobId: row.id,
      limit: 60,
    }),
    helper:
      helper && row.helperPrice !== null
        ? {
            agent: (await summariesOf(engine, [helper], viewer))[0] as AgentSummaryView,
            task: row.helperTask ?? 'Proofread',
            price: s(row.helperPrice),
          }
        : null,
    canAct: isClient,
    reviewEndsAtTick: row.status === 'delivered' ? row.reviewUntilTick : null,
    outsideWinner: row.outsidePrice !== null ? { price: s(row.outsidePrice) } : null,
    settlement: settlementOf(row, methodVisible),
    contract:
      row.contractTier !== null
        ? {
            tier: row.contractTier,
            bond: s(row.bond ?? 0n),
            bondStatus:
              row.bond === null
                ? 'none'
                : row.status === 'paid' || (row.status === 'refunded' && row.scam)
                  ? 'returned'
                  : row.status === 'refunded'
                    ? 'forfeited'
                    : 'held',
          }
        : null,
    specialist: special
      ? {
          handle: special.handle,
          name: special.name,
          price: s(special.price),
          used: plan.specialist ?? null,
        }
      : null,
    tip: tipRow ? s(tipRow.amount) : null,
    sendable: await sendableAgents(
      engine,
      row,
      viewer,
      bidRows.map((b) => b.agent.id),
    ),
  };
}

export function spendView(
  engine: Engine,
  sp: typeof spends.$inferSelect,
  agentName: string,
  names?: Map<string, string>,
): SpendView {
  return {
    id: sp.id,
    agentId: sp.agentId,
    agentName,
    kind: sp.kind as SpendView['kind'],
    receiver: sp.receiver,
    receiverLabel: vendorLabel(engine, sp.receiver, names),
    amount: s(sp.amount),
    status: sp.status as SpendView['status'],
    reason: (sp.reason as SpendReason | null) ?? null,
    memo: sp.memo,
    jobId: sp.jobId,
    txHash: sp.txHash,
    tick: sp.tick,
    createdAt: sp.createdAt.toISOString(),
  };
}

// ── Feed ────────────────────────────────────────────────────────────────────────────────────────

/** Public events, plus owner-scoped ones for the viewer. */
export async function feedView(
  engine: Engine,
  viewer: PlayerRow | null,
  opts: { after?: number; before?: number; agentId?: string; jobId?: string; limit: number },
): Promise<FeedEventView[]> {
  const scope = viewer
    ? or(eq(feed.scope, 'public'), eq(feed.playerId, viewer.id))
    : eq(feed.scope, 'public');
  const conds = [scope];
  if (opts.after) conds.push(gt(feed.seq, opts.after));
  if (opts.before) conds.push(lt(feed.seq, opts.before));
  if (opts.agentId) conds.push(eq(feed.agentId, opts.agentId));
  if (opts.jobId) conds.push(eq(feed.jobId, opts.jobId));
  const rows = await engine.db
    .select()
    .from(feed)
    .where(and(...conds))
    .orderBy(desc(feed.seq))
    .limit(opts.limit);
  const ids = [...new Set(rows.map((r) => r.agentId).filter((x): x is string => !!x))];
  const agentRows = ids.length
    ? await engine.db.select().from(agents).where(inArray(agents.id, ids))
    : [];
  const byId = new Map(agentRows.map((a) => [a.id, a]));
  return rows.map((r) => {
    const a = r.agentId ? byId.get(r.agentId) : undefined;
    return {
      id: r.id,
      seq: r.seq,
      day: r.day,
      tick: r.tick,
      kind: r.kind as FeedEventView['kind'],
      tone: r.tone as FeedEventView['tone'],
      text: r.text,
      agent: a
        ? {
            id: a.id,
            name: a.name,
            look: lookOf(a),
            isMine: viewer !== null && a.ownerId === viewer.id,
          }
        : null,
      jobId: r.jobId,
      amount: r.amount === null ? null : s(r.amount),
      scope: r.scope,
      createdAt: r.createdAt.toISOString(),
    };
  });
}

// ── Approvals ───────────────────────────────────────────────────────────────────────────────────

export async function approvalsView(
  engine: Engine,
  viewer: PlayerRow,
  onlyPending: boolean,
): Promise<ApprovalView[]> {
  const rows = await engine.db
    .select({ spend: spends, agent: agents })
    .from(spends)
    .innerJoin(agents, eq(agents.id, spends.agentId))
    .where(and(eq(agents.ownerId, viewer.id), isNotNull(spends.requestId)))
    .orderBy(desc(spends.createdAt))
    .limit(50);
  const filtered = onlyPending ? rows.filter((r) => r.spend.status === 'pending') : rows;
  const names = await agentNames(
    engine,
    filtered.map((r) => r.spend.receiver),
    [],
  );
  const summaries = new Map(
    (
      await summariesOf(
        engine,
        filtered.map((r) => r.agent),
        viewer,
      )
    ).map((a) => [a.id, a]),
  );
  return filtered.flatMap(({ spend, agent }) => {
    const summary = summaries.get(agent.id);
    if (!summary) return [];
    return [
      {
        id: spend.id,
        agent: summary,
        requestId: spend.requestId ?? 0,
        kind: spend.kind as ApprovalView['kind'],
        receiver: spend.receiver,
        receiverLabel: vendorLabel(engine, spend.receiver, names.byAccount),
        amount: s(spend.amount),
        reason: spend.reason as SpendReason,
        memo: spend.memo,
        jobId: spend.jobId,
        status:
          spend.status === 'pending'
            ? 'pending'
            : spend.status === 'settled'
              ? 'approved'
              : 'denied',
        createdAt: spend.createdAt.toISOString(),
      },
    ];
  });
}

// ── Leaderboard ─────────────────────────────────────────────────────────────────────────────────

/** Ranked on profit from clients unrelated to the owner, net of every cost, so volume alone won't win. */
export async function leaderboardView(
  engine: Engine,
  viewer: PlayerRow | null,
  period: 'today' | 'season',
): Promise<LeaderboardView> {
  const dayCond = period === 'today' ? sql`and ${ledger.day} = ${dayOf(engine)}` : sql``;
  const rows = await engine.db.execute<{
    agent_id: string;
    profit: string;
    ranked: string;
    jobs: number;
  }>(sql`
    select ${ledger.agentId} as agent_id,
      coalesce(sum(${ledger.amount}), 0)::text as profit,
      coalesce(sum(${ledger.amount}) filter (where not ${ledger.related}), 0)::text as ranked,
      (count(*) filter (where ${ledger.kind} in ('job_payout')))::int as jobs
    from ${ledger}
    where ${ledger.agentId} is not null
      and ${ledger.kind} not in ('topup','withdraw','backing','starter','training','allowance','deposit','bond')
      ${dayCond}
    group by ${ledger.agentId}`);
  const all = await engine.db
    .select()
    .from(agents)
    .where(and(isNotNull(agents.accountId), eq(agents.hidden, false)));
  const summaries = new Map((await summariesOf(engine, all, viewer)).map((a) => [a.id, a]));
  const totals = new Map(rows.rows.map((r) => [r.agent_id, r]));
  const entries = all
    .map((a) => {
      const t = totals.get(a.id);
      return {
        a,
        profit: BigInt(t?.profit ?? '0'),
        ranked: BigInt(t?.ranked ?? '0'),
        jobs: t?.jobs ?? 0,
      };
    })
    .sort((x, y) => (x.ranked === y.ranked ? 0 : x.ranked > y.ranked ? -1 : 1));
  return {
    period,
    entries: entries.flatMap((e, i) => {
      const agent = summaries.get(e.a.id);
      return agent
        ? [
            {
              rank: i + 1,
              agent,
              profit: s(e.profit),
              rankedProfit: s(e.ranked),
              jobs: e.jobs,
              avgRating100: avgRating100(e.a),
            },
          ]
        : [];
    }),
  };
}

// ── Reports ─────────────────────────────────────────────────────────────────────────────────────

export async function dayReportView(
  engine: Engine,
  viewer: PlayerRow,
  agent: AgentRow,
  day: number,
): Promise<DayReportView> {
  const [stored] = await engine.db
    .select()
    .from(dayReports)
    .where(and(eq(dayReports.agentId, agent.id), eq(dayReports.day, day)));
  const data = stored
    ? (stored.data as Awaited<ReturnType<typeof computeDayReport>>)
    : await computeDayReport(engine, agent, day, levelOf(engine, agent), false);
  const board = await leaderboardView(engine, viewer, 'today');
  const diary = await engine.db
    .select()
    .from(feed)
    .where(and(eq(feed.agentId, agent.id), eq(feed.kind, 'diary'), eq(feed.day, day)))
    .orderBy(desc(feed.seq))
    .limit(6);
  const [summary] = await summariesOf(engine, [agent], viewer);
  if (!summary) throw new DomainError('not_found', 'Agent not found');
  return {
    day,
    agent: summary,
    ...data,
    rank:
      day === dayOf(engine)
        ? (board.entries.find((e) => e.agent.id === agent.id)?.rank ?? null)
        : null,
    diary: diary.map((d) => d.text.replace(/^[^:]+:\s*/, '')),
  };
}

// ── World and me ────────────────────────────────────────────────────────────────────────────────

async function brainView(engine: Engine, row: AgentRow): Promise<AgentView['brain']> {
  if (engine.nearai.mode !== 'live') return { source: 'recorded', why: 'no_key' };
  if ((await brainSourceFor(engine, row)) === 'recorded')
    return { source: 'recorded', why: 'house' };
  if ((await liveAiBudget(engine)).reached) return { source: 'recorded', why: 'budget_reached' };
  return { source: 'live', why: 'live' };
}

export async function worldView(engine: Engine): Promise<WorldView> {
  const prices = await loadPrices(engine);
  const event = eventForDay(dayOf(engine));
  const [counts] = await engine.db
    .select({
      active: sql<number>`count(*) filter (where ${agents.dormantSinceDay} is null)::int`,
      dormant: sql<number>`count(*) filter (where ${agents.dormantSinceDay} is not null)::int`,
    })
    .from(agents)
    .where(and(isNotNull(agents.accountId), eq(agents.hidden, false)));
  const [open] = await engine.db
    .select({ n: sql<number>`count(*)::int` })
    .from(jobs)
    .where(and(eq(jobs.status, 'open'), sql`${jobs.source} <> 'practice'`));
  const [paid] = await engine.db
    .select({ total: sql<string>`coalesce(sum(${ledger.amount}), 0)::text` })
    .from(ledger)
    .where(and(eq(ledger.day, dayOf(engine)), eq(ledger.kind, 'job_payout')));
  const day = dayOf(engine);
  const budget = engine.nearai.mode === 'live' ? await liveAiBudget(engine) : null;
  return {
    day,
    liveAi: budget
      ? {
          budget: (budget.budgetNano / 1000n).toString(),
          spent: ((budget.spentNano + 999n) / 1000n).toString(),
          calls: budget.calls,
          reached: budget.reached,
        }
      : null,
    tick: engine.clock.tick,
    dayTicks: engine.dayTicks,
    tickMs: engine.tickMs,
    dayRealMs: engine.dayTicks * Math.max(engine.tickMs, engine.tickPaceMs),
    hour: hourOf(engine),
    event: event
      ? {
          id: event.id,
          name: event.name,
          description: event.description,
          startsDay: day,
          endsDay: day,
        }
      : null,
    demand: Object.fromEntries(
      CATEGORIES.map((c) => [c, event?.demand[c] ?? 100]),
    ) as WorldView['demand'],
    modes: engine.modes,
    prices: Object.fromEntries(
      CATEGORIES.map((c) => [c, Math.round(prices[c] ?? 100)]),
    ) as WorldView['prices'],
    economy: {
      starterAgentCredits: s(engine.cfg.starterAgentCredits),
      starterWalletCredits: s(engine.cfg.starterWalletCredits),
      upkeepPerDay: s(engine.cfg.upkeepPerDay),
      dailyAllowance: s(engine.cfg.dailyAllowance),
    },
    stats: {
      activeAgents: counts?.active ?? 0,
      dormantAgents: counts?.dormant ?? 0,
      openJobs: open?.n ?? 0,
      paidToday: paid?.total ?? '0',
    },
  };
}

export async function meView(engine: Engine, player: PlayerRow): Promise<MeView> {
  const mine = await engine.db
    .select()
    .from(agents)
    .where(and(eq(agents.ownerId, player.id), isNotNull(agents.accountId)))
    .orderBy(agents.createdAt);
  const pending = await approvalsView(engine, player, true);
  return {
    player: {
      id: player.id,
      name: player.name,
      email: player.email,
      loginMethod:
        player.loginMethod === 'passkey' || player.loginMethod === 'wallet'
          ? player.loginMethod
          : 'email',
      accountId: player.accountId,
      walletAccountId: player.walletAccountId,
      // Before their first on-chain action a player has no account yet: show the starter credits
      // it will open with.
      wallet: s(
        player.accountReady
          ? await engine.chain.ftBalance(player.accountId)
          : engine.cfg.starterWalletCredits,
      ),
      faucetReadyAtDay: player.allowanceDay === dayOf(engine) ? dayOf(engine) + 1 : null,
      createdAt: player.createdAt.toISOString(),
    },
    agents: await Promise.all(mine.map((a) => agentView(engine, a, player))),
    pendingApprovals: pending.length,
  };
}

export { profitToday };

// ── Wallet history ──────────────────────────────────────────────────────────────────────────────

/** Plain words for a credit movement, from the transfer memo the chain recorded. */
function walletLabel(memo: string, incoming: boolean, other: string): string {
  if (memo === 'top up') return `Topped up ${other}`;
  if (memo === 'escrow') return 'Posted a job (held until you rate it)';
  if (memo === 'award refund') return 'Change back: the agent asked less than your budget';
  if (memo.startsWith('cancel job') || memo.startsWith('refund job') || memo === 'refund') {
    return 'Refund of a job budget';
  }
  if (memo === 'withdraw') return `Moved from ${other} to your wallet`;
  if (memo.startsWith('backing from')) return incoming ? `Backing for ${other}` : `Backed ${other}`;
  if (memo.startsWith('training'))
    return `Paid for a ${memo.replace('training ', '').replace('_', ' ')} course`;
  // Paying the market is a purchase; money from it is a sale (less its fee) or a refunded buy.
  if (memo === 'buy' || other === 'market')
    return incoming ? 'From the marketplace: a sale, or a refunded buy' : 'Bought an agent';
  return incoming ? `From ${other}` : `To ${other}`;
}

/** Every credit movement on the player's account, read from the chain's transfer and mint events. */
export async function walletHistory(engine: Engine, player: PlayerRow): Promise<WalletEntryView[]> {
  const txs = await engine.chain.txs({ account: player.accountId, limit: 120 });
  const counterparts = new Set<string>();
  for (const tx of txs) {
    for (const e of tx.events) {
      const d = e.data as { old_owner_id?: string; new_owner_id?: string };
      if (d.old_owner_id) counterparts.add(d.old_owner_id);
      if (d.new_owner_id) counterparts.add(d.new_owner_id);
    }
  }
  const names = await agentNames(engine, [...counterparts], []);
  const entries: WalletEntryView[] = [];
  for (const tx of txs) {
    for (const e of tx.events) {
      const d = e.data as {
        old_owner_id?: string;
        new_owner_id?: string;
        owner_id?: string;
        amount?: string;
        memo?: string | null;
      };
      if (!d.amount) continue;
      if (e.event === 'ft_mint' && d.owner_id === player.accountId) {
        entries.push({
          at: tx.createdAt,
          tick: tx.tick ?? null,
          amount: d.amount,
          label: 'Credits added',
          txHash: tx.hash,
        });
      } else if (
        e.event === 'ft_transfer' &&
        (d.old_owner_id === player.accountId || d.new_owner_id === player.accountId)
      ) {
        const incoming = d.new_owner_id === player.accountId;
        const other = (incoming ? d.old_owner_id : d.new_owner_id) ?? '';
        const otherName =
          names.byAccount.get(other) ??
          (other === engine.chain.ids.jobs
            ? 'the job board'
            : other === engine.chain.ids.treasury
              ? 'Hustle'
              : (other.split('.')[0] ?? other));
        entries.push({
          at: tx.createdAt,
          tick: tx.tick ?? null,
          amount: incoming ? d.amount : `-${d.amount}`,
          label: walletLabel(d.memo ?? '', incoming, otherName),
          txHash: tx.hash,
        });
      }
    }
  }
  return entries;
}

/** The viewer's agents and whether each can be sent after this job now (and if not, why not). */
async function sendableAgents(
  engine: Engine,
  job: JobRow,
  viewer: PlayerRow | null,
  alreadyBid: string[],
): Promise<JobView['sendable']> {
  if (
    !viewer ||
    job.status !== 'open' ||
    job.source === 'practice' ||
    job.clientPlayerId === viewer.id ||
    job.reservedForAgentId !== null
  )
    return [];
  const mine = await engine.db
    .select()
    .from(agents)
    .where(and(eq(agents.ownerId, viewer.id), isNotNull(agents.accountId)));
  return mine.map((a) => {
    const snapshot = snapshotOf(a);
    const floor = expectedJobCost(
      snapshot,
      jobSnapshot(job, null),
      engine.brains[tierOf(a)],
      toolsFor(engine, a),
    );
    const needs = overJobCap(
      snapshot,
      jobSnapshot(job, null),
      engine.brains[tierOf(a)],
      toolsFor(engine, a),
    );
    const reason = alreadyBid.includes(a.id)
      ? 'Already bid'
      : a.dormantSinceDay !== null
        ? 'Asleep'
        : a.busyJobId
          ? 'Busy on another job'
          : levelOf(engine, a) + (traitsOf(a).includes('bold') ? 1 : 0) < job.minLevel
            ? `Needs level ${job.minLevel}`
            : job.reservedForAgentId && job.reservedForAgentId !== a.id
              ? 'Reserved for another agent'
              : needs !== null
                ? `Its rulebook allows ${formatUsd(snapshot.rulebook.maxPerJob)} a job; this one needs about ${formatUsd(needs)}. Raise "Most per job" to send it.`
                : null;
    return { agentId: a.id, name: a.name, floor: s(floor), max: s(job.budget), reason };
  });
}
