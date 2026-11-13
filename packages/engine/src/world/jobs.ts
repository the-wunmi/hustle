import { randomUUID } from 'node:crypto';
import { type Category, DomainError, type JobSource, sha256Hex } from '@hustle/core';
import { jobs, type Tx } from '@hustle/db';
import type { ClientStyle, JobDraft, JobSnapshot } from '@hustle/economy';
import { eq } from 'drizzle-orm';
import { dayOf, type Engine } from '../context.ts';
import { chainCall, crashPoint, DBOS, durableEngine, inTx, runOnce, wfId } from '../durable.ts';
import { saveJobFile } from '../files.ts';
import { post } from '../record.ts';

export type JobRow = typeof jobs.$inferSelect;

/** House accounts that post the world's jobs: the game's clients and its sponsor pools. */
export const houseAccount = (engine: Engine, who: 'clients' | 'sponsors'): string =>
  `${who}.${engine.chain.ids.root}`;

export function jobSnapshot(row: JobRow, clientOwnerId: string | null): JobSnapshot {
  return {
    id: row.id,
    category: row.category as Category,
    source: row.source as JobSource,
    budget: row.budget,
    minLevel: row.minLevel,
    clientOwnerId,
    body: row.body,
    scam: row.scam,
    clientStyle: row.clientStyle as ClientStyle,
    rookie: row.rookie,
  };
}

/** Longer windows for jobs a person posted: they need time to come back and choose or rate. */
export const PLAYER_BID_TICKS = 12;
export const PLAYER_REVIEW_FACTOR = 12;

export interface Poster {
  accountId: string;
  playerId: string | null;
  autoAward: boolean;
}

/** What the escrow workflow needs to open a paid job, all decided before it starts. */
interface EscrowInput {
  jobId: string;
  poster: Poster;
  draft: JobDraft;
  opts: { reservedForAgentId?: string; marketRef?: string };
  tick: number;
  day: number;
  bidTicks: number;
  reviewTicks: number;
}

type EscrowResult =
  | { kind: 'open'; job: JobRow }
  | { kind: 'refused'; reason: 'insufficient_funds' | 'below_minimum' };

/**
 * Opens a job: a row, and for paid jobs the budget escrowed on the job board by the client's account
 * (`ft_transfer_call`). Practice jobs have no budget and never touch escrow. A paid job opens through
 * a workflow keyed by the job's id, so a crash anywhere in between resumes it.
 */
/** A `next_at` the work stages never reach (the largest the column holds): for jobs worked elsewhere. */
export const NEVER_TICK = 2_147_483_647;

export async function openJob(
  engine: Engine,
  poster: Poster,
  draft: JobDraft,
  opts: { reservedForAgentId?: string; marketRef?: string } = {},
): Promise<JobRow | null> {
  const tick = engine.clock.tick;
  const bidTicks = poster.playerId ? PLAYER_BID_TICKS : engine.cfg.biddingTicks;
  if (draft.source === 'practice') {
    return insertJob(engine.db, randomUUID(), draft, poster, opts, {
      tick,
      day: dayOf(engine),
      bidTicks,
      status: 'open',
    });
  }
  const jobId = randomUUID();
  const reviewTicks = engine.cfg.reviewTicks * (poster.playerId ? PLAYER_REVIEW_FACTOR : 1);
  // File contents stay out of the workflow's stored input; they're saved once the job is open.
  const { files: _files, ...escrowed } = draft;
  const input: EscrowInput = {
    jobId,
    poster,
    draft: escrowed,
    opts,
    tick,
    day: dayOf(engine),
    bidTicks,
    reviewTicks,
  };
  const res = await runOnce(escrowWorkflow, wfId(engine, 'escrow', jobId), input);
  if (res.kind === 'open') return withWorkFiles(engine, res.job, draft);
  if (!poster.playerId) return null;
  if (res.reason === 'insufficient_funds')
    throw new DomainError('insufficient_funds', 'Could not escrow the budget');
  throw new DomainError('invalid', 'The job board refused the budget (minimum $0.10)');
}

/** Keeps an expert job's files (attached by the client) and its acceptance criteria. */
async function withWorkFiles(engine: Engine, job: JobRow, draft: JobDraft): Promise<JobRow> {
  for (const f of draft.files ?? []) await saveJobFile(engine, job.id, f.name, f.content, 'client');
  if (!draft.criteria) return job;
  const [row] = await engine.db
    .update(jobs)
    .set({ criteria: draft.criteria })
    .where(eq(jobs.id, job.id))
    .returning();
  return row ?? job;
}

