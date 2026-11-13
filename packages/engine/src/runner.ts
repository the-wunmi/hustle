import { createHash, randomBytes } from 'node:crypto';
import { DomainError } from '@hustle/core';
import { agents, jobs, runners, runnerTasks } from '@hustle/db';
import { and, asc, eq, gt, inArray, lt } from 'drizzle-orm';
import { z } from 'zod';
import type { AgentRow } from './agents/state.ts';
import type { Engine } from './context.ts';
import { isAgentFileName, jobFilesOf, MAX_AGENT_FILE_CHARS, saveJobFile } from './files.ts';
import type { PlayerRow } from './players.ts';

/**
 * An owner's computer as the agent's hands: the agent decides on Hustle (metered, paid from its
 * wallet); a runner script on the owner's machine collects the commands it asks for, shows each to
 * the owner, runs the approved ones in a throwaway container there and sends back the output and
 * the files it made. No keys or wallet ever leave Hustle; the runner holds only its own token.
 */

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
/** How long a pairing code works, and how recently a runner must have asked for work to count. */
const CODE_TTL_MS = 10 * 60_000;
const ONLINE_MS = 60_000;
/** How long a command waits for the owner (and its run) before the agent goes on without it. */
export const LOCAL_WAIT_MS = 15 * 60_000;
/** A command collected by the runner (being decided, or running) may report until this old. */
const SENT_WAIT_MS = 40 * 60_000;
const MAX_OUTPUT = 64_000;
const MAX_FILES_BACK = 10;
const MAX_FILES_BACK_CHARS = 400_000;

/** Codes are read off a screen and typed: no 0/O or 1/I. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function pairingCode(): string {
  const bytes = randomBytes(8);
  const chars = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

/**
 * The owner links a computer (or replaces the linked one): a one-time code the runner trades for its
 * token. Pairing again cuts off the old token.
 */
export async function pairRunner(
  engine: Engine,
  player: PlayerRow,
  agent: AgentRow,
): Promise<{ code: string; expiresAt: string }> {
  const code = pairingCode();
  const expires = new Date(Date.now() + CODE_TTL_MS);
  await engine.db
    .insert(runners)
    .values({
      agentId: agent.id,
      ownerId: player.id,
      codeHash: hash(code),
      codeExpiresAt: expires,
    })
    .onConflictDoUpdate({
      target: runners.agentId,
      set: {
        ownerId: player.id,
        codeHash: hash(code),
        codeExpiresAt: expires,
        tokenHash: null,
        lastSeenAt: null,
      },
    });
  return { code, expiresAt: expires.toISOString() };
}

/** The owner unlinks the computer: its token stops working and waiting commands expire. */
export async function unpairRunner(
  engine: Engine,
  _player: PlayerRow | null,
  agent: Pick<AgentRow, 'id'>,
): Promise<void> {
  await engine.db.delete(runners).where(eq(runners.agentId, agent.id));
  await engine.db
    .update(runnerTasks)
    .set({ status: 'expired', finishedAt: new Date() })
    .where(
      and(eq(runnerTasks.agentId, agent.id), inArray(runnerTasks.status, ['pending', 'sent'])),
    );
}

export const ClaimPairing = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z2-9]{4}-?[A-Z2-9]{4}$/),
  machine: z.string().trim().max(120).default(''),
});

/** The runner trades a pairing code for its token (shown once; only its hash is kept). */
export async function claimPairing(
  engine: Engine,
  input: z.input<typeof ClaimPairing>,
): Promise<{ token: string; agentId: string }> {
  const parsed = ClaimPairing.safeParse(input);
  if (!parsed.success) throw new DomainError('invalid', 'That pairing code is not valid');
  const code = parsed.data.code.replace(/^(.{4})-?(.{4})$/, '$1-$2');
  const token = `hr_${randomBytes(32).toString('base64url')}`;
  const [row] = await engine.db
    .update(runners)
    .set({
      tokenHash: hash(token),
      codeHash: null,
      codeExpiresAt: null,
      machine: parsed.data.machine || null,
      lastSeenAt: new Date(),
    })
    .where(and(eq(runners.codeHash, hash(code)), gt(runners.codeExpiresAt, new Date())))
    .returning();
  if (!row) throw new DomainError('invalid', 'That pairing code is wrong or has expired');
  return { token, agentId: row.agentId };
}

