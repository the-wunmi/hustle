import { randomUUID } from 'node:crypto';
import { usd } from '@hustle/core';
import { agents, jobs } from '@hustle/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mintAgent, ownedAgent, topUp, updateStrategy } from '../src/agents/manage.ts';
import { loadAgent } from '../src/agents/state.ts';
import { holderView, nftHistoryView } from '../src/nft.ts';
import { buyAgent, confirmRulebook, listAgent } from '../src/trade.ts';
import { type World, world } from './harness.ts';

let w: World;
let seq = 0;

beforeAll(async () => {
  w = await world('nft');
}, 60_000);
afterAll(async () => w.close());

async function holderWithAgent() {
  seq += 1;
  const owner = await w.signUp(`holder${seq}@example.com`, `Holder${seq}`);
  const agent = await mintAgent(w.engine, owner, {
    name: `Token${seq}`,
    look: { body: 'boxy', color: 'marigold' },
    traits: ['meticulous', 'frugal'],
    specialty: 'translation',
    tier: 'budget',
  });
  await w.engine.db.update(agents).set({ busyJobId: null }).where(eq(agents.id, agent.id));
  await w.engine.db
    .update(jobs)
    .set({ status: 'cancelled' })
    .where(eq(jobs.reservedForAgentId, agent.id));
  return { owner, agent: (await loadAgent(w.engine, agent.id))! };
}

describe('the agent NFT: holder page and history', () => {
  it('only the current holder, read from chain, opens the holder page; a seller is refused after the sale', async () => {
    const { owner, agent } = await holderWithAgent();
    const view = await holderView(w.engine, owner, agent);
    expect(view.chainOwner).toBe(owner.accountId);
    expect(view.wallet.rotationSeq).toBe(0);

    await listAgent(w.engine, owner, agent, { price: usd('1.00') });
    const buyer = await w.signUp(`buyer-nft${seq}@example.com`, `NftBuyer${seq}`);
    const bought = await buyAgent(w.engine, buyer, agent, {
      expectedPrice: usd('1.00'),
      requestId: `nft-sale-${seq}-1`,
    });

    await expect(holderView(w.engine, owner, bought)).rejects.toMatchObject({ code: 'forbidden' });
    const theirs = await holderView(w.engine, buyer, bought);
    expect(theirs.chainOwner).toBe(buyer.accountId);
    expect(theirs.wallet.frozen).toBe(true);
    expect(theirs.wallet.rotationSeq).toBe(1);
  });

  it('a transfer outside the game cuts the old owner off, and the game follows the chain', async () => {
    const { owner, agent } = await holderWithAgent();
    const other = await w.signUp(`receiver${seq}@example.com`, `Receiver${seq}`);
    // Straight on the registry, not through the game's marketplace.
    await w.engine.chain.nftTransfer(owner.accountId, agent.accountId!, other.accountId);

    await expect(ownedAgent(w.engine, owner, agent.id)).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(
      updateStrategy(w.engine, owner, agent, { priceStyle: 'premium' } as never),
    ).rejects.toBeTruthy();
    await expect(holderView(w.engine, owner, agent)).rejects.toMatchObject({ code: 'forbidden' });

    await holderView(w.engine, other, agent);
    const synced = (await loadAgent(w.engine, agent.id))!;
    expect(synced.ownerId).toBe(other.id);
    expect(synced.awaitingConfirm).toBe(true);
  });

  it('the history lists who held the NFT and what it earned and paid, each with its transaction', async () => {
    const { owner, agent } = await holderWithAgent();
    await topUp(w.engine, owner, agent, { amount: usd('0.50'), requestId: randomUUID() });
    await listAgent(w.engine, owner, agent, { price: usd('1.20') });
    const buyer = await w.signUp(`buyer-hist${seq}@example.com`, `HistBuyer${seq}`);
    const bought = await buyAgent(w.engine, buyer, agent, {
      expectedPrice: usd('1.20'),
      requestId: `nft-sale-${seq}-2`,
    });
    await confirmRulebook(w.engine, buyer, bought, {});
    // The new holder takes some money out: a payout of the NFT's wallet.
    await w.engine.chain.withdraw(buyer.accountId, agent.accountId!, usd('0.10'), `nftwd${seq}`);

    const history = await nftHistoryView(w.engine, (await loadAgent(w.engine, agent.id))!, null);
    expect(history.holders.map((h) => [h.how, h.accountId])).toEqual([
      ['minted', owner.accountId],
      ['sold', buyer.accountId],
    ]);
    expect(history.holders.every((h) => h.txHash.length > 0)).toBe(true);
    expect(history.earnings.map((e) => e.kind)).toEqual(
      expect.arrayContaining(['starting credits', 'top-up']),
    );
    const withdrawn = history.payouts.find((p) => p.kind === 'withdrawn by the holder');
    expect(withdrawn).toMatchObject({ amount: usd('0.10').toString() });
    expect(withdrawn?.counterparty).toBe(buyer.name);
    for (const entry of [...history.earnings, ...history.payouts])
      expect(entry.txHash).toBeTruthy();
  });
});
