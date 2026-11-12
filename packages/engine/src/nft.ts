/**
 * The agent as an NFT: the holder-only console, gated on the NFT's
 * owner read from chain on every request, and the NFT's history (earnings, payouts by kind, holders),
 * read from the chain's receipt log.
 */
import {
  DomainError,
  type HolderView,
  type NftHistoryView,
  type NftHolderEntry,
  type NftMoneyEntry,
  type ProofView,
  type StrategyView,
} from '@hustle/core';
import { agentSales, agents, inferenceCalls, jobs, players } from '@hustle/db';
import { desc, eq, inArray } from 'drizzle-orm';
import { type AgentRow, strategyOf, tierOf } from './agents/state.ts';
import type { Engine } from './context.ts';
import type { PlayerRow } from './players.ts';
import { rulebookView, summariesOf } from './views.ts';

/** Receipts read for one agent's history; older ones are summarised as truncated. */
const HISTORY_LIMIT = 500;

/**
 * The NFT's holder, read from the registry on chain. If the game's database disagrees (the NFT moved
 * outside the game), the database follows the chain, so the game never acts for a former holder.
 */
export async function syncOwnerFromChain(engine: Engine, agent: AgentRow): Promise<AgentRow> {
  if (!agent.accountId) return agent;
  const owner = await engine.chain.nftOwner(agent.accountId);
  if (!owner) return agent;
  const [holder] = await engine.db.select().from(players).where(eq(players.accountId, owner));
  if (!holder || holder.id === agent.ownerId) return agent;
  const [row] = await engine.db
    .update(agents)
    .set({ ownerId: holder.id, frozen: true, awaitingConfirm: true })
    .where(eq(agents.id, agent.id))
    .returning();
  engine.log('agent owner synced from chain', { agent: agent.id, owner });
  return row ?? agent;
}

/**
 * Refuses anyone but the NFT's current holder, as the registry reports it right now. The session
 * says who you are; the chain says whether you hold the agent.
 */
export async function assertHolder(
  engine: Engine,
  player: PlayerRow,
  agent: AgentRow,
): Promise<string> {
  if (!agent.accountId) throw new DomainError('not_found', 'Agent not found');
  const owner = await engine.chain.nftOwner(agent.accountId);
  if (owner !== player.accountId)
    throw new DomainError(
      'forbidden',
      `Only the holder of ${agent.name}'s NFT can open this page, and the registry says that isn't you.`,
    );
  return owner;
}

export async function holderView(
  engine: Engine,
  player: PlayerRow,
  agent: AgentRow,
): Promise<HolderView> {
  const chainOwner = await assertHolder(engine, player, agent);
  const current = await syncOwnerFromChain(engine, agent);
  const wallet = await engine.chain.getWallet(current.accountId ?? '');
  const [summary] = await summariesOf(engine, [current], player);
  if (!summary) throw new DomainError('not_found', 'Agent not found');
  const brain = engine.brains[tierOf(current)];
  return {
    agent: summary,
    chainOwner,
    wallet: {
      balance: (await engine.chain.ftBalance(current.accountId ?? '')).toString(),
      frozen: wallet.frozen,
      spentToday: wallet.spentToday.toString(),
      rotationSeq: wallet.rotationSeq,
      pending: wallet.pending.map((p) => ({
        requestId: p.id,
        amount: p.request.amount.toString(),
        receiver: p.request.receiverId,
        reason: p.reason,
      })),
    },
    rulebook: rulebookView(current),
    strategy: strategyOf(current) as StrategyView,
    brain: {
      tier: tierOf(current),
      model: brain.model,
      keyId: current.inferenceKeyId,
      keySealed: current.inferenceKeySealed !== null,
    },
    notes: [
      ...(current.awaitingConfirm
        ? [
            'You just took this agent over: confirm or change the rulebook the last holder left, and its wallet unfreezes.',
          ]
        : []),
      `Rotation ${wallet.rotationSeq}: every change of holder bumps it, and the wallet refuses owner calls carrying an older one.`,
      wallet.frozen
        ? 'The wallet is frozen: nothing leaves it until you confirm its rulebook.'
        : 'The wallet is live: it pays for the agent’s work within your rulebook.',
      current.inferenceKeySealed
        ? 'Its NEAR AI key is sealed with the server secret; nobody reads it back, you included.'
        : 'It thinks with scripted replies (no NEAR AI key for it).',
    ],
  };
}

