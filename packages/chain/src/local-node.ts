import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { KeyPairString } from 'near-api-js';
import { Sandbox } from 'near-sandbox';

/**
 * The local NEAR node the game runs on by default: nearcore's sandbox build with a persistent home
 * directory, so the chain survives restarts alongside the game's database.
 */
export interface LocalNodeConfig {
  home: string;
  rpcPort: number;
  netPort: number;
}

/** Hustle's ports: RPC next to the web (3300) and API (4300) ports, out of the other project's way. */
export const DEFAULT_RPC_PORT = 3330;
const DEFAULT_NET_PORT = 24_730;
const SANDBOX_VERSION = '2.14.0';
/**
 * Fast blocks keep a game tick to about a second even when it sends dozens of transactions. GC must
 * keep pace with block production, or nearcore refuses the config.
 */
const BLOCK_DELAY_MIN_NS = 100_000_000;
const BLOCK_DELAY_MAX_NS = 300_000_000;
const GC_BLOCKS_LIMIT = 20;
/**
 * Epochs of history the node keeps (500 blocks each). The default 5 is about four minutes at
 * sandbox speed, so a hash shown on a job page would vanish before anyone looked it up; 2,000 keeps
 * a day or more.
 */
const GC_EPOCHS_TO_KEEP = 2_000;

export function localNodeConfig(env: NodeJS.ProcessEnv, repoRoot: string): LocalNodeConfig {
  return {
    home: env.NEAR_SANDBOX_HOME || join(repoRoot, '.near-sandbox'),
    rpcPort: Number(env.NEAR_RPC_PORT || DEFAULT_RPC_PORT),
    netPort: Number(env.NEAR_NET_PORT || DEFAULT_NET_PORT),
  };
}

export const localRpcUrl = (cfg: LocalNodeConfig): string => `http://127.0.0.1:${cfg.rpcPort}`;

/** The sandbox binary, downloaded by the near-sandbox package on first use. */
export async function sandboxBinary(): Promise<string> {
  if (process.env.NEAR_SANDBOX_BIN_PATH) return process.env.NEAR_SANDBOX_BIN_PATH;
  // The package doesn't export package.json; its entry lives in dist/<format>/ under the package root.
  const pkg = join(dirname(createRequire(import.meta.url).resolve('near-sandbox')), '..', '..');
  const bin = join(pkg, 'bin', `near-sandbox-${SANDBOX_VERSION}`, 'near-sandbox');
  if (!existsSync(bin)) {
    // Starting a throwaway sandbox makes the package download its binary.
    const sandbox = await Sandbox.start({ version: SANDBOX_VERSION });
    await sandbox.tearDown();
  }
  return bin;
}

/** Creates the node's home on first run and applies Hustle's settings (ports, fast blocks). */
export async function prepareHome(cfg: LocalNodeConfig): Promise<string> {
  const bin = await sandboxBinary();
  const configPath = join(cfg.home, 'config.json');
  if (!existsSync(configPath)) {
    const init = spawnSync(bin, ['--home', cfg.home, 'init'], { stdio: 'ignore' });
    if (init.status !== 0) throw new Error('near-sandbox init failed');
  }
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
    consensus: Record<string, unknown>;
    rpc: { addr: string };
    network: { addr: string };
    gc_blocks_limit: number;
    gc_num_epochs_to_keep: number;
  };
  config.consensus.min_block_production_delay = { secs: 0, nanos: BLOCK_DELAY_MIN_NS };
  config.consensus.max_block_production_delay = { secs: 0, nanos: BLOCK_DELAY_MAX_NS };
  config.consensus.min_num_peers = 0;
  config.gc_blocks_limit = GC_BLOCKS_LIMIT;
  config.gc_num_epochs_to_keep = GC_EPOCHS_TO_KEEP;
  config.rpc.addr = `127.0.0.1:${cfg.rpcPort}`;
  config.network.addr = `127.0.0.1:${cfg.netPort}`;
  writeFileSync(configPath, JSON.stringify(config, null, 1));
  return bin;
}

/** Runs the node in the foreground (for `pnpm dev`); its logs go to `node.log` in the home. */
export async function runLocalNode(cfg: LocalNodeConfig): Promise<ChildProcess> {
  const bin = await prepareHome(cfg);
  const { openSync } = await import('node:fs');
  const log = openSync(join(cfg.home, 'node.log'), 'a');
  return spawn(bin, ['--home', cfg.home, 'run'], { stdio: ['ignore', log, log] });
}

export async function rpcStatus(
  rpcUrl: string,
): Promise<{ genesisHash: string; height: number } | null> {
  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'status', method: 'status', params: [] }),
      signal: AbortSignal.timeout(2_000),
    });
    const body = (await res.json()) as {
      result?: { genesis_hash: string; sync_info: { latest_block_height: number } };
    };
    if (!body.result) return null;
    return {
      genesisHash: body.result.genesis_hash,
      height: body.result.sync_info.latest_block_height,
    };
  } catch {
    return null;
  }
}

/** Waits for the node to answer, so the API can start alongside it. */
export async function waitForNode(
  rpcUrl: string,
  timeoutMs: number,
): Promise<{ genesisHash: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await rpcStatus(rpcUrl);
    if (status && status.height > 1) return status;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `No NEAR node at ${rpcUrl}. Start it with \`pnpm dev\` (or \`pnpm --filter @hustle/chain dev\`), or set CHAIN_MODE=sim.`,
  );
}

/** The genesis account that funds everything on a sandbox (`test.near`), from the node's home. */
export function readFunder(cfg: LocalNodeConfig): { funderId: string; funderKey: KeyPairString } {
  const key = JSON.parse(readFileSync(join(cfg.home, 'validator_key.json'), 'utf8')) as {
    account_id: string;
    secret_key: KeyPairString;
  };
  return { funderId: key.account_id, funderKey: key.secret_key };
}
