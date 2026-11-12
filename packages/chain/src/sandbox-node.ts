import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { KeyPairString } from 'near-api-js';
import { Sandbox } from 'near-sandbox';

/** A local NEAR node (nearcore's sandbox build) started for tests or local play. */
export interface SandboxNode {
  rpcUrl: string;
  /** The genesis account that funds everything (`test.near`, as in near-workspaces). */
  funderId: string;
  funderKey: KeyPairString;
  /** Stops the node and deletes its data directory. */
  stop(): Promise<void>;
}

interface ValidatorKeyFile {
  account_id: string;
  secret_key: KeyPairString;
}

/**
 * Starts a sandbox node on a free port the package picks and locks. The binary is downloaded into
 * node_modules on first use; set `NEAR_SANDBOX_BIN_PATH` to reuse one (for example the copy
 * near-workspaces fetched for `cargo test`).
 */
export async function startSandboxNode(): Promise<SandboxNode> {
  const sandbox = await Sandbox.start({});
  // The validator key belongs to `test.near`, a genesis account holding most of the supply.
  const key = JSON.parse(
    await readFile(join(sandbox.homeDir, 'validator_key.json'), 'utf8'),
  ) as ValidatorKeyFile;
  return {
    rpcUrl: sandbox.rpcUrl,
    funderId: key.account_id,
    funderKey: key.secret_key,
    stop: () => sandbox.tearDown(),
  };
}

interface RpcReply<T> {
  result?: T;
  error?: unknown;
}

async function rpc<T>(rpcUrl: string, method: string, params: unknown): Promise<T> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'hustle', method, params }),
  });
  const reply = (await res.json()) as RpcReply<T>;
  if (reply.error !== undefined || reply.result === undefined) {
    throw new Error(`${method} failed: ${JSON.stringify(reply.error)}`);
  }
  return reply.result;
}

/** Timestamp of the latest optimistic block, in milliseconds. */
export async function blockTimeMs(rpcUrl: string): Promise<number> {
  const block = await rpc<{ header: { timestamp_nanosec: string } }>(rpcUrl, 'block', {
    finality: 'optimistic',
  });
  return Number(BigInt(block.header.timestamp_nanosec) / 1_000_000n);
}

/**
 * Moves block time forward by at least `ms`. `sandbox_fast_forward` skips a number of blocks, not
 * milliseconds, and how much time a skipped block adds is a node detail, so this measures and
 * repeats until the clock has really moved.
 */
export async function fastForward(rpcUrl: string, ms: number): Promise<void> {
  const target = (await blockTimeMs(rpcUrl)) + ms;
  // A first guess at the time one skipped block adds; corrected from what each jump really did.
  let msPerBlock = 250;
  for (let now = await blockTimeMs(rpcUrl); now < target; ) {
    const blocks = Math.max(1, Math.ceil((target - now) / msPerBlock));
    await rpc(rpcUrl, 'sandbox_fast_forward', { delta_height: blocks });
    const after = await blockTimeMs(rpcUrl);
    if (after > now) msPerBlock = Math.max(1, (after - now) / blocks);
    now = after;
  }
}