// ── History ─────────────────────────────────────────────────────────────────────────────────────

type Event = { event: string; data: Record<string, unknown> };

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** What a credit coming into the agent's wallet was, from who sent it and the memo. */
function earningKind(engine: Engine, from: string, memo: string | null): string {
  const ids = engine.chain.ids;
  if (from === ids.jobs) return 'job payout';
  if (from === ids.treasury) return memo?.includes('bond') ? 'bond returned' : 'from the treasury';
  if (memo?.includes('tip')) return 'tip';
  if (from.endsWith(`.${ids.registry}`)) return 'paid by another agent';
  if (memo?.includes('backing')) return 'backing';
  return 'top-up';
}

export async function nftHistoryView(
  engine: Engine,
  agent: AgentRow,
  viewer: PlayerRow | null,
): Promise<NftHistoryView> {
  const tokenId = agent.accountId ?? '';
  if (!tokenId) throw new DomainError('not_found', 'Agent not found');
  const txs = await engine.chain.txs({ account: tokenId, limit: HISTORY_LIMIT });
  const accounts = new Set<string>();
  for (const tx of txs)
    for (const e of tx.events as Event[])
      for (const k of ['old_owner_id', 'new_owner_id', 'owner_id', 'receiver_id'])
        if (str(e.data?.[k])) accounts.add(str(e.data[k]) as string);
  const list = [...accounts];
  const [people, agentRows] = list.length
    ? await Promise.all([
        engine.db.select().from(players).where(inArray(players.accountId, list)),
        engine.db.select().from(agents).where(inArray(agents.accountId, list)),
      ])
    : [[], []];
  const nameOf = (account: string) =>
    people.find((p) => p.accountId === account)?.name ??
    agentRows.find((a) => a.accountId === account)?.name ??
    account.split('.')[0] ??
    account;
  const sales = await engine.db.select().from(agentSales).where(eq(agentSales.agentId, agent.id));
  const paidJobs = await engine.db
    .select({ chainJobId: jobs.chainJobId, clientName: jobs.clientName, title: jobs.title })
    .from(jobs)
    .where(eq(jobs.awardedAgentId, agent.id));

  const holders: NftHolderEntry[] = [];
  const earnings: NftMoneyEntry[] = [];
  const payouts: NftMoneyEntry[] = [];
  // Oldest first, so holders read in order.
  for (const tx of [...txs].reverse()) {
    if (tx.outcome !== 'success') continue;
    const events = tx.events as Event[];
    const base = { at: tx.createdAt, tick: tx.tick ?? null, txHash: tx.hash };
    const spent = events.some((e) => e.event === 'spend_settled');
    for (const e of events) {
      const d = e.data ?? {};
      const tokens = Array.isArray(d.token_ids) ? (d.token_ids as unknown[]) : [];
      if (e.event === 'nft_mint' && tokens.includes(tokenId)) {
        const owner = str(d.owner_id) ?? '';
        holders.push({
          accountId: owner,
          name: nameOf(owner),
          how: 'minted',
          price: null,
          ...base,
        });
      } else if (e.event === 'nft_transfer' && tokens.includes(tokenId)) {
        const owner = str(d.new_owner_id) ?? '';
        const sale = sales.find((s) => s.txHash === tx.hash);
        holders.push({
          accountId: owner,
          name: nameOf(owner),
          how:
            sale || tx.receiver === engine.chain.ids.market || tx.method === 'ft_transfer_call'
              ? 'sold'
              : 'transferred',
          price: sale ? sale.price.toString() : null,
          ...base,
        });
      } else if (e.event === 'spend_settled' && tx.receiver === tokenId) {
        const to = str(d.receiver_id) ?? '';
        payouts.push({
          kind: str(d.kind) ?? 'payment',
          counterparty: nameOf(to),
          amount: String(d.amount ?? '0'),
          memo: str(d.memo),
          ...base,
        });
      } else if (e.event === 'ft_transfer' && str(d.new_owner_id) === tokenId) {
        const from = str(d.old_owner_id) ?? '';
        // A job payout names its client and job rather than the job board's account.
        const chainJobId = /^job (\d+)$/.exec(str(d.memo) ?? '')?.[1];
        const job = chainJobId ? paidJobs.find((j) => j.chainJobId === chainJobId) : undefined;
        earnings.push({
          kind: earningKind(engine, from, str(d.memo)),
          counterparty: job ? job.clientName : nameOf(from),
          amount: String(d.amount ?? '0'),
          memo: job ? job.title : str(d.memo),
          ...base,
        });
      } else if (e.event === 'ft_transfer' && str(d.old_owner_id) === tokenId && !spent) {
        // Money leaving the wallet other than as a spend: the holder withdrawing it.
        const to = str(d.new_owner_id) ?? '';
        payouts.push({
          kind: 'withdrawn by the holder',
          counterparty: nameOf(to),
          amount: String(d.amount ?? '0'),
          memo: str(d.memo),
          ...base,
        });
      } else if (e.event === 'ft_mint' && str(d.owner_id) === tokenId) {
        earnings.push({
          kind: 'starting credits',
          counterparty: 'the game',
          amount: String(d.amount ?? '0'),
          memo: null,
          ...base,
        });
      }
    }
  }
  const totals = new Map<string, bigint>();
  for (const e of earnings) totals.set(e.kind, (totals.get(e.kind) ?? 0n) + BigInt(e.amount));
  for (const p of payouts) totals.set(p.kind, (totals.get(p.kind) ?? 0n) - BigInt(p.amount));
  const [summary] = await summariesOf(engine, [agent], viewer);
  if (!summary) throw new DomainError('not_found', 'Agent not found');
  return {
    agent: summary,
    tokenId,
    holders,
    earnings: earnings.reverse(),
    payouts: payouts.reverse(),
    totals: [...totals].map(([kind, amount]) => ({ kind, amount: amount.toString() })),
    truncated: txs.length >= HISTORY_LIMIT,
  };
}

