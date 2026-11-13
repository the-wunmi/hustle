import { createHash } from 'node:crypto';
import { DBOS, Error as DBOSErrors } from '@dbos-inc/dbos-sdk';
import { DrizzleDataSource } from '@dbos-inc/drizzle-datasource';
import { ChainError } from '@hustle/chain';
import { DomainError } from '@hustle/core';
import type { createPool, Db, Schema, Tx } from '@hustle/db';
import * as schema from '@hustle/db';
import type { Engine } from './context.ts';

/**
 * Durable work on DBOS. A workflow is a function whose steps are checkpointed in DBOS's system
 * database; a process that dies mid-workflow resumes it from the
 * last completed step when it starts again. Database writes run as transaction steps through the
 * Drizzle data source, so a write and its checkpoint commit together. Every outside effect (a chain
 * call) is a step and also carries our own idempotency key, because a step can run twice if the
 * process dies between the effect and its checkpoint; the chain gateways answer a repeated key with
 * the first call's result.
 */

/**
 * Recorded with every workflow; recovery only resumes workflows of the same version. Bump it when
 * a workflow's steps change order or meaning, and finish or cancel old pending workflows first.
 */
export const WORKFLOW_VERSION = 'hustle-1';

/** How long a caller waits for a workflow before answering "still in progress"; the work goes on. */
const CALLER_WAIT_SECONDS = 60;
const LATE = Symbol('late');

let current: { engine: Engine; ds: DrizzleDataSource<Db> } | undefined;

/** The engine the workflows run against: one per process, like DBOS itself. */
export function durableEngine(): Engine {
  if (!current) throw new Error('DBOS is not launched: create the engine first');
  return current.engine;
}

/** The DBOS system database: its own database next to the game's (`<db>_dbos`), unless set. */
export function systemDatabaseUrl(env: NodeJS.ProcessEnv): string {
  if (env.DBOS_SYSTEM_DATABASE_URL) return env.DBOS_SYSTEM_DATABASE_URL;
  const base = env.DATABASE_URL ?? 'postgres://hustle:hustle@localhost:5436/hustle';
  const url = new URL(base);
  url.pathname = `/${url.pathname.slice(1) || 'hustle'}_dbos`;
  return url.toString();
}

/**
 * Launches DBOS for this engine. Workflows a previous process left unfinished resume in the
 * background (`engine.recovered` settles when they have), so the API can answer health checks at
 * once; the server waits on it, bounded, before the world ticks. Their chain calls go through the
 * per-signer queue, so a resume storm sends one transaction per account at a time.
 */
export async function launchDurable(engine: Engine, env: NodeJS.ProcessEnv): Promise<void> {
  if (current) throw new Error('DBOS is already launched in this process');
  await import('./workflows.ts');
  const ds = new DrizzleDataSource<Db>(
    'hustle',
    (engine.db as Db & { $client: ReturnType<typeof createPool> }).$client,
    schema as unknown as Schema,
  );
  current = { engine, ds };
  DBOS.setConfig({
    name: 'hustle',
    systemDatabaseUrl: systemDatabaseUrl(env),
    applicationVersion: WORKFLOW_VERSION,
    logLevel: env.DBOS_LOG_LEVEL ?? (env.NODE_ENV === 'test' ? 'error' : 'warn'),
  });
  await DBOS.launch();
  engine.recovering = true;
  engine.recovered = finishRecovered(engine)
    .catch((err) => engine.log('resuming workflows failed', { error: String(err) }))
    .finally(() => {
      engine.recovering = false;
    });
}

export async function shutdownDurable(): Promise<void> {
  if (!current) return;
  current = undefined;
  await DBOS.shutdown();
}

async function finishRecovered(engine: Engine): Promise<void> {
  // Launch hands interrupted workflows to DBOS's internal recovery queue (ENQUEUED), which runs them
  // in the background; wait for both those and any still marked PENDING.
  const pending = await DBOS.listWorkflows({ status: ['PENDING', 'ENQUEUED'] });
  for (const wf of pending) {
    engine.log('finishing a workflow left by the last process', {
      workflow: wf.workflowName,
      id: wf.workflowID,
    });
    await DBOS.retrieveWorkflow(wf.workflowID)
      .getResult({ pollingIntervalMs: 200 })
      .catch((err) => engine.log('recovered workflow failed', { error: String(err) }));
  }
}

/** A workflow id that is unique to this world, so a fresh world never meets an old world's ids. */
export function wfId(engine: Engine, kind: string, natural: string): string {
  return `${engine.clock.seed}:${kind}:${natural}`;
}

