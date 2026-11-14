import { randomBytes } from 'node:crypto';
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner } from 'near-api-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chainConformance, DAY_MS } from '../src/conformance.ts';
import { accessKeyPermission } from '../src/keys.ts';
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

  describe('player account funding (testnet amounts, on the sandbox)', () => {
    it('a player account costs the root about 0.05 NEAR; a transfer it signs burns a little gas', async () => {
      // The same contracts, with testnet's sparing funding.
      const lean = new NearChain({
        rpcUrl: node.rpcUrl,
        root: `hustle.${node.funderId}`,
        funderId: node.funderId,
        funderKey: node.funderKey,
        network: 'testnet',
      });
      const provider = new JsonRpcProvider({ url: node.rpcUrl });
      const near = async (id: string) =>
        BigInt((await provider.viewAccount({ accountId: id })).amount);
      const root = lean.ids.root;
      const player = `p-${unique('')}.${root}`;
      const before = await near(root);
      await lean.createAccount(player);
      // Unused prepaid gas comes back a block or two later; read balances once it has.
      const settle = () => new Promise((r) => setTimeout(r, 3_000));
      await settle();
      const made = before - (await near(root));
      const start = await near(player);
      await lean.mintCredits(player, 5_000_000n, `mint:${player}`);
      for (let i = 0; i < 3; i++)
        await lean.ftTransfer(player, lean.ids.treasury, 100_000n, `t${i}`, `ft:${player}:${i}`);
      await settle();
      const gas = (start - (await near(player))) / 3n;
      // eslint-disable-next-line no-console
      console.log(
        `player account: root paid ${Number(made) / 1e24} NEAR; each player-signed transfer ${Number(gas) / 1e24} NEAR`,
      );
      expect(start).toBe(5n * 10n ** 22n);
      expect(made).toBeLessThan(6n * 10n ** 22n);
      expect(gas).toBeLessThan(10n ** 21n);
    }, 120_000);
  });

  describe('refills are capped per signer per day (testnet amounts, on the sandbox)', () => {
    it('a player who keeps spending gas is refilled at most up to the daily cap', async () => {
      const lean = new NearChain({
        rpcUrl: node.rpcUrl,
        root: `hustle.${node.funderId}`,
        funderId: node.funderId,
        funderKey: node.funderKey,
        network: 'testnet',
        // Two refills of 0.03 a day.
        refillCapPerDay: 6n * 10n ** 22n,
      });
      const provider = new JsonRpcProvider({ url: node.rpcUrl });
      const player = `p-${unique('')}.${lean.ids.root}`;
      await lean.createAccount(player);
      await lean.mintCredits(player, 5_000_000n, `mint:${player}`);
      // Spend the player's NEAR down below the refill line, as a looping script's gas would.
      const drain = async () => {
        const { amount } = await provider.viewAccount({ accountId: player });
        const keep = 2n * 10n ** 22n;
        if (BigInt(amount) > keep)
          await new Account(player, provider, KeyPairSigner.fromSecretKey(node.funderKey)).transfer(
            {
              receiverId: lean.ids.root,
              amount: BigInt(amount) - keep,
            },
          );
      };
      for (let i = 0; i < 3; i++) {
        await drain();
        await lean
          .ftTransfer(player, lean.ids.treasury, 1n, `loop${i}`, `loop:${player}:${i}`)
          .catch(() => undefined);
      }
      expect(await lean.refillsToday(player)).toBe(2);
    }, 180_000);
  });

  describe('house signers on the local node', () => {
    it('a drained house signer is topped up from the root, and its call goes through', async () => {
      const provider = new JsonRpcProvider({ url: node.rpcUrl });
      const house = `clients${unique('')}.${chain.ids.root}`;
      await chain.createAccount(house);
      await chain.mintCredits(house, 5_000_000n, `mint:${house}`);
      // Spend its NEAR down to almost nothing, as days of job posts would.
      const { amount } = await provider.viewAccount({ accountId: house });
      const keep = 10n ** 22n;
      await new Account(house, provider, KeyPairSigner.fromSecretKey(node.funderKey)).transfer({
        receiverId: chain.ids.root,
        amount: BigInt(amount) - keep,
      });
      await chain.ftTransfer(house, chain.ids.treasury, 1n, 'after drain', `drain:${house}`);
      const after = BigInt((await provider.viewAccount({ accountId: house })).amount);
      expect(after).toBeGreaterThan(2n * 10n ** 24n);
    }, 120_000);
  });

  describe('the operator on the local node', () => {
    it('a drained operator is topped up from the root, and its call goes through', async () => {
      const provider = new JsonRpcProvider({ url: node.rpcUrl });
      const op = chain.ids.operator;
      // The operator holds no credits in the game; register it so it can sign one transfer.
      await new Account(op, provider, KeyPairSigner.fromSecretKey(node.funderKey)).callFunction({
        contractId: chain.ids.credits,
        methodName: 'storage_deposit',
        args: { account_id: op, registration_only: true },
        deposit: 10n ** 22n,
      });
      await chain.mintCredits(op, 10n, `opmint:${unique('')}`);
      const { amount } = await provider.viewAccount({ accountId: op });
      const keep = 10n ** 22n;
      await new Account(op, provider, KeyPairSigner.fromSecretKey(node.funderKey)).transfer({
        receiverId: chain.ids.root,
        amount: BigInt(amount) - keep,
      });
      await chain.ftTransfer(op, chain.ids.treasury, 1n, 'after drain', `opdrain:${unique('')}`);
      const after = BigInt((await provider.viewAccount({ accountId: op })).amount);
      expect(after).toBeGreaterThan(100n * 10n ** 24n);
    }, 120_000);
  });

  describe('wallet sign-in key lookup (sandbox)', () => {
    it('reads a full-access key from the node; an unknown key or account is null', async () => {
      const provider = new JsonRpcProvider({ url: node.rpcUrl });
      const key = KeyPair.fromString(node.funderKey).getPublicKey().toString();
      expect(await accessKeyPermission(provider, node.funderId, key)).toBe('full');
      const stranger = KeyPair.fromRandom('ed25519').getPublicKey().toString();
      expect(await accessKeyPermission(provider, node.funderId, stranger)).toBeNull();
      expect(
        await accessKeyPermission(provider, `nobody${unique('x')}.${node.funderId}`, key),
      ).toBeNull();
    }, 60_000);
  });
} else {
  describe('NearChain (sandbox)', () => {
    it.skip('runs only with NEAR_SANDBOX_TESTS=1 (pnpm test:chain)', () => undefined);
  });
}
