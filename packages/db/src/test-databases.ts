import pg from 'pg';

const DEFAULT_URL = 'postgres://hustle:hustle@localhost:5436/hustle';

/**
 * An empty database for one package's test run, so tests never touch the dev database a running
 * server works from, plus an empty DBOS system database to go with it.
 */
export async function freshTestDatabase(suite: string): Promise<Record<string, string>> {
  const envFile = new URL('../../../.env', import.meta.url).pathname;
  try {
    process.loadEnvFile(envFile);
  } catch {
    // No .env: the default local database from docker-compose is used.
  }
  const base = process.env.DATABASE_URL ?? DEFAULT_URL;
  const name = `hustle_test_${suite}`;
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  try {
    await admin.query(`drop database if exists ${name} with (force)`);
    await admin.query(`create database ${name}`);
    // DBOS's system database for this suite: dropped so no workflow from an earlier run is recovered.
    await admin.query(`drop database if exists ${name}_dbos with (force)`);
  } finally {
    await admin.end();
  }
  const url = new URL(base);
  url.pathname = `/${name}`;
  const system = new URL(base);
  system.pathname = `/${name}_dbos`;
  return { DATABASE_URL: url.toString(), DBOS_SYSTEM_DATABASE_URL: system.toString() };
}
