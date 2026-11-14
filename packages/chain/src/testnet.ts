import { inspect } from 'node:util';
import { JsonRpcProvider, KeyPair, type KeyPairString, yoctoToNear } from 'near-api-js';
import type { PlannedStep } from './near.ts';

/**
 * Guards for running against NEAR testnet (`pnpm deploy:testnet`, `CHAIN_MODE=testnet`). Mainnet is
 * refused in every form: the account must end in `.testnet`, the RPC URL must be a testnet RPC, and
 * the node behind it must report chain id `testnet`. A dry run may target a local sandbox node
 * instead, and only one on this machine.
 */

/** The deploy command reads balances and the gas price through the same client as the gateway. */
export { JsonRpcProvider };

/** The default testnet RPC (FastNEAR's public endpoint, listed on docs.near.org, 2026-11-11). */
export const DEFAULT_TESTNET_RPC_URL = 'https://test.rpc.fastnear.com';

/** Public testnet RPC hosts whose names don't say "testnet". */
const KNOWN_TESTNET_HOSTS = new Set(['test.rpc.fastnear.com']);

/**
 * Public testnet RPCs that take over while the main one rate-limits, fastest first (the provider
 * prefers whichever would answer soonest, so the slow ones take only overflow). Measured on
 * 2026-11-14 at 4 view calls a second for 20 s: dRPC and FastNEAR answered all 80 in ~200 ms;
 * Intear answered all 80 in ~1.3 s (it slows requests without an API key); rpc.testnet.near.org
 * refused 36 with 429 and took ~3 s for the rest. Lava's testnet endpoints are discontinued.
 */
export const DEFAULT_TESTNET_FALLBACK_RPCS = [
  'https://near-testnet.drpc.org',
  'https://test.rpc.fastnear.com',
  'https://testnet-rpc.intea.rs',
  'https://rpc.testnet.near.org',
];
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** NEAR account id rules (nearcore's validation): 2–64 chars of lowercase parts joined by `.`. */
const ACCOUNT_ID = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const MAX_ACCOUNT_ID = 64;

/**
 * Head room on top of the estimate: unused gas is refunded but must be prepaid, and NEAR's gas price
 * can rise between the estimate and the send.
 */
const MARGIN_PERCENT = 20n;
const MARGIN_MIN = 10n ** 24n;

/** A private key that prints as `[redacted]` in logs, JSON and `console.log`. */
export class SecretKey {
  readonly #value: KeyPairString;
  constructor(value: KeyPairString) {
    this.#value = value;
  }
  reveal(): KeyPairString {
    return this.#value;
  }
  toString(): string {
    return '[redacted]';
  }
  toJSON(): string {
    return '[redacted]';
  }
  [inspect.custom](): string {
    return '[redacted]';
  }
}

export interface TestnetTarget {
  /** The root account: contracts go to `credits.<root>`, `agents.<root>` and so on. */
  accountId: string;
  key: SecretKey;
  rpcUrl: string;
  /** A rehearsal against a local sandbox node (`--dry-run-local`). */
  dryRunLocal: boolean;
}

export class TestnetRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TestnetRefusal';
  }
}

/**
 * Reads the root account, its key and the RPC URL from the environment and refuses anything that
 * could reach mainnet. Error messages never include the key.
 */
export function readTestnetTarget(
  env: NodeJS.ProcessEnv,
  opts: { dryRunLocal: boolean },
): TestnetTarget {
  if ((env.NEAR_ENV ?? '').toLowerCase() === 'mainnet') {
    throw new TestnetRefusal('NEAR_ENV is mainnet: Hustle never deploys to or plays on mainnet');
  }
  const accountId = (env.NEAR_TESTNET_ACCOUNT_ID ?? '').trim();
  if (!accountId) throw new TestnetRefusal('NEAR_TESTNET_ACCOUNT_ID is not set (see .env.example)');
  checkAccountId(accountId, opts);
  const rawKey = (env.NEAR_TESTNET_PRIVATE_KEY ?? '').trim();
  if (!rawKey) throw new TestnetRefusal('NEAR_TESTNET_PRIVATE_KEY is not set (see .env.example)');
  const key = parseKey(rawKey);
  const rpcUrl =
    (env.NEAR_RPC_URL ?? '').trim() || (opts.dryRunLocal ? '' : DEFAULT_TESTNET_RPC_URL);
  if (!rpcUrl) throw new TestnetRefusal('A dry run needs NEAR_RPC_URL pointing at the local node');
  checkRpcUrl(rpcUrl, opts);
  return { accountId, key, rpcUrl, dryRunLocal: opts.dryRunLocal };
}

