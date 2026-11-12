import { inspect } from 'node:util';
import { KeyPair } from 'near-api-js';
import { describe, expect, it } from 'vitest';
import {
  checkAffordable,
  checkChainId,
  checkRpcUrl,
  estimateCost,
  freeBalance,
  readTestnetTarget,
  TestnetRefusal,
} from '../src/testnet.ts';

const KEY = KeyPair.fromRandom('ed25519').toString();
const NEAR = 10n ** 24n;
const live = { dryRunLocal: false };
const dryRun = { dryRunLocal: true };

const env = (over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({
  NEAR_TESTNET_ACCOUNT_ID: 'hustle-demo.testnet',
  NEAR_TESTNET_PRIVATE_KEY: KEY,
  ...over,
});

/** Runs `fn` and returns the refusal's message, failing if nothing was refused. */
function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(TestnetRefusal);
    return (err as Error).message;
  }
  throw new Error('expected a refusal');
}

describe('testnet target', () => {
  it('accepts a .testnet account and defaults to a public testnet RPC', () => {
    const target = readTestnetTarget(env(), live);
    expect(target.accountId).toBe('hustle-demo.testnet');
    expect(target.rpcUrl).toBe('https://test.rpc.fastnear.com');
    expect(target.key.reveal()).toBe(KEY);
  });

  it('refuses an account id that does not end in .testnet', () => {
    expect(
      refusal(() => readTestnetTarget(env({ NEAR_TESTNET_ACCOUNT_ID: 'alice.near' }), live)),
    ).toMatch(/mainnet account/);
    expect(
      refusal(() => readTestnetTarget(env({ NEAR_TESTNET_ACCOUNT_ID: 'test.near' }), live)),
    ).toMatch(/mainnet account/);
    expect(
      refusal(() => readTestnetTarget(env({ NEAR_TESTNET_ACCOUNT_ID: 'a'.repeat(64) }), live)),
    ).toMatch(/must end in \.testnet/);
    expect(
      refusal(() => readTestnetTarget(env({ NEAR_TESTNET_ACCOUNT_ID: 'testnet.evil' }), live)),
    ).toMatch(/must end in \.testnet/);
  });

  it('refuses the bare testnet registrar and malformed ids', () => {
    expect(
      refusal(() => readTestnetTarget(env({ NEAR_TESTNET_ACCOUNT_ID: 'testnet' }), live)),
    ).toMatch(/must end in \.testnet/);
    expect(
      refusal(() => readTestnetTarget(env({ NEAR_TESTNET_ACCOUNT_ID: 'Bad.testnet' }), live)),
    ).toMatch(/not a valid/);
    expect(
      refusal(() => readTestnetTarget(env({ NEAR_TESTNET_ACCOUNT_ID: '.testnet' }), live)),
    ).toMatch(/not a valid/);
  });

  it('allows a sandbox account only in a dry run against this machine', () => {
    const local = {
      NEAR_TESTNET_ACCOUNT_ID: 'deployer.test.near',
      NEAR_RPC_URL: 'http://127.0.0.1:3390',
    };
    expect(readTestnetTarget(env(local), dryRun).accountId).toBe('deployer.test.near');
    expect(refusal(() => readTestnetTarget(env(local), live))).toMatch(/mainnet account/);
  });

  it('refuses mainnet RPCs and NEAR_ENV=mainnet in every mode', () => {
    for (const url of [
      'https://rpc.mainnet.near.org',
      'https://free.rpc.fastnear.com/mainnet',
      'https://rpc.testnet.near.org/?network=MAINNET',
    ]) {
      expect(refusal(() => readTestnetTarget(env({ NEAR_RPC_URL: url }), live))).toMatch(/mainnet/);
    }
    expect(refusal(() => readTestnetTarget(env({ NEAR_ENV: 'mainnet' }), live))).toMatch(/mainnet/);
    expect(
      refusal(() =>
        readTestnetTarget(
          env({
            NEAR_TESTNET_ACCOUNT_ID: 'x.test.near',
            NEAR_RPC_URL: 'http://localhost:1/mainnet',
          }),
          dryRun,
        ),
      ),
    ).toMatch(/mainnet/);
  });

  it('accepts only https testnet RPC hosts outside a dry run', () => {
    expect(() => checkRpcUrl('https://rpc.testnet.near.org', live)).not.toThrow();
    expect(() => checkRpcUrl('https://near-testnet.drpc.org', live)).not.toThrow();
    expect(() => checkRpcUrl('https://test.rpc.fastnear.com', live)).not.toThrow();
    expect(refusal(() => checkRpcUrl('http://rpc.testnet.near.org', live))).toMatch(/https/);
    expect(refusal(() => checkRpcUrl('https://free.rpc.fastnear.com', live))).toMatch(
      /not a testnet/,
    );
    expect(refusal(() => checkRpcUrl('https://testnetfake.example.com', live))).toMatch(
      /not a testnet/,
    );
    expect(refusal(() => checkRpcUrl('http://127.0.0.1:3390', live))).toMatch(/https/);
    expect(refusal(() => checkRpcUrl('https://u:p@rpc.testnet.near.org', live))).toMatch(
      /credentials/,
    );
  });

  it('lets a dry run reach only a node on this machine', () => {
    expect(() => checkRpcUrl('http://127.0.0.1:3390', dryRun)).not.toThrow();
    expect(() => checkRpcUrl('http://localhost:3390', dryRun)).not.toThrow();
    expect(refusal(() => checkRpcUrl('https://rpc.testnet.near.org', dryRun))).toMatch(
      /this machine/,
    );
    expect(
      refusal(() =>
        readTestnetTarget(
          env({ NEAR_TESTNET_ACCOUNT_ID: 'x.test.near', NEAR_RPC_URL: '' }),
          dryRun,
        ),
      ),
    ).toMatch(/NEAR_RPC_URL/);
  });

  it('requires the node to report chain id testnet', () => {
    expect(() => checkChainId('testnet', live)).not.toThrow();
    expect(refusal(() => checkChainId('mainnet', live))).toMatch(/mainnet/);
    expect(refusal(() => checkChainId('localnet', live))).toMatch(/not testnet/);
    expect(() => checkChainId('localnet', dryRun)).not.toThrow();
    expect(refusal(() => checkChainId('testnet', dryRun))).toMatch(/local sandbox/);
    expect(refusal(() => checkChainId('mainnet', dryRun))).toMatch(/mainnet/);
  });
});