/** A UUID derived from text, for request ids that must be the same on every replay. */
export function stableUuid(text: string): string {
  const h = createHash('sha256').update(text).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * Starts a workflow under an id (a second start with the same id is a no-op that returns the first
 * run's handle) and waits for its result. A workflow still waiting on the chain after a minute
 * keeps going in the background; the caller hears that it is in progress, not that it failed.
 */
export async function runOnce<Args extends unknown[], R>(
  workflow: (...args: Args) => Promise<R>,
  id: string,
  ...args: Args
): Promise<R> {
  const handle = await DBOS.startWorkflow(workflow, { workflowID: id })(...args);
  // A workflow started here is awaited in memory; one started earlier is polled for, briefly.
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<typeof LATE>((resolve) => {
    timer = setTimeout(() => resolve(LATE), CALLER_WAIT_SECONDS * 1000);
  });
  try {
    const result = await Promise.race([handle.getResult({ pollingIntervalMs: 100 }), late]);
    if (result === LATE)
      throw new DomainError(
        'unavailable',
        'The chain has not answered yet. This will finish on its own; check back shortly.',
      );
    return result;
  } finally {
    clearTimeout(timer);
  }
}

/** Whether a workflow with this id has started (in any state). */
export async function workflowExists(id: string): Promise<boolean> {
  return (await DBOS.getWorkflowStatus(id)) !== null;
}

/**
 * Runs `fn` in an app-database transaction. Inside a workflow it is a DBOS transaction step: its
 * writes and its checkpoint commit together, so it happens exactly once.
 */
export function inTx<T>(name: string, fn: (db: Tx) => Promise<T>): Promise<T> {
  if (!current) throw new Error('DBOS is not launched');
  const { ds } = current;
  return ds.runTransaction(() => fn(ds.client as unknown as Tx), {
    name,
    isolationLevel: 'read committed',
  });
}

/** A read of the chain or the database, checkpointed so a replay sees what the first run saw. */
export function readStep<T>(name: string, fn: () => Promise<T>): Promise<T> {
  return DBOS.runStep(fn, { name, retriesAllowed: true, maxAttempts: 5, intervalSeconds: 1 });
}

/** A test hook: kill the process at a named point, the way a crash would (SIGKILL, no cleanup). */
export function crashPoint(name: string): void {
  const at = process.env.HUSTLE_CRASH_AT;
  if (!at || at !== name) return;
  const skip = Number(process.env.HUSTLE_CRASH_SKIP ?? 0);
  crashSeen.set(name, (crashSeen.get(name) ?? 0) + 1);
  if ((crashSeen.get(name) ?? 0) > skip) process.kill(process.pid, 'SIGKILL');
}
const crashSeen = new Map<string, number>();

export type ChainOutcome<T> = { ok: true; value: T } | { ok: false; code: string };

/**
 * One chain call with its idempotency key already inside `fn` (the gateway answers a repeated key
 * with the first call's result). A contract refusal is final and returned as `ok: false`. No answer
 * is never a failure: in a workflow the call stays in doubt, and the step is tried again with the
 * same key (the gateway asks the chain whether the first try landed) until the chain answers.
 * Outside a workflow (the world tick) the error goes up and the next tick tries again.
 */
export async function chainCall<T>(label: string, fn: () => Promise<T>): Promise<ChainOutcome<T>> {
  const attempt = async (): Promise<ChainOutcome<T>> => {
    try {
      const value = await fn();
      crashPoint(`chain:${label}`);
      return { ok: true, value };
    } catch (err) {
      if (err instanceof ChainError) return { ok: false, code: err.code };
      throw err;
    }
  };
  if (!DBOS.isWithinWorkflow() || DBOS.isInStep() || DBOS.isInTransaction()) return attempt();
  for (let i = 0; ; i++) {
    try {
      return await DBOS.runStep(attempt, { name: label });
    } catch (err) {
      if (isWorkflowControl(err)) throw err;
      current?.engine.log('chain call in doubt; asking again', {
        call: label,
        error: String(err).slice(0, 200),
        stack: (err as Error)?.stack?.split('\n').slice(1, 4).join(' | '),
      });
      await DBOS.sleep(Math.min(30_000, 500 * 2 ** i));
    }
  }
}

/** DBOS signals cancellation and recovery with its own errors; those must pass through. */
export function isWorkflowControl(err: unknown): boolean {
  return (
    err instanceof DBOSErrors.DBOSError && !(err instanceof DBOSErrors.DBOSMaxStepRetriesError)
  );
}

export { DBOS };