async function insertJob(
  db: Tx,
  id: string,
  draft: JobDraft,
  poster: Poster,
  opts: { reservedForAgentId?: string; marketRef?: string },
  at: { tick: number; day: number; bidTicks: number; status: 'open' | 'posting' },
): Promise<JobRow> {
  await db
    .insert(jobs)
    .values({
      id,
      source: draft.source,
      category: draft.category,
      title: draft.title,
      body: draft.body,
      budget: draft.budget,
      minLevel: draft.minLevel,
      clientPlayerId: poster.playerId,
      clientName: draft.clientName,
      clientStyle: draft.clientStyle,
      sponsorPoolId: draft.sponsorPoolId,
      scam: draft.scam,
      scamVendor: draft.scamVendor,
      scamAmount: draft.scamAmount,
      answerKeywords: draft.answerKeywords ? [...draft.answerKeywords] : null,
      subcontracting: draft.subcontracting ?? true,
      localOk: draft.localOk ?? false,
      reservedForAgentId: opts.reservedForAgentId ?? null,
      autoAward: poster.autoAward,
      status: at.status,
      openedTick: at.tick,
      closesTick: at.tick + at.bidTicks,
      marketRef: opts.marketRef ?? null,
      specialist: draft.specialist ?? null,
      rookie: draft.rookie ?? false,
      contractTier: draft.contractTier ?? null,
      createdDay: at.day,
    })
    .onConflictDoNothing();
  const [row] = await db.select().from(jobs).where(eq(jobs.id, id));
  if (!row) throw new Error('job not written');
  return row;
}

/**
 * The escrow workflow: write the job as `posting`, escrow its budget on the job board (keyed by the
 * job id, so a retry finds the first post), then open it or cancel it. No answer from the chain
 * keeps it in doubt until the chain answers; it is never cancelled for that.
 */
async function escrowJob(input: EscrowInput): Promise<EscrowResult> {
  const engine = durableEngine();
  const { jobId, poster, draft } = input;
  await inTx('write job', (db) =>
    insertJob(db, jobId, draft, poster, input.opts, {
      tick: input.tick,
      day: input.day,
      bidTicks: input.bidTicks,
      status: 'posting',
    }),
  );
  const posted = await chainCall('post_job', () =>
    engine.chain.postJob(poster.accountId, draft.budget, {
      jobKey: jobId,
      specHash: sha256Hex(`${draft.title}\n${draft.body}`),
      autoAward: poster.autoAward,
      reviewWindowMs: input.reviewTicks * engine.tickMs,
    }),
  );
  crashPoint('escrow:posted');
  const chainJobId = posted.ok ? posted.value.value : null;
  if (!chainJobId) {
    await inTx('cancel job', (db) =>
      db.update(jobs).set({ status: 'cancelled' }).where(eq(jobs.id, jobId)),
    );
    return {
      kind: 'refused',
      reason: posted.ok ? 'below_minimum' : 'insufficient_funds',
    };
  }
  const job = await inTx('open job', async (db) => {
    const [row] = await db
      .update(jobs)
      .set({ chainJobId, status: 'open' })
      .where(eq(jobs.id, jobId))
      .returning();
    if (draft.source !== 'client' || poster.playerId) {
      await post(
        engine,
        {
          kind: 'job_posted',
          tone: 'neutral',
          text: `${draft.clientName} posted "${draft.title}".`,
          jobId,
          amount: draft.budget,
        },
        db,
      );
    }
    return row;
  });
  if (!job) throw new Error('job vanished');
  return { kind: 'open', job };
}

export const escrowWorkflow = DBOS.registerWorkflow(escrowJob, { name: 'escrowJob' });

export type ChainJobState =
  | {
      kind: 'live';
      status: 'open' | 'awarded' | 'delivered' | 'disputed' | string;
      agentId: string | null;
    }
  | {
      kind: 'settled';
      settlement: 'paid' | 'refunded' | 'cancelled' | 'reclaimed' | null;
      rating: number | null;
    };

/**
 * What the chain says about a job: still on the board with a status, or gone with how it settled.
 * Every job step reads this first, so a step whose chain call landed before the process stopped is
 * finished from the chain's record instead of being sent again.
 */
export async function chainJobState(engine: Engine, chainJobId: string): Promise<ChainJobState> {
  const live = await engine.chain.getJob(chainJobId);
  if (live) return { kind: 'live', status: live.status, agentId: live.agentId };
  const txs = await engine.chain.txs({ jobId: chainJobId, limit: 60 });
  for (const tx of txs) {
    for (const e of tx.events) {
      const d = e.data as { job_id?: string | number; settlement?: string; rating?: number | null };
      if (String(d.job_id ?? '') !== chainJobId) continue;
      if ((e.event === 'job_settled' || e.event === 'job_settling') && d.settlement) {
        const settlement = d.settlement as 'paid' | 'refunded' | 'cancelled' | 'reclaimed';
        return { kind: 'settled', settlement, rating: d.rating ?? null };
      }
      if (e.event === 'job_paid')
        return { kind: 'settled', settlement: 'paid', rating: d.rating ?? null };
      if (e.event === 'job_refunded')
        return { kind: 'settled', settlement: 'refunded', rating: null };
      if (e.event === 'job_cancelled')
        return { kind: 'settled', settlement: 'cancelled', rating: null };
    }
  }
  return { kind: 'settled', settlement: null, rating: null };
}
