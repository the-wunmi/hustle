import {
  Category,
  DomainError,
  formatUsd,
  MAX_JOB_BODY,
  MAX_JOB_TITLE,
  MicroAmount,
  parseInput,
  usd,
} from '@hustle/core';
import { agents, bids, jobs } from '@hustle/db';
import { expectedJobCost, MAX_OPEN_BIDS, VENDORS } from '@hustle/economy';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { chainDomainError } from './agents/manage.ts';
import { levelOf, snapshotOf, tierOf, traitsOf } from './agents/state.ts';
import { think } from './brain/think.ts';
import type { Engine } from './context.ts';
import type { PlayerRow } from './players.ts';
import { ensurePlayerAccount } from './players.ts';
import { post } from './record.ts';
import { brainContext } from './world/context.ts';
import { type JobRow, jobSnapshot, openJob } from './world/jobs.ts';
import { awardJob } from './world/market.ts';
import { finishReview } from './world/work.ts';

/** Player tasks: from the job board's minimum up to a cap that keeps sandbox jobs small. */
export const MIN_PLAYER_BUDGET = usd('0.10');
export const MAX_PLAYER_BUDGET = usd('5');
/** Open jobs one player may have at once, so nobody floods the board. */
export const MAX_OPEN_PLAYER_JOBS = 5;

export const PostTask = z.object({
  title: z.string().trim().min(4).max(MAX_JOB_TITLE),
  body: z.string().trim().min(10).max(MAX_JOB_BODY),
  category: Category,
  budget: MicroAmount.refine(
    (b) => b >= MIN_PLAYER_BUDGET && b <= MAX_PLAYER_BUDGET,
    'Budget must be between $0.10 and $5.00',
  ),
  autoAward: z.boolean().default(true),
});
export const RateJob = z.object({ rating: z.int().min(1).max(5) });
export const AwardBid = z.object({ bidId: z.uuid() });

export async function postTask(
  engine: Engine,
  player: PlayerRow,
  input: z.input<typeof PostTask>,
): Promise<JobRow> {
  const data = parseInput(PostTask, input);
  const mine = await engine.db
    .select({ id: jobs.id, status: jobs.status })
    .from(jobs)
    .where(eq(jobs.clientPlayerId, player.id));
  if (
    mine.filter((j) => ['open', 'working', 'delivered'].includes(j.status)).length >=
    MAX_OPEN_PLAYER_JOBS
  ) {
    throw new DomainError('conflict', `You can have up to ${MAX_OPEN_PLAYER_JOBS} jobs running`);
  }
  player = await ensurePlayerAccount(engine, player);
  const wallet = await engine.chain.ftBalance(player.accountId);
  if (wallet < data.budget)
    throw new DomainError('insufficient_funds', `Your wallet has ${formatUsd(wallet)}`);
  const job = await openJob(
    engine,
    { accountId: player.accountId, playerId: player.id, autoAward: data.autoAward },
    {
      source: 'player',
      category: data.category,
      title: data.title,
      body: data.body,
      budget: data.budget,
      minLevel: 1,
      clientName: player.name,
      scam: false,
      scamVendor: null,
      scamAmount: null,
      sponsorPoolId: null,
      answerKeywords: null,
      clientStyle: 'balanced',
    },
  );
  if (!job) throw new DomainError('unavailable', 'Could not post the job');
  return job;
}

export async function ownJob(engine: Engine, player: PlayerRow, jobId: string): Promise<JobRow> {
  const parsed = z.uuid().safeParse(jobId);
  if (!parsed.success) throw new DomainError('not_found', 'Job not found');
  const [job] = await engine.db
    .select()
    .from(jobs)
    .where(and(eq(jobs.id, parsed.data), eq(jobs.clientPlayerId, player.id)));
  if (!job) throw new DomainError('not_found', 'Job not found');
  return job;
}

/** The client picks a bid themselves (jobs posted without auto-award). `job` is already the caller's. */
export async function chooseBid(
  engine: Engine,
  job: JobRow,
  input: z.input<typeof AwardBid>,
): Promise<void> {
  const { bidId } = parseInput(AwardBid, input);
  if (job.status !== 'open') throw new DomainError('conflict', 'This job is no longer open');
  const [bid] = await engine.db
    .select()
    .from(bids)
    .where(and(eq(bids.id, bidId), eq(bids.jobId, job.id), eq(bids.status, 'open')));
  if (!bid) {
    const [gone] = await engine.db
      .select()
      .from(bids)
      .where(and(eq(bids.id, bidId), eq(bids.jobId, job.id)));
    throw gone?.status === 'withdrawn'
      ? new DomainError(
          'conflict',
          'That agent won another job first and withdrew its bid. Pick another.',
        )
      : new DomainError('not_found', 'Bid not found');
  }
  const [agent] = await engine.db.select().from(agents).where(eq(agents.id, bid.agentId));
  if (agent?.busyJobId)
    throw new DomainError('conflict', `${agent.name} just took another job. Pick someone else.`);
  await awardJob(engine, job, bid.id);
  const [after] = await engine.db.select().from(jobs).where(eq(jobs.id, job.id));
  if (after?.status !== 'working') throw new DomainError('conflict', 'Could not award this bid');
}

