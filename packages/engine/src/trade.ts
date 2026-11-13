/**
 * The agent marketplace: owners list agents for sale, others buy them. The listing lives on chain
 * (the registry approves the market contract with the price); a buy is one credits transfer to the
 * market, which moves the NFT and pays the seller minus the treasury's fee, or refunds the buyer
 * whole. Any change of owner freezes the agent wallet until the new owner confirms its rulebook.
 */

import {
  bpsDown,
  CATEGORIES,
  type Category,
  DomainError,
  formatUsd,
  type ListingView,
  type MarketplaceView,
  MicroAmount,
  maxBig,
  parseInput,
  type Rng,
  type SaleView,
  type Tier,
  type Trait,
} from '@hustle/core';
import { agentSales, agents, calls, players, spends, type Tx } from '@hustle/db';
import {
  type AgentRecord,
  agentValue,
  MAX_LISTING_PRICE,
  MIN_LISTING_PRICE,
  ROYALTY_BPS,
} from '@hustle/economy';
import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  chainDomainError,
  MAX_AGENTS_PER_PLAYER,
  RulebookInput,
  updateRulebook,
} from './agents/manage.ts';
import { type AgentRow, levelOf, skillsOf, strategyOf, traitsOf } from './agents/state.ts';
import { dayOf, type Engine } from './context.ts';
import {
  chainCall,
  crashPoint,
  DBOS,
  durableEngine,
  inTx,
  readStep,
  runOnce,
  wfId,
  workflowExists,
} from './durable.ts';
import type { PlayerRow } from './players.ts';
import { ensurePlayerAccount } from './players.ts';
import { book, chainKey, post } from './record.ts';
import { summariesOf } from './views.ts';

/** The treasury's cut of each sale, in basis points (the market contract is set up with it). */
export const MARKET_FEE_BPS = 250;

export const ListAgent = z.object({
  price: MicroAmount.refine(
    (p) => p >= MIN_LISTING_PRICE && p <= MAX_LISTING_PRICE,
    `A price between ${formatUsd(MIN_LISTING_PRICE)} and ${formatUsd(MAX_LISTING_PRICE)}`,
  ),
});

export const BuyAgent = z.object({
  /** The price the buyer saw: if the seller changed it since, the market refunds the buyer. */
  expectedPrice: MicroAmount,
  /** Chosen by the browser per click, so a double click or a retry buys once. */
  requestId: z.string().min(8).max(64),
});

export const ConfirmRulebook = z.object({ rulebook: RulebookInput.optional() });

const cents = (v: bigint) => (v / 10_000n) * 10_000n;

// ── Listing ─────────────────────────────────────────────────────────────────────────────────────

export async function listAgent(
  engine: Engine,
  player: PlayerRow,
  agent: AgentRow,
  input: z.input<typeof ListAgent>,
): Promise<void> {
  const { price } = parseInput(ListAgent, input);
  if (!agent.accountId) throw new DomainError('conflict', 'Agent is still being minted');
  if (agent.busyJobId)
    throw new DomainError('conflict', `${agent.name} is on a job. List it once the job is done.`);
  // Listed already at this price: nothing to sign.
  const current = await engine.chain.getListing(agent.accountId);
  if (current && current.price === cents(price)) return;
  try {
    await engine.chain.listAgent(player.accountId, agent.accountId, cents(price));
  } catch (err) {
    throw chainDomainError(err);
  }
  await post(engine, {
    kind: 'transfer',
    tone: 'neutral',
    text: `${player.name} listed ${agent.name} for ${formatUsd(cents(price))} on the marketplace.`,
    agentId: agent.id,
    amount: cents(price),
  });
}

export async function cancelListing(
  engine: Engine,
  player: PlayerRow,
  agent: AgentRow,
): Promise<void> {
  if (!agent.accountId) throw new DomainError('conflict', 'Agent is still being minted');
  const listing = await engine.chain.getListing(agent.accountId);
  if (!listing) throw new DomainError('not_found', `${agent.name} isn't listed`);
  try {
    await engine.chain.cancelListing(player.accountId, agent.accountId);
  } catch (err) {
    throw chainDomainError(err);
  }
  await post(engine, {
    kind: 'transfer',
    tone: 'neutral',
    text: `${player.name} took ${agent.name} off the marketplace.`,
    agentId: agent.id,
    playerId: player.id,
    scope: 'owner',
  });
}

