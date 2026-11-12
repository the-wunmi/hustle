import { createDb, createPool } from '@hustle/db';
import { runMigrations } from '@hustle/db/migrate';
import { freshTestDatabase } from '@hustle/db/test-databases';
import { afterAll, beforeAll } from 'vitest';
import { chainConformance } from '../src/conformance.ts';
import { SimChain } from '../src/sim.ts';

let pool: ReturnType<typeof createPool>;
let clock = 1_000_000;

beforeAll(async () => {
  const env = await freshTestDatabase('chain');
  await runMigrations(env.DATABASE_URL);
  pool = createPool(env.DATABASE_URL);
});
afterAll(async () => {
  await pool.end();
});

chainConformance('SimChain', async () => ({
  gateway: new SimChain(createDb(pool), () => clock),
  advance: async (ms) => {
    clock += ms;
  },
}));
