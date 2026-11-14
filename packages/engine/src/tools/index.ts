import { inferenceCalls } from '@hustle/db';
import {
  callCostMicro,
  type ToolSpec,
  toolCost,
  toolsFor as toolsForJob,
  workCalls,
} from '@hustle/economy';
import { like } from 'drizzle-orm';
import { type AgentRow, snapshotOf, tierOf } from '../agents/state.ts';
import type { Engine } from '../context.ts';
import { toolsFor } from '../context.ts';
import { backgroundIdle, isRunning, startBackground } from '../world/background.ts';
import { type JobRow, jobSnapshot } from '../world/jobs.ts';
import { chainData } from './chain-data.ts';
import { fetchPage } from './fetch.ts';
import { python } from './python.ts';
import { webSearch } from './web-search.ts';

/** What one use of a tool gave the agent for its draft, and what it cost. */
export type ToolRun =
  | {
      ok: true;
      notes: string;
      sources: { title: string; url: string }[];
      cost: bigint;
    }
  | { ok: false; reason: string };

/**
 * Runs one tool (economy `ToolSpec`) for an agent on a job. Each runs once per job: its key makes a
 * retry return the stored result. A new tool is a spec in the economy plus a runner here.
 */
export interface ToolRunner {
  readonly id: string;
  /** Whether this server can run it at all (the Python sandbox needs a sandbox). */
  available?: (engine: Engine) => boolean;
  /**
   * `input` is what the agent loop asked for (a query, token ids); without it the tool works from
   * the brief. `key` keys the use, so one job can use a tool more than once.
   */
  run(
    engine: Engine,
    agent: AgentRow,
    job: JobRow,
    spec: ToolSpec,
    use?: { input: string; key: string },
  ): Promise<ToolRun>;
}

export const RUNNERS: Record<string, ToolRunner> = Object.fromEntries(
  [webSearch, chainData, python, fetchPage].map((r) => [r.id, r]),
);

/**
 * The tools this agent can use on this job, with a runner each: the same rule the cost estimate uses
 * (no tools on practice; frugal agents only for research), over the tools it has access to.
 */
export function usableTools(
  engine: Engine,
  agent: AgentRow,
  job: JobRow,
  opts: { loop?: boolean } = {},
): readonly ToolSpec[] {
  const access = toolsFor(engine, agent);
  // The loop also gets the tools that need an input it chooses (a URL to read).
  const inputTools = opts.loop
    ? access.filter(
        (t) => t.needsInput && t.helps.includes(job.category as ToolSpec['helps'][number]),
      )
    : [];
  return [...toolsForJob(snapshotOf(agent), jobSnapshot(job, null), access), ...inputTools].filter(
    (t) => {
      const runner = RUNNERS[t.id];
      return runner !== undefined && (runner.available?.(engine) ?? true);
    },
  );
}

/** Tool calls running at once, in the background (each may take minutes of searching). */
const TOOL_POOL = 4;
/** Results of background runs, collected by the job's next tools stage. */
const finished = new Map<string, ToolRun>();

const keyOf = (id: string, job: JobRow) => `tool:${id}:${job.id}`;

/**
 * One step of a tool for a job, never holding the serial lane for a provider call: the first step
 * starts the run in the background, later steps wait for it, and the step after it finishes returns
 * the result. A tool already paid for (stored under its key) is returned as stored, whatever the cap.
 */
export async function toolStep(
  engine: Engine,
  agent: AgentRow,
  job: JobRow,
  id: string,
): Promise<ToolRun | 'wait'> {
  const key = keyOf(id, job);
  const done = finished.get(key);
  if (done) {
    finished.delete(key);
    return done;
  }
  if (isRunning(key)) return 'wait';
  const spec = usableTools(engine, agent, job).find((t) => t.id === id);
  const runner = RUNNERS[id];
  if (!spec || !runner) return { ok: false, reason: 'unavailable' };
  // Any call under the tool's key (`tool:<id>:<job>`, or per round `…:r<n>`) means it started before.
  const [stored] = await engine.db
    .select({ status: inferenceCalls.status })
    .from(inferenceCalls)
    .where(like(inferenceCalls.key, `${key}%`))
    .limit(1);
  // Started before (a stage rerun or a restart): resume in the background whatever the cap, since
  // it was checked when it started and its keyed calls never pay twice. Never inline on the lane.
  if (!stored && !(await capLeavesRoom(engine, agent, job, spec)))
    return { ok: false, reason: 'job_cap' };
  startBackground(engine, 'tool', TOOL_POOL, key, async () => {
    finished.set(key, await runner.run(engine, agent, job, spec));
  });
  return 'wait';
}

/**
 * Whether the job's cap leaves room for the tool and the writing still to come (a search that ate
 * the cap would leave the draft unpaid).
 */
async function capLeavesRoom(
  engine: Engine,
  agent: AgentRow,
  job: JobRow,
  spec: ToolSpec,
): Promise<boolean> {
  const brain = engine.brains[tierOf(agent)];
  const writing = workCalls(snapshotOf(agent), jobSnapshot(job, null))
    .filter((c) => c.purpose === 'draft' || c.purpose === 'review')
    .reduce((t, c) => t + callCostMicro(brain, c), 0n);
  const wallet = await engine.chain.getWallet(agent.accountId ?? '');
  const spent = wallet.jobSpent[job.id] ?? 0n;
  return spent + toolCost(spec, brain) + writing <= wallet.rulebook.maxPerJob;
}

/** Runs a tool to completion in the caller (tests and scripts; the world uses `toolStep`). */
export async function runTool(
  engine: Engine,
  agent: AgentRow,
  job: JobRow,
  id: string,
): Promise<ToolRun> {
  for (;;) {
    const step = await toolStep(engine, agent, job, id);
    if (step !== 'wait') return step;
    await backgroundIdle();
  }
}