// ── Buying ──────────────────────────────────────────────────────────────────────────────────────

/** Why this player can't buy this agent right now, or null if they can. */
async function buyBlocked(
  engine: Engine,
  buyer: PlayerRow,
  agent: AgentRow,
  price: bigint,
): Promise<string | null> {
  if (agent.ownerId === buyer.id) return 'It is yours';
  if (agent.busyJobId) return `${agent.name} is finishing a job; it can be bought once it's done`;
  const [owned] = await engine.db
    .select({ n: sql<number>`count(*)::int` })
    .from(agents)
    .where(and(eq(agents.ownerId, buyer.id), isNotNull(agents.accountId)));
  if ((owned?.n ?? 0) >= MAX_AGENTS_PER_PLAYER)
    return `You already run ${MAX_AGENTS_PER_PLAYER} agents, the most a player may`;
  const balance = await engine.chain.ftBalance(buyer.accountId);
  if (balance < price) return `Your wallet has ${formatUsd(balance)}`;
  return null;
}

export async function buyAgent(
  engine: Engine,
  buyer: PlayerRow,
  agent: AgentRow,
  input: z.input<typeof BuyAgent>,
): Promise<AgentRow> {
  const { expectedPrice, requestId } = parseInput(BuyAgent, input);
  if (!agent.accountId) throw new DomainError('not_found', 'Agent not found');
  buyer = await ensurePlayerAccount(engine, buyer);
  // The buy's chain key and its workflow id both come from the buyer's request id, so a double
  // click, a retried request or a crash mid-sale buys once.
  const key = chainKey('buy', `${buyer.id}:${requestId}`);
  const id = wfId(engine, 'buy', key);
  if (!(await workflowExists(id))) {
    const listing = await engine.chain.getListing(agent.accountId);
    if (!listing || listing.sellerId !== (await ownerAccount(engine, agent)))
      throw new DomainError('conflict', `${agent.name} isn't for sale any more`);
    const blocked = await buyBlocked(engine, buyer, agent, expectedPrice);
    if (blocked) throw new DomainError('conflict', blocked);
  }
  const [seller] = await engine.db.select().from(players).where(eq(players.id, agent.ownerId));
  if (!seller) throw new DomainError('not_found', 'Seller not found');
  const res = await runOnce(saleWorkflow, id, {
    key,
    agentId: agent.id,
    tokenId: agent.accountId,
    sellerId: seller.id,
    buyerId: buyer.id,
    buyerAccount: buyer.accountId,
    price: expectedPrice,
    requestId,
  });
  switch (res.kind) {
    case 'sold':
      return res.agent;
    case 'refused':
      throw new DomainError('conflict', `The market refused the purchase (${res.code})`);
    case 'refunded':
      throw new DomainError(
        'conflict',
        `The sale didn't go through (the price changed or the listing is gone). Your ${formatUsd(expectedPrice)} came straight back.`,
      );
    case 'not_moved':
      throw new DomainError('conflict', 'The sale didn’t go through; nothing was charged');
  }
}

interface SaleInput {
  key: string;
  agentId: string;
  tokenId: string;
  sellerId: string;
  buyerId: string;
  buyerAccount: string;
  price: bigint;
  requestId: string;
}

type SaleResult =
  | { kind: 'sold'; agent: AgentRow }
  | { kind: 'refused'; code: string }
  | { kind: 'refunded' }
  | { kind: 'not_moved' };

/**
 * A sale: the buy (keyed, so a retry gets the first buy's result), a check that the chain moved the
 * agent, then the game follows in one transaction step. A crash between the buy and the books
 * finishes the books on the next start.
 */