export type RunnerRow = typeof runners.$inferSelect;

/**
 * The runner behind a bearer token, or null. A link counts only while whoever made it still owns the
 * agent: a sold agent's old computer gets nothing.
 */
export async function runnerFor(
  engine: Engine,
  token: string | undefined,
): Promise<RunnerRow | null> {
  if (!token?.startsWith('hr_')) return null;
  const [row] = await engine.db
    .select({ runner: runners })
    .from(runners)
    .innerJoin(agents, and(eq(agents.id, runners.agentId), eq(agents.ownerId, runners.ownerId)))
    .where(eq(runners.tokenHash, hash(token)));
  return row?.runner ?? null;
}

/** Whether the agent's owner has a computer linked and asking for work right now. */
export async function runnerOnline(engine: Engine, agentId: string): Promise<boolean> {
  const [row] = await engine.db
    .select({ seen: runners.lastSeenAt, token: runners.tokenHash })
    .from(runners)
    .innerJoin(agents, and(eq(agents.id, runners.agentId), eq(agents.ownerId, runners.ownerId)))
    .where(eq(runners.agentId, agentId));
  return !!row?.token && !!row.seen && Date.now() - row.seen.getTime() < ONLINE_MS;
}

/** What the owner's page shows about the linked computer. */
export async function runnerView(engine: Engine, agentId: string) {
  const [row] = await engine.db.select().from(runners).where(eq(runners.agentId, agentId));
  if (!row) return null;
  return {
    paired: !!row.tokenHash,
    online:
      !!row.tokenHash && !!row.lastSeenAt && Date.now() - row.lastSeenAt.getTime() < ONLINE_MS,
    machine: row.machine,
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
  };
}

/** The agent asks for a command on its owner's computer (once per loop step). */
export async function queueCommand(
  engine: Engine,
  agent: AgentRow,
  jobId: string,
  n: number,
  command: string,
): Promise<void> {
  await engine.db
    .insert(runnerTasks)
    .values({ jobId, agentId: agent.id, n, command, status: 'pending' })
    .onConflictDoNothing();
}

/** A command's state for the loop: still waiting, or what came of it. */
export async function commandResult(
  engine: Engine,
  jobId: string,
  n: number,
): Promise<
  | { state: 'waiting' }
  | { state: 'done'; exitCode: number; output: string }
  | { state: 'denied' }
  | { state: 'expired' }
> {
  const [task] = await engine.db
    .select()
    .from(runnerTasks)
    .where(and(eq(runnerTasks.jobId, jobId), eq(runnerTasks.n, n)));
  if (!task) return { state: 'expired' };
  if (task.status === 'done')
    return { state: 'done', exitCode: task.exitCode ?? -1, output: task.output ?? '' };
  if (task.status === 'denied') return { state: 'denied' };
  if (task.status === 'expired') return { state: 'expired' };
  const limit = task.status === 'sent' ? SENT_WAIT_MS : LOCAL_WAIT_MS;
  if (Date.now() - task.createdAt.getTime() > limit) {
    await engine.db
      .update(runnerTasks)
      .set({ status: 'expired', finishedAt: new Date() })
      .where(eq(runnerTasks.id, task.id));
    return { state: 'expired' };
  }
  return { state: 'waiting' };
}

/**
 * The runner asks for work: it counts as online, and gets the oldest waiting command for its agent
 * (marked sent), with the job's brief and its client files so the job folder can be set up.
 */