export function checkAccountId(accountId: string, opts: { dryRunLocal: boolean }): void {
  if (accountId.length < 2 || accountId.length > MAX_ACCOUNT_ID || !ACCOUNT_ID.test(accountId)) {
    throw new TestnetRefusal(`${accountId} is not a valid NEAR account id`);
  }
  // A local sandbox names its accounts `*.near` (its genesis account is `test.near`); only a dry
  // run, whose RPC must be on this machine, may use them.
  if (opts.dryRunLocal) return;
  if (!accountId.endsWith('.testnet')) {
    throw new TestnetRefusal(
      accountId.endsWith('.near')
        ? `${accountId} is a mainnet account: Hustle only deploys to testnet accounts (*.testnet)`
        : `${accountId} is not a testnet account: it must end in .testnet`,
    );
  }
}

function parseKey(raw: string): SecretKey {
  try {
    KeyPair.fromString(raw as KeyPairString);
  } catch {
    // The parser's own message may quote its input, so it is not passed on.
    throw new TestnetRefusal(
      'NEAR_TESTNET_PRIVATE_KEY is not a NEAR private key (expected ed25519:<base58>)',
    );
  }
  return new SecretKey(raw as KeyPairString);
}

export function checkRpcUrl(rpcUrl: string, opts: { dryRunLocal: boolean }): void {
  let url: URL;
  try {
    url = new URL(rpcUrl);
  } catch {
    throw new TestnetRefusal(`NEAR_RPC_URL is not a URL: ${rpcUrl}`);
  }
  if (url.username || url.password) {
    throw new TestnetRefusal('NEAR_RPC_URL must not carry credentials');
  }
  if (/mainnet/i.test(rpcUrl)) {
    throw new TestnetRefusal(`${url.host} looks like a mainnet RPC: Hustle never uses mainnet`);
  }
  const host = url.hostname.toLowerCase();
  if (opts.dryRunLocal) {
    if (!LOOPBACK_HOSTS.has(host)) {
      throw new TestnetRefusal(`A dry run only targets a node on this machine, not ${url.host}`);
    }
    return;
  }
  if (url.protocol !== 'https:') {
    throw new TestnetRefusal(`NEAR_RPC_URL must use https on testnet: ${url.host}`);
  }
  if (!KNOWN_TESTNET_HOSTS.has(host) && !host.split(/[.-]/).includes('testnet')) {
    throw new TestnetRefusal(`${url.host} is not a testnet RPC`);
  }
}

/** The chain id the node reports must be `testnet` (or, for a dry run, a local sandbox's). */
export function checkChainId(chainId: string, opts: { dryRunLocal: boolean }): void {
  if (chainId === 'mainnet') {
    throw new TestnetRefusal('The RPC serves mainnet: Hustle never deploys to or plays on mainnet');
  }
  if (opts.dryRunLocal) {
    if (chainId === 'testnet') {
      throw new TestnetRefusal('A dry run must target a local sandbox node, not testnet');
    }
    return;
  }
  if (chainId !== 'testnet') {
    throw new TestnetRefusal(`The RPC serves chain "${chainId}", not testnet`);
  }
}

/** Asks the node which chain it serves and refuses the wrong one. */
export async function verifyChain(
  target: TestnetTarget,
): Promise<{ chainId: string; genesisHash: string }> {
  const status = await new JsonRpcProvider({ url: target.rpcUrl }).viewNodeStatus();
  checkChainId(status.chain_id, target);
  return { chainId: status.chain_id, genesisHash: status.genesis_hash };
}

export interface CostEstimate {
  /** NEAR moved into new accounts and deposits. */
  spend: bigint;
  /** The most the transactions' gas can cost at the current price. */
  gasFee: bigint;
  /** What the root must hold free: spend, gas and a margin. */
  required: bigint;
}

export function estimateCost(planned: readonly PlannedStep[], gasPrice: bigint): CostEstimate {
  const spend = planned.reduce((sum, s) => sum + s.spend, 0n);
  const gasFee = planned.reduce((sum, s) => sum + s.gas, 0n) * gasPrice;
  // Rounded up, so the margin never falls short of the percentage.
  const percent = ((spend + gasFee) * MARGIN_PERCENT + 99n) / 100n;
  let margin = percent;
  if (margin < MARGIN_MIN) margin = MARGIN_MIN;
  return {
    spend,
    gasFee,
    required: planned.length === 0 ? 0n : spend + gasFee + margin,
  };
}

/** Refuses to start a deploy the account can't finish. `available` excludes storage-locked NEAR. */
export function checkAffordable(accountId: string, available: bigint, cost: CostEstimate): void {
  if (available < cost.required) {
    throw new TestnetRefusal(
      `${accountId} has ${formatNear(available)} NEAR free; this deploy needs ${formatNear(cost.required)} NEAR. Add ${formatNear(cost.required - available)} NEAR and run it again.`,
    );
  }
}

/** NEAR an account can spend: its balance less what its storage locks (1e19 yocto per byte). */
export function freeBalance(account: { amount: bigint; storage_usage: number }): bigint {
  const locked = BigInt(account.storage_usage) * 10n ** 19n;
  return account.amount > locked ? account.amount - locked : 0n;
}

export function formatNear(yocto: bigint): string {
  return yoctoToNear(yocto, 3);
}