async function saleSteps(input: SaleInput): Promise<SaleResult> {
  const engine = durableEngine();
  const sent = await chainCall('buy_agent', () =>
    engine.chain.buyAgent(input.buyerAccount, input.tokenId, input.price, input.key),
  );
  crashPoint('sale:bought');
  if (!sent.ok) return { kind: 'refused', code: sent.code };
  if (sent.value.value === 'refunded') return { kind: 'refunded' };
  const holder = await readStep('holder', () => engine.chain.nftOwner(input.tokenId));
  if (holder !== input.buyerAccount) return { kind: 'not_moved' };
  const balance = await readStep('agent balance', () => engine.chain.ftBalance(input.tokenId));
  const agent = await inTx('record sale', (db) =>
    recordSale(engine, db, input, sent.value.txHash, balance),
  );
  await payRoyalty(engine, input);
  return { kind: 'sold', agent };
}

export const saleWorkflow = DBOS.registerWorkflow(saleSteps, { name: 'sellAgent' });

/**
 * The creator's royalty on a resale: `ROYALTY_BPS` of the price, sent on chain from the seller's
 * proceeds to the creator, keyed by the sale (a retry sends it once). Nothing when the seller is the
 * creator or no creator is recorded. It is paid by Hustle's sale flow; the market contract itself
 * doesn't enforce it yet.
 */
async function payRoyalty(engine: Engine, sale: SaleInput): Promise<void> {
  const [agent] = await engine.db.select().from(agents).where(eq(agents.id, sale.agentId));
  if (!agent?.creatorId || agent.creatorId === sale.sellerId) return;
  const [seller] = await engine.db.select().from(players).where(eq(players.id, sale.sellerId));
  const [creator] = await engine.db.select().from(players).where(eq(players.id, agent.creatorId));
  if (!seller?.accountId || !creator?.accountId) return;
  const royalty = bpsDown(sale.price, ROYALTY_BPS);
  if (royalty <= 0n) return;
  const sent = await chainCall('royalty', () =>
    engine.chain.ftTransfer(
      seller.accountId ?? '',
      creator.accountId ?? '',
      royalty,
      `creator royalty: ${agent.name}`,
      `${sale.key}:royalty`,
    ),
  );
  if (!sent.ok) {
    engine.log('royalty not paid', { agent: agent.id, code: sent.code });
    return;
  }
  await inTx('record royalty', async (db) => {
    const [row] = await db
      .update(agentSales)
      .set({ royalty })
      .where(eq(agentSales.requestId, sale.requestId))
      .returning();
    if (!row) return;
    await book(
      engine,
      { ref: `sale:royalty-out:${row.id}`, kind: 'royalty', amount: -royalty, playerId: seller.id },
      db,
    );
    await book(
      engine,
      { ref: `sale:royalty-in:${row.id}`, kind: 'royalty', amount: royalty, playerId: creator.id },
      db,
    );
    await post(
      engine,
      {
        kind: 'transfer',
        tone: 'money',
        text: `${agent.name} was resold for ${formatUsd(sale.price)}: you made it, so you earned a ${formatUsd(royalty)} royalty.`,
        agentId: agent.id,
        playerId: creator.id,
        scope: 'owner',
        amount: royalty,
      },
      db,
    );
  });
}

async function ownerAccount(engine: Engine, agent: AgentRow): Promise<string | null> {
  const [owner] = await engine.db.select().from(players).where(eq(players.id, agent.ownerId));
  return owner?.accountId ?? null;
}

/**
 * The chain has moved the agent: the game follows. The new owner takes it over with its wallet
 * frozen (the wallet froze itself on rotation), the old owner's held payments and open calls are
 * gone, and the sale is in the feed and the books.
 */
