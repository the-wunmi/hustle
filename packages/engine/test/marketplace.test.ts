import { bpsDown, usd } from '@hustle/core';
import { agentSales, agents, jobs, spends } from '@hustle/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mintAgent, updateRulebook } from '../src/agents/manage.ts';
import { loadAgent, rulebookOf } from '../src/agents/state.ts';
import type { PlayerRow } from '../src/players.ts';
import {
  buyAgent,
  cancelListing,
  confirmRulebook,
  fairValue,
  houseTrading,
  listAgent,
  MARKET_FEE_BPS,
  marketplaceView,
} from '../src/trade.ts';
import { tickRng } from '../src/world/market.ts';
import { type World, world } from './harness.ts';

let w: World;
let seq = 0;

beforeAll(async () => {
  w = await world('marketplace');
}, 60_000);
afterAll(async () => w.close());

async function seller() {
  seq += 1;
  const owner = await w.signUp(`seller${seq}@example.com`, `Sel${seq}`);
  const agent = await mintAgent(w.engine, owner, {
    name: `Ware${seq}`,
    look: { body: 'tall', color: 'grape' },
    traits: ['meticulous', 'skeptical'],
    specialty: 'research',
    tier: 'standard',
  });
  await w.engine.db.update(agents).set({ busyJobId: null }).where(eq(agents.id, agent.id));
  await w.engine.db
    .update(jobs)
    .set({ status: 'cancelled' })
    .where(eq(jobs.reservedForAgentId, agent.id));
  return { owner, agent: (await loadAgent(w.engine, agent.id))! };
}

async function buyer(): Promise<PlayerRow> {
  seq += 1;
  return w.signUp(`buyer${seq}@example.com`, `Buy${seq}`);
}

const balance = (account: string) => w.engine.chain.ftBalance(account);

describe('the agent marketplace', () => {
  it('a listing shows a buyer the agent’s record, read from chain, and a fair value', async () => {
    const { owner, agent } = await seller();
    await listAgent(w.engine, owner, agent, { price: usd('3.00') });
    const view = await marketplaceView(w.engine, await buyer());
    const listing = view.listings.find((l) => l.agent.id === agent.id);
    expect(listing).toMatchObject({ price: usd('3.00').toString(), isMine: false, blocked: null });
    expect(BigInt(listing!.record.walletBalance)).toBe(await balance(agent.accountId!));
    expect(listing!.record.specialty).toBe('research');
    expect(BigInt(listing!.fairValue)).toBe(await fairValue(w.engine, agent));
    expect(BigInt(listing!.fee)).toBe(bpsDown(usd('3.00'), MARKET_FEE_BPS));
  });

  it('a sale pays the seller less the fee, moves the agent, freezes its wallet and voids the old owner’s requests', async () => {
    const { owner, agent } = await seller();
    // The old owner leaves a payment held for approval; it must not survive the sale.
    const heldKey = `held-${seq}`;
    await w.engine.db.insert(spends).values({
      key: heldKey,
      agentId: agent.id,
      kind: 'tool',
      receiver: 'x',
      amount: usd('0.30'),
      status: 'pending',
      memo: 'held',
      day: 1,
    });
    await listAgent(w.engine, owner, agent, { price: usd('2.00') });
    const b = await buyer();
    const sellerBefore = await balance(owner.accountId);
    const buyerBefore = await balance(b.accountId);
    const treasuryBefore = await balance(w.engine.chain.ids.treasury);

    const bought = await buyAgent(w.engine, b, agent, {
      expectedPrice: usd('2.00'),
      requestId: `request-${seq}-a`,
    });
    const fee = bpsDown(usd('2.00'), MARKET_FEE_BPS);
    expect(await balance(owner.accountId)).toBe(sellerBefore + usd('2.00') - fee);
    expect(await balance(b.accountId)).toBe(buyerBefore - usd('2.00'));
    expect(await balance(w.engine.chain.ids.treasury)).toBe(treasuryBefore + fee);
    expect(await w.engine.chain.nftOwner(agent.accountId!)).toBe(b.accountId);
    expect(bought).toMatchObject({ ownerId: b.id, frozen: true, awaitingConfirm: true });
    expect((await w.engine.chain.getWallet(agent.accountId!)).frozen).toBe(true);
    const [held] = await w.engine.db.select().from(spends).where(eq(spends.key, heldKey));
    expect(held?.status).toBe('denied');

    // The old owner has no say any more; the new owner confirms and the agent goes back to work.
    await expect(updateRulebook(w.engine, owner, bought, rulebookOf(bought))).rejects.toBeTruthy();
    const confirmed = await confirmRulebook(w.engine, b, bought, {});
    expect(confirmed).toMatchObject({ frozen: false, awaitingConfirm: false });
    expect((await w.engine.chain.getWallet(agent.accountId!)).frozen).toBe(false);
  });

  it('a buy at a stale price is refunded in full: the seller raised the price', async () => {
    const { owner, agent } = await seller();
    await listAgent(w.engine, owner, agent, { price: usd('1.50') });
    await listAgent(w.engine, owner, agent, { price: usd('4.00') });
    const b = await buyer();
    const before = await balance(b.accountId);
    await expect(
      buyAgent(w.engine, b, agent, { expectedPrice: usd('1.50'), requestId: `request-${seq}-b` }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(await balance(b.accountId)).toBe(before);
    expect(await w.engine.chain.nftOwner(agent.accountId!)).toBe(owner.accountId);
  });

  it('a cancelled listing can’t be bought, and a busy agent can’t be listed', async () => {
    const { owner, agent } = await seller();
    await listAgent(w.engine, owner, agent, { price: usd('1.20') });
    await cancelListing(w.engine, owner, agent);
    const b = await buyer();
    await expect(
      buyAgent(w.engine, b, agent, { expectedPrice: usd('1.20'), requestId: `request-${seq}-c` }),
    ).rejects.toMatchObject({ code: 'conflict' });
    const [job] = await w.engine.db.select().from(jobs).limit(1);
    const busy = { ...agent, busyJobId: job!.id };
    await expect(listAgent(w.engine, owner, busy, { price: usd('1.20') })).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('a retried buy with the same request id records one sale', async () => {
    const { owner, agent } = await seller();
    await listAgent(w.engine, owner, agent, { price: usd('1.00') });
    const b = await buyer();
    const input = { expectedPrice: usd('1.00'), requestId: `request-${seq}-d` };
    await buyAgent(w.engine, b, agent, input);
    const after = await balance(b.accountId);
    await buyAgent(w.engine, b, (await loadAgent(w.engine, agent.id))!, input).catch(() => null);
    expect(await balance(b.accountId)).toBe(after);
    const sales = await w.engine.db
      .select()
      .from(agentSales)
      .where(eq(agentSales.agentId, agent.id));
    expect(sales).toHaveLength(1);
  });

  it('rivals list and buy, so the market has life', async () => {
    for (let turn = 0; turn < 6; turn++)
      await houseTrading(w.engine, tickRng(w.engine, `t${turn}`));
    const view = await marketplaceView(w.engine, null);
    expect(view.listings.length + view.recentSales.length).toBeGreaterThan(0);
    for (const l of view.listings)
      expect(BigInt(l.price)).toBeGreaterThanOrEqual(BigInt(l.fairValue) / 2n);
  });
});
