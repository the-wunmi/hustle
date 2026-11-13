import type { Engine } from '../context.ts';

/**
 * Slow provider work (live searches, reflections) that must not hold the serial lane. A tick starts a
 * task here and moves on; a later tick picks up what it stored. Tasks are keyed, so one never runs
 * twice at once, and each pool has its own limit. In memory only: after a restart the stage starts
 * the task again, and its keyed `think` retries an interrupted call at most once.
 */
const running = new Map<string, Promise<void>>();
const inPool = new Map<string, number>();

export const isRunning = (key: string): boolean => running.has(key);

/** Starts `fn` unless the key is already running or the pool is full; whether it started. */
export function startBackground(
  engine: Engine,
  pool: string,
  limit: number,
  key: string,
  fn: () => Promise<void>,
): boolean {
  if (running.has(key) || (inPool.get(pool) ?? 0) >= limit) return false;
  inPool.set(pool, (inPool.get(pool) ?? 0) + 1);
  const task = fn()
    .catch((err) => engine.log('background task failed', { key, error: String(err) }))
    .finally(() => {
      running.delete(key);
      inPool.set(pool, (inPool.get(pool) ?? 1) - 1);
    });
  running.set(key, task);
  return true;
}

/** Waits for every running task (tests, and a clean shutdown). */
export async function backgroundIdle(): Promise<void> {
  while (running.size) await Promise.all([...running.values()]);
}