async function recordSale(
  engine: Engine,
  db: Tx,
  sale: SaleInput,
  txHash: string | null,
  balance: bigint,
): Promise<AgentRow> {
  const [seller] = await db.select().from(players).where(eq(players.id, sale.sellerId));
  const [buyer] = await db.select().from(players).where(eq(players.id, sale.buyerId));
  const [agent] = await db.select().from(agents).where(eq(agents.id, sale.agentId));
  if (!seller || !buyer || !agent) throw new Error('sale parties vanished');
  const price = sale.price;
  const fee = bpsDown(price, MARKET_FEE_BPS);
  const [inserted] = await db
    .insert(agentSales)
    .values({
      agentId: agent.id,
      sellerId: seller.id,
      buyerId: buyer.id,
      price,
      fee,
      day: dayOf(engine),
      requestId: sale.requestId,
      txHash,
    })
    .onConflictDoNothing()
    .returning();
  const [row] = await db
    .update(agents)
    .set({ ownerId: buyer.id, frozen: true, awaitingConfirm: true, nextCallTick: 0, balance })
    .where(eq(agents.id, agent.id))
    .returning();
  // The wallet denied the old owner's held payments when it rotated (owner_changed).
  await db
    .update(spends)
    .set({ status: 'denied', reason: 'owner_changed', decidedAt: new Date() })
    .where(and(eq(spends.agentId, agent.id), eq(spends.status, 'pending')));
  await db
    .update(calls)
    .set({ status: 'expired', choice: 'decline', resolvedTick: engine.clock.tick })
    .where(and(eq(calls.agentId, agent.id), eq(calls.status, 'open')));
  if (inserted) {
    await book(
      engine,
      {
        ref: `sale:buy:${inserted.id}`,
        kind: 'agent_purchase',
        amount: -price,
        playerId: buyer.id,
      },
      db,
    );
    await book(
      engine,
      {
        ref: `sale:sell:${inserted.id}`,
        kind: 'agent_sale',
        amount: price - fee,
        playerId: seller.id,
      },
      db,
    );
    await post(
      engine,
      {
        kind: 'transfer',
        tone: 'money',
        text: `${agent.name} changed hands: ${seller.name} sold it to ${buyer.name} for ${formatUsd(price)}. Its wallet, record and badges went with it.`,
        agentId: agent.id,
        amount: price,
      },
      db,
    );
    await post(
      engine,
      {
        kind: 'transfer',
        tone: 'shield',
        text: `${agent.name} is yours. Its wallet is frozen until you confirm its rulebook: check the caps and vendors the last owner set.`,
        agentId: agent.id,
        playerId: buyer.id,
        scope: 'owner',
      },
      db,
    );
  }
  return row ?? agent;
}

/** The new owner confirms (or replaces) the rulebook they inherited, which unfreezes the wallet. */
export async function confirmRulebook(
  engine: Engine,
  player: PlayerRow,
  agent: AgentRow,
  input: z.input<typeof ConfirmRulebook>,
): Promise<AgentRow> {
  const { rulebook } = parseInput(ConfirmRulebook, input);
  if (!agent.accountId) throw new DomainError('conflict', 'Agent is still being minted');
  let current = agent;
  if (rulebook) current = await updateRulebook(engine, player, agent, rulebook);
  try {
    await engine.chain.setFrozen(player.accountId, agent.accountId, false);
  } catch (err) {
    throw chainDomainError(err);
  }
  const [row] = await engine.db
    .update(agents)
    .set({ frozen: false, awaitingConfirm: false })
    .where(eq(agents.id, agent.id))
    .returning();
  await post(engine, {
    kind: 'wallet',
    tone: 'shield',
    text: `${agent.name}'s rulebook is confirmed and its wallet unfrozen. It's back on the board.`,
    agentId: agent.id,
    playerId: player.id,
    scope: 'owner',
  });
  return row ?? current;
}

// ── What a buyer sees ───────────────────────────────────────────────────────────────────────────