describe('private key handling', () => {
  it('never prints the key in logs, JSON or string output', () => {
    const target = readTestnetTarget(env(), live);
    const secretPart = KEY.slice('ed25519:'.length);
    for (const printed of [
      inspect(target, { depth: 5 }),
      JSON.stringify(target),
      String(target.key),
      `${target.key}`,
    ]) {
      expect(printed).not.toContain(secretPart);
      expect(printed).toContain('[redacted]');
    }
  });

  it('does not quote a malformed key in its error', () => {
    const bad = 'ed25519:not-a-real-key-0OIl';
    const message = refusal(() => readTestnetTarget(env({ NEAR_TESTNET_PRIVATE_KEY: bad }), live));
    expect(message).not.toContain('not-a-real-key');
    expect(message).toMatch(/not a NEAR private key/);
  });

  it('refuses a missing account or key', () => {
    expect(refusal(() => readTestnetTarget(env({ NEAR_TESTNET_ACCOUNT_ID: '' }), live))).toMatch(
      /NEAR_TESTNET_ACCOUNT_ID/,
    );
    expect(refusal(() => readTestnetTarget(env({ NEAR_TESTNET_PRIVATE_KEY: '' }), live))).toMatch(
      /NEAR_TESTNET_PRIVATE_KEY is not set/,
    );
  });
});

describe('deploy cost', () => {
  const plan = [
    { label: 'deploy credits', spend: 2n * NEAR, gas: 300n * 10n ** 12n },
    { label: 'create operator', spend: 25n * NEAR, gas: 5n * 10n ** 12n },
  ];

  it('adds funding, the most gas can cost, and a margin', () => {
    const cost = estimateCost(plan, 100_000_000n);
    expect(cost.spend).toBe(27n * NEAR);
    // 305 Tgas at 1e8 yocto per gas.
    expect(cost.gasFee).toBe(305n * 10n ** 12n * 100_000_000n);
    const base = cost.spend + cost.gasFee;
    expect(cost.required).toBe(base + (base * 20n + 99n) / 100n);
  });

  it('costs nothing when everything is already deployed', () => {
    expect(estimateCost([], 100_000_000n).required).toBe(0n);
  });

  it('refuses to start when the account cannot cover the estimate', () => {
    const cost = estimateCost(plan, 100_000_000n);
    expect(refusal(() => checkAffordable('a.testnet', cost.required - 1n, cost))).toMatch(
      /needs .* NEAR/,
    );
    expect(() => checkAffordable('a.testnet', cost.required, cost)).not.toThrow();
  });

  it('does not count storage-locked NEAR as free', () => {
    expect(freeBalance({ amount: 5n * NEAR, storage_usage: 100_000 })).toBe(4n * NEAR);
    expect(freeBalance({ amount: 0n, storage_usage: 100 })).toBe(0n);
  });
});