/** An agent's proof page: everything a judge can check, read from the chain now. Public. */
export async function proofView(engine: Engine, agent: AgentRow): Promise<ProofView> {
  const accountId = agent.accountId ?? '';
  const [wallet, reputation, badges, txs, holder] = await Promise.all([
    engine.chain.getWallet(accountId),
    engine.chain.getReputation(accountId),
    engine.chain.badgesOf(accountId),
    engine.chain.txs({ account: accountId, limit: 15 }),
    engine.chain.nftOwner(accountId),
  ]);
  const calls = await engine.db
    .select()
    .from(inferenceCalls)
    .where(eq(inferenceCalls.agentId, agent.id))
    .orderBy(desc(inferenceCalls.createdAt))
    .limit(8);
  const r = wallet.rulebook;
  return {
    accountId,
    chain: engine.modes.chain as ProofView['chain'],
    explorer: engine.modes.chain === 'testnet' ? 'https://testnet.nearblocks.io' : null,
    holder,
    wallet: {
      frozen: wallet.frozen,
      spentToday: wallet.spentToday.toString(),
      rotationSeq: wallet.rotationSeq,
      dayMs: wallet.dayMs,
      rulebook: {
        dailyCap: r.dailyCap.toString(),
        maxPerJob: r.maxPerJob.toString(),
        maxPerCall: r.maxPerCall.toString(),
        allowedVendors: r.allowedVendors,
        anyVendor: r.anyVendor,
        mayHire: r.mayHire,
        helperBudget: r.helperBudget.toString(),
      },
    },
    reputation,
    badges: badges.map((b) => ({ tokenId: b.tokenId, title: b.title })),
    inference: calls.map((c) => {
      const v = c.verification as { passed?: boolean; mode?: string; signer?: string } | null;
      return {
        at: c.createdAt.toISOString(),
        purpose: c.purpose,
        model: c.model,
        source: c.source,
        cost: c.cost === null ? null : c.cost.toString(),
        verified: v?.passed ?? null,
        signer: v?.signer ?? null,
        jobId: c.jobId,
      };
    }),
    txs,
  };
}