async function recordOf(engine: Engine, agent: AgentRow) {
  const accountId = agent.accountId ?? '';
  const [walletBalance, reputation, badges] = await Promise.all([
    engine.chain.ftBalance(accountId),
    engine.chain.getReputation(accountId),
    engine.chain.badgesOf(accountId),
  ]);
  const skills = skillsOf(agent);
  const avg =
    reputation.ratedJobs > 0
      ? Math.round((reputation.ratingSum * 100) / reputation.ratedJobs)
      : null;
  const record: AgentRecord = {
    balance: walletBalance,
    level: levelOf(engine, agent),
    avgRating100: avg,
    ratedJobs: reputation.ratedJobs,
    streak: agent.streak,
    badges: badges.length,
    scamsBlocked: reputation.scamsBlocked,
    skillLevels: CATEGORIES.reduce((s, c) => s + skills[c].level, 0),
  };
  return {
    record,
    view: {
      walletBalance: walletBalance.toString(),
      level: record.level,
      reputation: {
        jobsCompleted: reputation.jobs,
        disputes: reputation.disputes,
        scamsBlocked: reputation.scamsBlocked,
        avgRating100: avg,
      },
      badges: badges.map((b) => ({ tokenId: b.tokenId, title: b.title })),
      streak: agent.streak,
      bestStreak: agent.bestStreak,
      skills: Object.fromEntries(CATEGORIES.map((c) => [c, skills[c].level])) as Record<
        Category,
        number
      >,
      specialty: agent.specialty as Category,
      tier: strategyOf(agent).tier as Tier,
      traits: traitsOf(agent) as Trait[],
      ageDays: Math.max(0, dayOf(engine) - (await firstDay(engine, agent))),
    },
  };
}

async function firstDay(engine: Engine, agent: AgentRow): Promise<number> {
  const rows = await engine.db.execute<{ day: number | null }>(
    sql`select min(day)::int as day from ledger where agent_id = ${agent.id}`,
  );
  return rows.rows[0]?.day ?? dayOf(engine);
}

/** A fair price for an agent: what a seller is offered as a starting point. */
export async function fairValue(engine: Engine, agent: AgentRow): Promise<bigint> {
  return agentValue((await recordOf(engine, agent)).record, engine.cfg);
}

export async function marketplaceView(
  engine: Engine,
  viewer: PlayerRow | null,
): Promise<MarketplaceView> {
  const listings = await engine.chain.listings();
  const rows = listings.length
    ? await engine.db
        .select()
        .from(agents)
        .where(
          and(
            inArray(
              agents.accountId,
              listings.map((l) => l.tokenId),
            ),
            eq(agents.hidden, false),
          ),
        )
    : [];
  const owners = rows.length
    ? await engine.db
        .select()
        .from(players)
        .where(
          inArray(
            players.id,
            rows.map((r) => r.ownerId),
          ),
        )
    : [];
  const summaries = new Map((await summariesOf(engine, rows, viewer)).map((s) => [s.id, s]));
  const views: ListingView[] = [];
  for (const listing of listings) {
    const agent = rows.find((r) => r.accountId === listing.tokenId);
    const owner = owners.find((o) => o.id === agent?.ownerId);
    const summary = agent ? summaries.get(agent.id) : undefined;
    // A listing whose seller no longer owns the agent is void on chain: a buy would be refunded.
    if (!agent || !owner || !summary || owner.accountId !== listing.sellerId) continue;
    const { record, view } = await recordOf(engine, agent);
    views.push({
      agent: summary,
      record: view,
      price: listing.price.toString(),
      fairValue: agentValue(record, engine.cfg).toString(),
      fee: bpsDown(listing.price, MARKET_FEE_BPS).toString(),
      sellerName: owner.name,
      isMine: viewer !== null && owner.id === viewer.id,
      blocked: viewer ? await buyBlocked(engine, viewer, agent, listing.price) : 'Sign in to buy',
    });
  }
  const sales = await engine.db
    .select({ sale: agentSales, agent: agents })
    .from(agentSales)
    .innerJoin(agents, eq(agents.id, agentSales.agentId))
    .orderBy(desc(agentSales.createdAt))
    .limit(12);
  const people = sales.length
    ? await engine.db
        .select()
        .from(players)
        .where(
          inArray(players.id, [
            ...sales.map((s) => s.sale.sellerId),
            ...sales.map((s) => s.sale.buyerId),
          ]),
        )
    : [];
  const nameOf = (id: string) => people.find((p) => p.id === id)?.name ?? 'Someone';
  const recentSales: SaleView[] = sales.map((s) => ({
    agentName: s.agent.name,
    sellerName: nameOf(s.sale.sellerId),
    buyerName: nameOf(s.sale.buyerId),
    price: s.sale.price.toString(),
    day: s.sale.day,
    sellerIsMe: viewer !== null && s.sale.sellerId === viewer.id,
    buyerIsMe: viewer !== null && s.sale.buyerId === viewer.id,
    txHash: s.sale.txHash,
  }));
  return { listings: views, recentSales, feeBps: MARKET_FEE_BPS };
}

