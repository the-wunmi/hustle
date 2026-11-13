import { serve } from '@hono/node-server';
import { createDb, createPool } from '@hustle/db';
import { runMigrations } from '@hustle/db/migrate';
import { closeEngine, createEngine, seedWorld, startWorld } from '@hustle/engine';
import { createApp } from './app.ts';

/** How long the world waits for workflows left by the last process before it ticks anyway. */
const RECOVERY_WAIT_MS = Number(process.env.RECOVERY_WAIT_MS ?? 60_000);

await runMigrations();
const pool = createPool();
const engine = await createEngine({ db: createDb(pool) });

// Serve first: health checks pass while recovered workflows finish behind them.
const port = Number(process.env.PORT ?? 4300);
const server = serve({ fetch: createApp(engine).fetch, port }, () => {
  engine.log(`API on http://localhost:${port}`, { modes: engine.modes, tick: engine.clock.tick });
});

let stopWorld: () => Promise<void> = async () => {};
const waited = await Promise.race([
  engine.recovered.then(() => 'recovered' as const),
  new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), RECOVERY_WAIT_MS).unref()),
]);
if (waited === 'timeout')
  engine.log('recovered workflows still running; starting the world anyway', {
    waitedMs: RECOVERY_WAIT_MS,
  });
await engine.lane.run(() => seedWorld(engine));
stopWorld = startWorld(engine);

const shutdown = async () => {
  server.close();
  await stopWorld();
  await closeEngine();
  await pool.end();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