/** The client rates a delivery: 2★ and up releases escrow; 1★ disputes it and the judge decides. */
export async function rateJob(
  engine: Engine,
  player: PlayerRow,
  job: JobRow,
  input: z.input<typeof RateJob>,
): Promise<void> {
  const { rating } = parseInput(RateJob, input);
  if (job.status !== 'delivered' || !job.chainJobId)
    throw new DomainError('conflict', 'Nothing to rate yet');
  const [agent] = await engine.db
    .select()
    .from(agents)
    .where(eq(agents.id, job.awardedAgentId ?? ''));
  if (!agent) throw new DomainError('not_found', 'Agent not found');
  try {
    const verdict =
      rating >= 2 ? { kind: 'accept' as const, rating } : { kind: 'dispute' as const };
    const result = await finishReview(engine, job, agent, player.accountId, verdict);
    if (verdict.kind === 'dispute') {
      await post(engine, {
        kind: 'refunded',
        tone: 'neutral',
        text:
          result === 'refunded'
            ? `The arbiter agreed with you on "${job.title}": your budget is refunded.`
            : `The arbiter judged "${job.title}" good enough and paid ${agent.name}.`,
        jobId: job.id,
        playerId: player.id,
        scope: 'owner',
      });
    }
  } catch (err) {
    throw chainDomainError(err);
  }
}

export async function cancelJob(engine: Engine, player: PlayerRow, job: JobRow): Promise<void> {
  if (job.status !== 'open' || !job.chainJobId)
    throw new DomainError('conflict', 'Only open jobs can be cancelled');
  try {
    await engine.chain.cancel(player.accountId, job.chainJobId);
  } catch (err) {
    throw chainDomainError(err);
  }
  await engine.db
    .update(jobs)
    .set({ status: 'cancelled', settledAt: new Date() })
    .where(eq(jobs.id, job.id));
  await engine.db
    .update(bids)
    .set({ status: 'lost' })
    .where(and(eq(bids.jobId, job.id), eq(bids.status, 'open')));
}

export const SendAgent = z.object({
  agentId: z.uuid(),
  /** What the player bids, in micro-USD: between what the work will cost to think through and the budget. */
  price: MicroAmount,
});

/**
 * The player sends their agent after one job at a price they choose: the agent still writes its own
 * pitch (a paid call), and every rule a self-chosen bid follows still applies (level, self-dealing,
 * one job at a time, at most two open bids). Prices below the agent's own cost are refused.
 */
export async function sendAgentAfterJob(
  engine: Engine,
  player: PlayerRow,
  job: JobRow,
  input: z.input<typeof SendAgent>,
  /** Whether the owner chose the price (the feed says so), or the agent priced it by its rules. */
  opts: { ownerPriced: boolean } = { ownerPriced: true },
): Promise<void> {
  const parsed = parseInput(SendAgent, input);
  // Prices are whole cents, so what the player picked and what the feed shows always match.
  const price = ((parsed.price + 5_000n) / 10_000n) * 10_000n;
  const { agentId } = parsed;
  const [agent] = await engine.db
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.ownerId, player.id)));
  if (!agent?.accountId) throw new DomainError('not_found', 'Agent not found');
  if (
    job.status !== 'open' ||
    job.source === 'practice' ||
    (job.closesTick ?? 0) <= engine.clock.tick
  ) {
    throw new DomainError('conflict', 'Bidding on this job has closed');
  }
  if (job.reservedForAgentId && job.reservedForAgentId !== agent.id) {
    throw new DomainError('conflict', 'This job is reserved for another agent');
  }
  if (job.clientPlayerId === player.id)
    throw new DomainError('invalid', 'Your agent can’t bid on your own task');
  if (agent.dormantSinceDay !== null)
    throw new DomainError('conflict', `${agent.name} is asleep. Top it up first.`);
  if (agent.busyJobId) throw new DomainError('conflict', `${agent.name} is busy on another job`);
  if (levelOf(engine, agent) + (traitsOf(agent).includes('bold') ? 1 : 0) < job.minLevel) {
    throw new DomainError('conflict', `This job needs level ${job.minLevel}`);
  }
  const [already] = await engine.db
    .select()
    .from(bids)
    .where(and(eq(bids.jobId, job.id), eq(bids.agentId, agent.id)));
  if (already) throw new DomainError('conflict', `${agent.name} already bid on this job`);
  const open = await engine.db
    .select({ id: bids.id })
    .from(bids)
    .innerJoin(jobs, eq(jobs.id, bids.jobId))
    .where(and(eq(bids.agentId, agent.id), eq(bids.status, 'open'), eq(jobs.status, 'open')));
  if (open.length >= MAX_OPEN_BIDS)
    throw new DomainError('conflict', `${agent.name} already has ${MAX_OPEN_BIDS} bids waiting`);
  const floor = expectedJobCost(
    snapshotOf(agent),
    jobSnapshot(job, null),
    engine.brains[tierOf(agent)],
    VENDORS,
  );
  if (price > job.budget)
    throw new DomainError('invalid', `The budget is ${formatUsd(job.budget)}`);
  if (price < floor) {
    throw new DomainError(
      'invalid',
      `At ${formatUsd(price)} ${agent.name} would lose money: thinking it through costs about ${formatUsd(floor)}`,
    );
  }
  const ctx = await brainContext(engine, agent, job, 'bid');
  const result = await think(engine, agent, `bid:${job.id}:${agent.id}`, job.id, ctx, job.body);
  if (!result.ok)
    throw new DomainError(
      'insufficient_funds',
      `${agent.name} can’t afford to write a pitch right now`,
    );
  await engine.db
    .insert(bids)
    .values({
      jobId: job.id,
      agentId: agent.id,
      price,
      pitch: result.output.pitch,
      status: 'open',
      createdTick: engine.clock.tick,
    })
    .onConflictDoNothing();
  await post(engine, {
    kind: 'bid',
    tone: 'neutral',
    text: `${agent.name} bid ${formatUsd(price)} on "${job.title}"${opts.ownerPriced ? ' (its owner set the price)' : ''}.`,
    agentId: agent.id,
    jobId: job.id,
    amount: price,
  });
}