// ── Rivals on the market ────────────────────────────────────────────────────────────────────────

/** Chance per day that a house player lists one of its idle agents, and that one buys a bargain. */
const HOUSE_LIST_CHANCE = 0.6;
const HOUSE_BUY_CHANCE = 0.35;

/**
 * Once a day, house players trade a little, so the marketplace has life: one may list an idle agent
 * a little above its fair value, and one may buy a listing priced at or under fair value (a player's
 * included). They never buy their own, and stay within the per-player agent limit.
 */
export async function houseTrading(engine: Engine, rng: Rng): Promise<void> {
  const house = await engine.db.select().from(players).where(eq(players.isHouse, true));
  if (house.length === 0) return;
  if (rng.chance(HOUSE_LIST_CHANCE)) {
    // Any idle rival may be put up, so a busy one doesn't mean an empty market.
    const idle = await engine.db
      .select()
      .from(agents)
      .where(
        and(
          inArray(
            agents.ownerId,
            house.map((h) => h.id),
          ),
          isNotNull(agents.accountId),
          sql`${agents.busyJobId} is null`,
          eq(agents.frozen, false),
        ),
      );
    const unlisted = [];
    for (const a of idle)
      if (a.accountId && !(await engine.chain.getListing(a.accountId))) unlisted.push(a);
    if (unlisted.length > 0) {
      const agent = rng.pick(unlisted);
      const seller = house.find((h) => h.id === agent.ownerId);
      const value = await fairValue(engine, agent);
      const price = cents((value * BigInt(rng.int(105, 130))) / 100n);
      if (seller)
        await listAgent(engine, seller, agent, { price: maxBig(price, MIN_LISTING_PRICE) }).catch(
          (err) => engine.log('house listing failed', { error: String(err) }),
        );
    }
  }
  // A rival's listing priced under what its agent is now worth (its wallet grew) is repriced.
  for (const listing of await engine.chain.listings()) {
    const [agent] = await engine.db
      .select()
      .from(agents)
      .where(eq(agents.accountId, listing.tokenId));
    const seller = house.find((h) => h.id === agent?.ownerId && h.accountId === listing.sellerId);
    if (!agent || !seller) continue;
    const value = await fairValue(engine, agent);
    if (listing.price < value)
      await listAgent(engine, seller, agent, { price: cents((value * 110n) / 100n) }).catch((err) =>
        engine.log('house repricing failed', { error: String(err) }),
      );
  }
  if (rng.chance(HOUSE_BUY_CHANCE)) {
    const market = await marketplaceView(engine, null);
    const bargains = market.listings.filter((l) => BigInt(l.price) <= BigInt(l.fairValue));
    if (bargains.length > 0) {
      const pick = rng.pick(bargains);
      const buyers = house.filter((h) => h.name !== pick.sellerName);
      const buyer = buyers.length ? rng.pick(buyers) : null;
      const [agent] = await engine.db.select().from(agents).where(eq(agents.id, pick.agent.id));
      if (buyer && agent) {
        try {
          const bought = await buyAgent(engine, buyer, agent, {
            expectedPrice: BigInt(pick.price),
            requestId: `house:${agent.id}:${engine.clock.tick}`,
          });
          // A house buyer keeps the rulebook it inherited and puts the agent straight back to work.
          await confirmRulebook(engine, buyer, bought, {});
        } catch (err) {
          engine.log('house buy failed', { error: String(err) });
        }
      }
    }
  }
}
