import { createDb, createPool } from '@hustle/db';
import { runMigrations } from '@hustle/db/migrate';
import { freshTestDatabase } from '@hustle/db/test-databases';
import { closeEngine, createEngine, type Engine } from '../src/context.ts';
import { startEmailLogin, verifyEmailLogin } from '../src/players.ts';
import { seedWorld } from '../src/seed.ts';
import { tick } from '../src/world/tick.ts';

/** A fresh database, a seeded world and helpers, so each test reads as the scenario. */
export async function world(suite: string) {
  const env = await freshTestDatabase(suite);
  await runMigrations(env.DATABASE_URL);
  const pool = createPool(env.DATABASE_URL);
  const engine = await createEngine({
    db: createDb(pool),
    env: { ...env, NODE_ENV: 'test', CHAIN_MODE: 'sim', AUTH_MODE: 'mock', NEARAI_MODE: 'mock' },
    secret: `test-${suite}`,
  });
  await seedWorld(engine);
  return {
    engine,
    async signUp(email: string, name: string) {
      const { challengeId, simulatedInbox } = await startEmailLogin(engine, { email });
      return (await verifyEmailLogin(engine, { challengeId, code: simulatedInbox.code, name }))
        .player;
    },
    async run(ticks: number) {
      for (let i = 0; i < ticks; i++) await tick(engine);
    },
    async close() {
      await closeEngine();
      await pool.end();
    },
  };
}

export type World = Awaited<ReturnType<typeof world>>;
export type { Engine };
