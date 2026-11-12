/**
 * Most chain calls a tick has in flight at once. Each item works on its own agent or job, and on a
 * NEAR node a call takes a few blocks, so running them side by side keeps a tick near one second.
 */
export const TICK_CONCURRENCY = 8;

/** Runs `fn` over `items`, at most `limit` at a time. One item's failure doesn't stop the others. */
export async function inParallel<T>(
  items: readonly T[],
  fn: (item: T) => Promise<void>,
  onError: (item: T, err: unknown) => void,
  limit = TICK_CONCURRENCY,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      try {
        await fn(item);
      } catch (err) {
        onError(item, err);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
