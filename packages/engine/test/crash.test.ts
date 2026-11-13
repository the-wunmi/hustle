import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createPool } from '@hustle/db';
import { runMigrations } from '@hustle/db/migrate';
import { freshTestDatabase } from '@hustle/db/test-databases';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Crash tests: a real process is killed (SIGKILL, no cleanup) in the middle of a workflow, then a
 * new process boots on the same databases. DBOS resumes the workflow from its last checkpoint; the
 * test checks the work finished and that no effect happened twice. The kill lands right after the
 * chain call and before DBOS records it, the worst place: the retried step must find the first
 * call on chain by its key instead of sending it again. CHAIN_MODE=sim (the Postgres simulator of
 * the same contracts), so every effect can be counted.
 */

const TSX = fileURLToPath(new URL('../../../node_modules/.bin/tsx', import.meta.url));
const CHILD = fileURLToPath(new URL('./crash-child.ts', import.meta.url));

let env: Record<string, string>;
let db: ReturnType<typeof createPool>;
let system: ReturnType<typeof createPool>;

function run(op: string, crashAt?: string, skip = 0) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null; out: string }>(
    (resolve) => {
      const child = spawn(TSX, [CHILD, op], {
        env: {
          ...process.env,
          ...env,
          DAY_TICKS: '6',
          ...(crashAt ? { HUSTLE_CRASH_AT: crashAt, HUSTLE_CRASH_SKIP: String(skip) } : {}),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout.on('data', (d) => {
        out += d;
      });
      child.stderr.on('data', (d) => {
        out += d;
      });
      child.on('exit', (code, signal) => resolve({ code, signal, out }));
    },
  );
}

/** Kills a process at `crashAt` during `op`, then boots a fresh one, which must finish the work. */
async function crashThenRecover(op: string, crashAt: string, skip = 0) {
  const crashed = await run(op, crashAt, skip);
  // tsx relays the killed process as exit code 137 (128 + SIGKILL).
  expect(crashed.signal === 'SIGKILL' || crashed.code === 137, crashed.out).toBe(true);
  const recovered = await run('boot');
  expect(recovered.code, recovered.out).toBe(0);
}

const count = async (sql: string, params: unknown[] = []) =>
  Number((await db.query(sql, params)).rows[0]?.n ?? 0);

/** How many successful transactions emitted an event matching `match`. */
const events = (match: unknown) =>
  count(`select count(*) n from sim_txs where outcome = 'success' and events @> $1::jsonb`, [
    JSON.stringify([match]),
  ]);

const workflowStatuses = async (kind: string) =>
  (
    await system.query(
      `select status from dbos.workflow_status where workflow_uuid like $1 order by workflow_uuid`,
      [`%:${kind}:%`],
    )
  ).rows.map((r) => r.status as string);

beforeAll(async () => {
  env = await freshTestDatabase('crash');
  await runMigrations(env.DATABASE_URL);
  const booted = await run('boot');
  expect(booted.code, booted.out).toBe(0);
  db = createPool(env.DATABASE_URL);
  system = createPool(env.DBOS_SYSTEM_DATABASE_URL);
}, 120_000);

afterAll(async () => {
  await db?.end();
  await system?.end();
});

describe('a process killed mid-workflow', () => {
  it('escrow post: the job opens once, with one escrow on the board', async () => {
    await crashThenRecover('escrow', 'chain:post_job');
    const rows = (
      await db.query(
        `select id, status, chain_job_id from jobs where title = 'Crash test: summarise a memo'`,
      )
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'open' });
    expect(rows[0]?.chain_job_id).toBeTruthy();
    expect(
      await count(`select count(*) n from sim_txs where key = $1 and outcome = 'success'`, [
        `post:${rows[0]?.id}`,
      ]),
    ).toBe(1);
    expect(await events({ event: 'job_posted', data: { job_id: rows[0]?.chain_job_id } })).toBe(1);
    expect(await workflowStatuses('escrow')).toContain('SUCCESS');
    expect(await workflowStatuses('escrow')).not.toContain('PENDING');
  }, 120_000);

  it('mint: one agent, one NFT, one set of starter credits, one feed post', async () => {
    await crashThenRecover('mint', 'chain:mint_agent');
    const rows = (await db.query(`select id, account_id from agents where name = 'Crashy'`)).rows;
    expect(rows).toHaveLength(1);
    const { id, account_id: accountId } = rows[0] ?? {};
    expect(accountId).toBeTruthy();
    expect(
      await count(`select count(*) n from sim_txs where key = $1 and outcome = 'success'`, [
        `mintagent:${id}`,
      ]),
    ).toBe(1);
    expect(await events({ event: 'nft_mint', data: { token_ids: [accountId] } })).toBe(1);
    expect(
      await count(`select count(*) n from sim_txs where key = $1 and outcome = 'success'`, [
        `mint:starter-agent:${id}`,
      ]),
    ).toBe(1);
    expect(
      await count(`select count(*) n from ledger where ref = $1`, [`starter-agent:${id}`]),
    ).toBe(1);
    expect(
      await count(`select count(*) n from feed where kind = 'minted' and agent_id = $1`, [id]),
    ).toBe(1);
    expect(await workflowStatuses('mint')).not.toContain('PENDING');
  }, 120_000);

  it('a crash between sign-in and the first on-chain action: one account, one starter grant', async () => {
    // Sign-in makes only the row; adopting makes the account, and the process dies right after the
    // account exists, before the starter credits.
    await crashThenRecover('lazy-adopt', 'account:created');
    const [player] = (
      await db.query(`select id, account_id, account_ready from players where name = 'Lazy'`)
    ).rows;
    expect(player?.account_ready).toBe(true);
    const created = () =>
      count(`select count(*) n from sim_txs where key = $1 and outcome = 'success'`, [
        `account:${player?.account_id}`,
      ]);
    const starter = () =>
      count(`select count(*) n from ledger where ref = $1`, [`starter:${player?.id}`]);
    expect(await created()).toBe(1);
    expect(await starter()).toBe(1);
    expect(await workflowStatuses('account')).not.toContain('PENDING');
    // The next action finds the account ready and makes nothing again.
    const again = await run('lazy-adopt-again');
    expect(again.code, again.out).toBe(0);
    expect(await created()).toBe(1);
    expect(await starter()).toBe(1);
    expect(await count(`select count(*) n from agents where name = 'Lazytwo'`)).toBe(1);
  }, 180_000);

  it('market sale: the agent moves once, the buyer pays once, the books record one sale', async () => {
    const setup = await run('sale-setup');
    expect(setup.code, setup.out).toBe(0);
    await crashThenRecover('sale', 'chain:buy_agent');
    const [agent] = (
      await db.query(
        `select a.id, a.account_id, p.name owner, a.frozen from agents a join players p on p.id = a.owner_id where a.name = 'Forsale'`,
      )
    ).rows;
    expect(agent).toMatchObject({ owner: 'Buyer', frozen: true });
    expect(await events({ event: 'sold', data: { token_id: agent?.account_id } })).toBe(1);
    expect(await count(`select count(*) n from agent_sales where agent_id = $1`, [agent?.id])).toBe(
      1,
    );
    expect(
      await count(`select count(*) n from ledger where kind in ('agent_purchase', 'agent_sale')`),
    ).toBe(2);
    expect(await workflowStatuses('buy')).toEqual(['SUCCESS']);
    // A retry of the same request after recovery is the same sale, not a second one.
    const again = await run('sale');
    expect(again.code, again.out).toBe(0);
    expect(await count(`select count(*) n from agent_sales where agent_id = $1`, [agent?.id])).toBe(
      1,
    );
  }, 120_000);

  it('end of day: every agent is closed once, no upkeep is charged twice', async () => {
    // Killed during the third agent's upkeep, with others mid-close around it.
    await crashThenRecover('endday', 'chain:upkeep', 2);
    const awake = (
      await db.query(`select id from agents where account_id is not null and frozen = false`)
    ).rows.map((r) => r.id as string);
    for (const id of awake) {
      expect(
        await events({ event: 'spend_settled', data: { key: `upkeep:${id}:1` } }),
        `upkeep for ${id}`,
      ).toBeLessThanOrEqual(1);
      expect(
        await count(`select count(*) n from ledger where ref = $1`, [`upkeep:${id}:1`]),
      ).toBeLessThanOrEqual(1);
    }
    const reported = await count(`select count(*) n from day_reports where day = 1`);
    const agents = await count(`select count(*) n from agents where account_id is not null`);
    expect(reported).toBe(agents);
    // Every settled upkeep is in the books exactly once, and vice versa.
    expect(await count(`select count(*) n from ledger where kind = 'upkeep' and day = 1`)).toBe(
      await count(
        `select count(*) n from sim_txs, jsonb_array_elements(events) e where outcome = 'success' and e->>'event' = 'spend_settled' and e->'data'->>'key' like 'upkeep:%:1'`,
      ),
    );
    const statuses = await workflowStatuses('endday');
    expect(statuses.length).toBeGreaterThan(1);
    expect(statuses.every((s) => s === 'SUCCESS')).toBe(true);
    // Ticking on asks for day 1's close again: a no-op, and the day counts as closed.
    const ticked = await run('endday');
    expect(ticked.code, ticked.out).toBe(0);
    const clock = (await db.query(`select value from settings where key = 'world'`)).rows[0]?.value;
    expect(clock.closedDay).toBeGreaterThanOrEqual(1);
    expect(await count(`select count(*) n from day_reports where day = 1`)).toBe(agents);
  }, 180_000);
});
