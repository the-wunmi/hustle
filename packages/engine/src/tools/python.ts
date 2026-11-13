import { sha256Hex } from '@hustle/core';
import { sandboxRuns } from '@hustle/db';
import { and, asc, eq } from 'drizzle-orm';
import type { AgentRow } from '../agents/state.ts';
import { think } from '../brain/think.ts';
import type { Engine } from '../context.ts';
import { jobFilesOf } from '../files.ts';
import { book, chainKey } from '../record.ts';
import { brainContext } from '../world/context.ts';
import type { JobRow } from '../world/jobs.ts';
import { pay } from '../world/pay.ts';
import type { ToolRunner } from './index.ts';

/** What a coding turn sees of an earlier run's output. */
const RUN_ECHO = 3_000;
const PREVIEW = 600;
/** Outcomes that are the sandbox's fault, not the code's: not charged, not kept. */
const SANDBOX_FAULTS = new Set(['busy', 'unavailable', 'crashed', 'too_big', 'bad_file_name']);
/** Seconds one sandbox run may take. */
const RUN_TIMEOUT_MS = 20_000;

/**
 * The agent's analysis loop: it writes Python, the sandbox runs it on the job's files, the agent
 * reads what it printed and writes again, up to `usesPerCall` runs. Each turn is a paid model call
 * (keyed per round, so a rerun of the stage never pays twice) and each run pays the sandbox fee.
 * Every run is kept with its code and input hashes, so anyone who may see the deliverable can re-run
 * it in a browser and get the same output.
 */
export const python: ToolRunner = {
  id: 'python',
  available: (engine) => engine.sandbox !== null,
  async run(engine, agent, job, spec) {
    if (!engine.sandbox) return { ok: false, reason: 'unavailable' };
    const fileRows = await jobFilesOf(engine, job.id);
    const listing = fileRows.map((f) => ({
      name: f.name,
      bytes: f.content.length,
      preview: f.content.slice(0, PREVIEW),
    }));
    let cost = 0n;
    let notes = '';
    for (let round = 1; round <= spec.usesPerCall + 1; round++) {
      const runs = await engine.db
        .select()
        .from(sandboxRuns)
        .where(and(eq(sandboxRuns.jobId, job.id), eq(sandboxRuns.agentId, agent.id)))
        .orderBy(asc(sandboxRuns.round));
      const ctx = await brainContext(engine, agent, job, 'code', {
        tool: { id: spec.id, name: spec.name, description: spec.description },
        files: listing,
        runs: runs.map((r) => ({
          code: r.code,
          stdout: r.stdout.slice(0, RUN_ECHO),
          error: r.error,
        })),
      });
      const turn = await think(
        engine,
        agent,
        `tool:python:${job.id}:r${round}`,
        job.id,
        ctx,
        job.body,
      );
      if (!turn.ok) break;
      cost += turn.cost;
      const out = turn.output as { code: string; done: boolean; notes: string };
      notes = out.notes || notes;
      // Done, or out of runs: the last turn may only write notes.
      if (out.done || !out.code.trim() || round > spec.usesPerCall) break;
      if (runs.some((r) => r.round === round)) continue;
      const step = await runSandboxStep(engine, agent, job, out.code, round, spec.fee);
      if (!step.kept) break;
      cost += step.cost;
    }
    const [last] = (
      await engine.db
        .select()
        .from(sandboxRuns)
        .where(and(eq(sandboxRuns.jobId, job.id), eq(sandboxRuns.agentId, agent.id)))
        .orderBy(asc(sandboxRuns.round))
    ).slice(-1);
    if (!last) return { ok: false, reason: 'no_run' };
    const printed = last.error ? `It stopped with: ${last.error}` : last.stdout.slice(0, 1_500);
    return {
      ok: true,
      notes: `${notes}\n\nThe last sandbox run printed:\n${printed}`.trim(),
      sources: [],
      cost,
    };
  },
};

/**
 * One sandbox run for a job, as the Python tool and the agent loop both do it: run first, then pay.
 * A run the sandbox itself cut short (busy, down, crashed) costs nothing and isn't kept; code that
 * errors or runs out of time was the agent's own doing, and is paid and kept. Kept runs carry their
 * code and the hashes of the files they read, for the re-run.
 */
export async function runSandboxStep(
  engine: Engine,
  agent: AgentRow,
  job: JobRow,
  code: string,
  round: number,
  fee: bigint,
): Promise<{ kept: boolean; cost: bigint; stdout: string; error: string | null }> {
  const sandbox = engine.sandbox;
  if (!sandbox) return { kept: false, cost: 0n, stdout: '', error: 'unavailable' };
  const fileRows = await jobFilesOf(engine, job.id);
  const files = Object.fromEntries(fileRows.map((f) => [f.name, f.content]));
  const inputs = Object.fromEntries(fileRows.map((f) => [f.name, f.sha256]));
  const [already] = await engine.db
    .select()
    .from(sandboxRuns)
    .where(
      and(
        eq(sandboxRuns.jobId, job.id),
        eq(sandboxRuns.agentId, agent.id),
        eq(sandboxRuns.round, round),
      ),
    );
  if (already) return { kept: true, cost: 0n, stdout: already.stdout, error: already.error };
  const result = await sandbox.run({ code, files, timeoutMs: RUN_TIMEOUT_MS });
  if (result.error && SANDBOX_FAULTS.has(result.error))
    return { kept: false, cost: 0n, stdout: '', error: result.error };
  const paid = await pay(
    engine,
    agent,
    job,
    chainKey('sbx', `${job.id}:${round}`),
    'inference',
    engine.chain.ids.treasury,
    fee,
    `sandbox run ${round}`,
  );
  // The wallet refused: the run's output is discarded, as for thinking it couldn't pay for.
  if (paid.outcome.status !== 'settled')
    return { kept: false, cost: 0n, stdout: '', error: 'unpaid' };
  await book(engine, {
    ref: `spend:sbx:${job.id}:${round}`,
    kind: 'inference',
    amount: -fee,
    agentId: agent.id,
    playerId: agent.ownerId,
    jobId: job.id,
  });
  await engine.db
    .insert(sandboxRuns)
    .values({
      jobId: job.id,
      agentId: agent.id,
      round,
      code,
      inputs,
      stdout: result.stdout,
      stderr: result.stderr.slice(0, 4_000),
      error: result.error,
      runMs: result.runMs,
      stdoutHash: sha256Hex(result.stdout),
      cost: fee,
      tick: engine.clock.tick,
    })
    .onConflictDoNothing();
  return { kept: true, cost: fee, stdout: result.stdout, error: result.error };
}