export async function nextCommand(engine: Engine, runner: RunnerRow) {
  await engine.db.update(runners).set({ lastSeenAt: new Date() }).where(eq(runners.id, runner.id));
  // Commands nobody collected in time are dropped rather than run late.
  await engine.db
    .update(runnerTasks)
    .set({ status: 'expired', finishedAt: new Date() })
    .where(
      and(
        eq(runnerTasks.agentId, runner.agentId),
        eq(runnerTasks.status, 'pending'),
        lt(runnerTasks.createdAt, new Date(Date.now() - LOCAL_WAIT_MS)),
      ),
    );
  const [task] = await engine.db
    .update(runnerTasks)
    .set({ status: 'sent' })
    .where(
      and(
        // Still pending when claimed, so two polls can't both take it.
        eq(runnerTasks.status, 'pending'),
        eq(
          runnerTasks.id,
          engine.db
            .select({ id: runnerTasks.id })
            .from(runnerTasks)
            .where(and(eq(runnerTasks.agentId, runner.agentId), eq(runnerTasks.status, 'pending')))
            .orderBy(asc(runnerTasks.createdAt))
            .limit(1),
        ),
      ),
    )
    .returning();
  if (!task) return null;
  const [job] = await engine.db.select().from(jobs).where(eq(jobs.id, task.jobId));
  const files = (await jobFilesOf(engine, task.jobId))
    .filter((f) => f.source === 'client' || f.source === 'agent')
    .map((f) => ({ name: f.name, content: f.content }));
  return {
    id: task.id,
    jobId: task.jobId,
    jobTitle: job?.title ?? '',
    command: task.command,
    files,
  };
}

export const CommandDone = z.object({
  id: z.uuid(),
  approved: z.boolean(),
  exitCode: z.number().int().min(-1).max(1_000).default(0),
  output: z
    .string()
    .max(MAX_OUTPUT * 2)
    .default(''),
  files: z
    .array(z.object({ name: z.string().max(200), content: z.string().max(MAX_AGENT_FILE_CHARS) }))
    .max(MAX_FILES_BACK * 2)
    .default([]),
});

/**
 * The runner reports a command: the owner's no, or what it printed and the text files it made or
 * changed (saved on the job as `local_<path>`; the agent reads them like any job file).
 */
export async function finishCommand(
  engine: Engine,
  runner: RunnerRow,
  input: z.input<typeof CommandDone>,
): Promise<void> {
  const parsed = CommandDone.safeParse(input);
  if (!parsed.success) throw new DomainError('invalid', 'Bad command result');
  const r = parsed.data;
  const [task] = await engine.db
    .select()
    .from(runnerTasks)
    .where(and(eq(runnerTasks.id, r.id), eq(runnerTasks.agentId, runner.agentId)));
  if (task?.status !== 'sent') throw new DomainError('conflict', 'That command is not waiting');
  await engine.db.update(runners).set({ lastSeenAt: new Date() }).where(eq(runners.id, runner.id));
  // Only for a job its agent is still working: nothing lands on a finished or reassigned job.
  const [job] = await engine.db.select().from(jobs).where(eq(jobs.id, task.jobId));
  if (job?.status !== 'working' || job.awardedAgentId !== runner.agentId) {
    await engine.db
      .update(runnerTasks)
      .set({ status: 'expired', finishedAt: new Date() })
      .where(and(eq(runnerTasks.id, task.id), eq(runnerTasks.status, 'sent')));
    throw new DomainError('conflict', 'That job is no longer being worked');
  }
  if (!r.approved) {
    await engine.db
      .update(runnerTasks)
      .set({ status: 'denied', finishedAt: new Date() })
      .where(and(eq(runnerTasks.id, task.id), eq(runnerTasks.status, 'sent')));
    return;
  }
  let budget = MAX_FILES_BACK_CHARS;
  const kept: string[] = [];
  // Only files this runner made may be replaced, never the client's or the agent's own.
  const others = new Set(
    (await jobFilesOf(engine, task.jobId))
      .filter((f) => f.source !== 'tool:local')
      .map((f) => f.name),
  );
  for (const f of r.files.slice(0, MAX_FILES_BACK)) {
    const name = `local_${f.name.replace(/[\\/]+/g, '_')}`.slice(0, 80);
    if (!isAgentFileName(name) || others.has(name)) continue;
    if (f.content.includes('\u0000') || f.content.length > budget) continue;
    budget -= f.content.length;
    await saveJobFile(engine, task.jobId, name, f.content, 'tool:local', { replace: true });
    kept.push(name);
  }
  const output = r.output.slice(-MAX_OUTPUT);
  await engine.db
    .update(runnerTasks)
    .set({
      status: 'done',
      exitCode: r.exitCode,
      output: `${output}${kept.length ? `\n\n[files back: ${kept.join(', ')}]` : ''}`,
      finishedAt: new Date(),
    })
    .where(and(eq(runnerTasks.id, task.id), eq(runnerTasks.status, 'sent')));
}
