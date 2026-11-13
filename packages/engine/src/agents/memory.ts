import { createHmac } from 'node:crypto';
import { DomainError, formatUsd, MAX_PLAYBOOK, parseInput } from '@hustle/core';
import { agentMemories, agents, jobs } from '@hustle/db';
import { and, asc, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { think } from '../brain/think.ts';
import type { Engine } from '../context.ts';
import type { PlayerRow } from '../players.ts';
import { post } from '../record.ts';
import { isRunning, startBackground } from '../world/background.ts';
import { brainContext } from '../world/context.ts';
import type { JobRow } from '../world/jobs.ts';
import { type AgentRow, RECALL } from './state.ts';

/** Memories an agent keeps; the oldest go first. */
export const KEEP = 40;
/** Reflections running at once, in the background. */
const REFLECT_PER_TICK = 4;

/**
 * The playbook's public face: a fingerprint, never the text. Keyed with the server secret and the
 * agent, so a short playbook can't be confirmed by hashing guesses.
 */
export const playbookFingerprint = (
  engine: Pick<Engine, 'secret'>,
  agentId: string,
  text: string,
): string | null =>
  text
    ? createHmac('sha256', engine.secret).update(`${agentId}\n${text}`).digest('hex').slice(0, 12)
    : null;

type MemoryRow = typeof agentMemories.$inferSelect;

/** One recalled memory as the agent reads it. */
const asNote = (m: MemoryRow): string => {
  const how =
    m.outcome === 'refunded'
      ? 'refunded'
      : m.rating === null
        ? `paid ${formatUsd(m.price)}`
        : `${m.rating}★ at ${formatUsd(m.price)}`;
  return `${m.client}, ${m.category.replace('_', ' ')}, ${how}${m.lesson ? `: ${m.lesson}` : ''}`;
};

/** The memories most useful for this job: the same client first, then the same kind of work. */
export async function recall(engine: Engine, agent: AgentRow, job: JobRow): Promise<string[]> {
  if (agent.memoryCount === 0) return [];
  const rows = await engine.db
    .select()
    .from(agentMemories)
    .where(eq(agentMemories.agentId, agent.id))
    .orderBy(
      desc(sql`${agentMemories.client} = ${job.clientName}`),
      desc(sql`${agentMemories.category} = ${job.category}`),
      desc(agentMemories.tick),
    )
    .limit(RECALL);
  return rows.map(asNote);
}

export const PlaybookInput = z.object({
  text: z.string().trim().max(MAX_PLAYBOOK, `A playbook is at most ${MAX_PLAYBOOK} characters`),
});

/** The owner rewrites the playbook. Text only: it never touches the wallet or the rulebook. */
export async function setPlaybook(
  engine: Engine,
  player: PlayerRow,
  agent: AgentRow,
  input: z.input<typeof PlaybookInput>,
): Promise<AgentRow> {
  if (agent.ownerId !== player.id) throw new DomainError('not_found', 'Agent not found');
  const playbook = parseInput(PlaybookInput, input).text;
  if (playbook === agent.playbook) return agent;
  const [row] = await engine.db
    .update(agents)
    .set({ playbook, playbookUpdatedAt: new Date() })
    .where(eq(agents.id, agent.id))
    .returning();
  await post(engine, {
    kind: 'work',
    tone: 'neutral',
    text: playbook
      ? `${agent.name}'s owner rewrote its playbook (${playbookFingerprint(engine, agent.id, playbook)}).`
      : `${agent.name}'s owner cleared its playbook.`,
    agentId: agent.id,
  });
  return row ?? agent;
}

/**
 * Keeps a finished client job's facts for a player's agent, at settlement (a cheap insert, so a busy
 * world never loses one). Its lesson comes later from the reflection queue. House agents keep none.
 */
export async function rememberJob(
  engine: Engine,
  agent: AgentRow,
  job: JobRow,
  outcome: 'paid' | 'refunded',
): Promise<void> {
  if (job.source === 'practice' || engine.houseOwners.has(agent.ownerId)) return;
  await remember(engine, agent, job, outcome);
}

/**
 * Works through the reflection queue: each queued memory is claimed once (so a reflection is never
 * retried or re-billed) and its paid reflect call runs in the background, off the serial lane. A
 * memory still queued after a game day keeps its facts without a lesson.
 */
export async function reflectOnJobs(engine: Engine): Promise<void> {
  const stale = engine.clock.tick - engine.dayTicks;
  await engine.db
    .update(agentMemories)
    .set({ reflectedAt: new Date() })
    .where(and(isNull(agentMemories.reflectedAt), lt(agentMemories.tick, stale)));
  const queued = await engine.db
    .select({ memory: agentMemories, agent: agents, job: jobs })
    .from(agentMemories)
    .innerJoin(agents, eq(agents.id, agentMemories.agentId))
    .innerJoin(jobs, eq(jobs.id, agentMemories.jobId))
    .where(isNull(agentMemories.reflectedAt))
    .orderBy(asc(agentMemories.tick))
    .limit(REFLECT_PER_TICK);
  for (const { memory, agent, job } of queued) {
    const key = `reflect:${memory.id}`;
    if (isRunning(key)) continue;
    const started = startBackground(engine, 'reflect', REFLECT_PER_TICK, key, async () => {
      const [claimed] = await engine.db
        .update(agentMemories)
        .set({ reflectedAt: new Date() })
        .where(and(eq(agentMemories.id, memory.id), isNull(agentMemories.reflectedAt)))
        .returning({ id: agentMemories.id });
      if (claimed) await reflect(engine, agent, job, memory);
    });
    if (!started) break;
  }
}

async function reflect(
  engine: Engine,
  agent: AgentRow,
  job: JobRow,
  memory: typeof agentMemories.$inferSelect,
): Promise<void> {
  const ctx = await brainContext(engine, agent, job, 'reflect', {
    outcome: {
      result: memory.outcome,
      rating: memory.rating,
      price: formatUsd(memory.price),
      deliverable: (job.deliverable ?? '').slice(0, 600),
    },
  });
  // Not charged to the job: it is closed, and its per-job cap shouldn't stop the agent learning.
  // The client's brief isn't re-read: a lesson is drawn from the outcome, so a post can't plant
  // instructions that the agent then carries into other clients' jobs.
  const result = await think(engine, agent, `reflect:${job.id}`, null, ctx, '');
  const lesson = result.ok ? safeLesson(result.output.lesson) : null;
  if (lesson)
    await engine.db.update(agentMemories).set({ lesson }).where(eq(agentMemories.id, memory.id));
}

/**
 * A lesson that names an account, an address or a link is dropped: lessons are recalled into later
 * jobs, so they must not carry payees or places to send anything.
 */
export function safeLesson(lesson: string): string | null {
  const text = lesson.trim();
  if (!text) return null;
  if (/https?:\/\/|www\.|\b[\w-]+\.(near|testnet)\b|\b0x[0-9a-f]{8,}/i.test(text)) return null;
  return text;
}

/** Keeps the job's facts (queued for reflection) and forgets the oldest beyond KEEP. */
async function remember(
  engine: Engine,
  agent: AgentRow,
  job: JobRow,
  outcome: 'paid' | 'refunded',
): Promise<string | null> {
  return engine.db.transaction(async (tx) => {
    const [kept] = await tx
      .insert(agentMemories)
      .values({
        agentId: agent.id,
        jobId: job.id,
        category: job.category,
        client: job.clientName,
        outcome,
        rating: job.rating,
        price: job.price ?? 0n,
        lesson: null,
        tick: engine.clock.tick,
      })
      .onConflictDoNothing()
      .returning({ id: agentMemories.id });
    if (!kept) return null;
    const stale = await tx
      .select({ id: agentMemories.id })
      .from(agentMemories)
      .where(eq(agentMemories.agentId, agent.id))
      .orderBy(desc(agentMemories.tick), desc(agentMemories.createdAt))
      .offset(KEEP);
    if (stale.length)
      await tx.delete(agentMemories).where(
        inArray(
          agentMemories.id,
          stale.map((s) => s.id),
        ),
      );
    const [{ n } = { n: 0 }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(agentMemories)
      .where(eq(agentMemories.agentId, agent.id));
    await tx.update(agents).set({ memoryCount: n }).where(eq(agents.id, agent.id));
    return kept.id;
  });
}

/** The owner's view of what the agent remembers, newest first. */
export async function memoriesOf(engine: Engine, agent: AgentRow) {
  const rows = await engine.db
    .select({ memory: agentMemories, title: jobs.title })
    .from(agentMemories)
    .leftJoin(jobs, eq(jobs.id, agentMemories.jobId))
    .where(eq(agentMemories.agentId, agent.id))
    .orderBy(desc(agentMemories.tick), desc(agentMemories.createdAt));
  return rows.map(({ memory: m, title }) => ({
    jobId: m.jobId,
    jobTitle: title ?? '',
    category: m.category,
    client: m.client,
    outcome: m.outcome as 'paid' | 'refunded',
    rating: m.rating,
    price: m.price.toString(),
    lesson: m.lesson,
    tick: m.tick,
  }));
}
