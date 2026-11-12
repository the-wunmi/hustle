import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chainConformance, DAY_MS } from '../src/conformance.ts';
import { NearChain } from '../src/near.ts';
import {
  blockTimeMs,
  fastForward,
  type SandboxNode,
  startSandboxNode,
} from '../src/sandbox-node.ts';

/**
 * The conformance suite against the compiled contracts on a local sandbox node. Opt-in
 * (`NEAR_SANDBOX_TESTS=1`, or `pnpm test:chain`): it starts a node, may download its binary and
 * needs the wasm from `scripts/build-contracts.sh`, so plain `pnpm test` stays fast and offline.
 */
const enabled = process.env.NEAR_SANDBOX_TESTS === '1';
const unique = (prefix: string) => `${prefix}${randomBytes(4).toString('hex')}`;

/**
 * Each scenario must not straddle a spending-day boundary, or a cap check could reset mid-scenario.
 * The simulator's clock stands still; block time doesn't, so each scenario starts at least this far
 * from the next boundary. A scenario takes well under a minute of block time.
 */
const DAY_MARGIN_MS = 90_000;

if (enabled) {
  let node: SandboxNode;
  let chain: NearChain;

  beforeAll(async () => {
    node = await startSandboxNode();
    chain = new NearChain({
      rpcUrl: node.rpcUrl,
      root: `hustle.${node.funderId}`,
      funderId: node.funderId,
      funderKey: node.funderKey,
    });
  }, 120_000);
  // Teardown stops the node and deletes its data directory, which can take minutes on a busy machine.
  afterAll(async () => {
    await node?.stop();
  }, 600_000);

  chainConformance('NearChain (sandbox)', async () => {
    const intoDay = (await blockTimeMs(node.rpcUrl)) % DAY_MS;
    if (DAY_MS - intoDay < DAY_MARGIN_MS) await fastForward(node.rpcUrl, DAY_MS - intoDay);
    return { gateway: chain, advance: (ms) => fastForward(node.rpcUrl, ms) };
  });

  describe('NearChain (sandbox): calls left in doubt', () => {
    const faulty = (fault: 'beforeBroadcast' | 'afterBroadcast') => {
      let armed = true;
      return new NearChain({
        rpcUrl: node.rpcUrl,
        root: `hustle.${node.funderId}`,
        funderId: node.funderId,
        funderKey: node.funderKey,
        faults: {
          [fault]: (method: string) => {
            if (method !== 'ft_transfer' || !armed) return false;
            armed = false;
            return true;
          },
        },
      });
    };
    const accounts = async () => {
      const owner = `${unique('d')}.${chain.ids.root}`;
      const payee = `${unique('d')}.${chain.ids.root}`;
      await chain.createAccount(owner);
      await chain.createAccount(payee);
      await chain.mintCredits(owner, 5_000_000n, unique('mint'));
      return { owner, payee };
    };

    it('an answer lost after broadcast is found on the node, and the retry sends nothing', async () => {
      const { owner, payee } = await accounts();
      const g = faulty('afterBroadcast');
      const key = unique('lost');
      await expect(g.ftTransfer(owner, payee, 1_000_000n, 'lost', key)).rejects.toThrow(
        'simulated lost answer',
      );
      expect(await chain.ftBalance(payee)).toBe(1_000_000n);
      const retry = await g.ftTransfer(owner, payee, 1_000_000n, 'lost', key);
      expect(retry.txHash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
      expect(await chain.ftBalance(payee)).toBe(1_000_000n);
    }, 120_000);

    it('a call that died before broadcast is sent as the same transaction, once', async () => {
      const { owner, payee } = await accounts();
      const g = faulty('beforeBroadcast');
      const key = unique('unsent');
      await expect(g.ftTransfer(owner, payee, 1_000_000n, 'unsent', key)).rejects.toThrow(
        'simulated crash before broadcast',
      );
      expect(await chain.ftBalance(payee)).toBe(0n);
      await g.ftTransfer(owner, payee, 1_000_000n, 'unsent', key);
      await g.ftTransfer(owner, payee, 1_000_000n, 'unsent', key);
      expect(await chain.ftBalance(payee)).toBe(1_000_000n);
    }, 120_000);
  });
} else {
  describe('NearChain (sandbox)', () => {
    it.skip('runs only with NEAR_SANDBOX_TESTS=1 (pnpm test:chain)', () => undefined);
  });
}
