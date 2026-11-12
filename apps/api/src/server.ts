import { serve } from '@hono/node-server';
import { createDb, createPool } from '@hustle/db';
import { runMigrations } from '@hustle/db/migrate';
import { closeEngine, createEngine, seedWorld, startWorld } from '@hustle/engine';
import { createApp } from './app.ts';

await runMigrations();
const pool = createPool();
const engine = await createEngine({ db: createDb(pool) });
await engine.lane.run(() => seedWorld(engine));
const stopWorld = startWorld(engine);

const port = Number(process.env.PORT ?? 4300);
const server = serve({ fetch: createApp(engine).fetch, port }, () => {
  engine.log(`API on http://localhost:${port}`, { modes: engine.modes, tick: engine.clock.tick });
});

const shutdown = async () => {
  server.close();
  await stopWorld();
  await closeEngine();
  await pool.end();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
