// Starts a fresh world: drops the game's database schema, DBOS's system database and the local NEAR
// node's state. Stop `pnpm dev` first; the next `pnpm dev` re-creates all three.
import { existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const url = process.env.DATABASE_URL ?? 'postgres://hustle:hustle@localhost:5436/hustle';
const client = new pg.Client({ connectionString: url });
await client.connect();
await client.query(
  'drop schema if exists public cascade; create schema public; drop schema if exists drizzle cascade; drop schema if exists dbos cascade;',
);
// DBOS's system database (workflow checkpoints) belongs to the old world too.
const system = new URL(url);
system.pathname = `/${system.pathname.slice(1) || 'hustle'}_dbos`;
const systemUrl = process.env.DBOS_SYSTEM_DATABASE_URL ?? system.toString();
const systemName = new URL(systemUrl).pathname.slice(1);
if (systemName && systemName !== new URL(url).pathname.slice(1))
  await client.query(`drop database if exists "${systemName.replaceAll('"', '')}" with (force)`);
await client.end();
const nodeHome = process.env.NEAR_SANDBOX_HOME || `${root}.near-sandbox`;
if (existsSync(nodeHome)) rmSync(nodeHome, { recursive: true });
console.log(
  'Fresh world: database schema and workflow history dropped, local chain state removed.',
);
