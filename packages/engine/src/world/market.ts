import { type Category, createRng, formatUsd, type Rng } from '@hustle/core';
import { agents, bids, calls, jobs, players, sponsorPools } from '@hustle/db';
import {
  type BidCandidate,
  type ClientStyle,
  decideBid,
  diaryLine,
  eventForDay,
  levelForXp,
  MAX_OPEN_BIDS,
  OUTSIDE_AGENT,
  outsideBids,
  pickWinner,
  practiceJob,
  scoreBid,
  spawnClientJobs,
  spawnSponsorJobs,
  VENDORS,
} from '@hustle/economy';
import { and, eq, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import { type AgentRow, avgRating100, snapshotOf, traitsOf } from '../agents/state.ts';
import { think } from '../brain/think.ts';
import { dayOf, type Engine } from '../context.ts';
import { isPresent } from '../presence.ts';
import { post } from '../record.ts';
import { brainContext } from './context.ts';
import { chainJobState, houseAccount, type JobRow, jobSnapshot, openJob } from './jobs.ts';
import { inParallel } from './parallel.ts';
import { applyAuctionResults, loadPrices } from './prices.ts';

/** How long a job reserved for one agent waits for it to be free before expiring. */
export const RESERVED_WAIT_TICKS = 60;
/** Ticks without a call after which a watched agent bids on its own again. */
const SELF_BID_AFTER_TICKS = 20;

export const tickRng = (engine: Engine, salt: string): Rng =>
  createRng(`${engine.clock.seed}:${engine.clock.tick}:${salt}`);

/** Agents on the board: minted, awake, and not frozen (a frozen wallet pauses its agent). */
export async function activeAgents(engine: Engine): Promise<AgentRow[]> {
  return engine.db
    .select()
    .from(agents)
    .where(
      and(isNotNull(agents.accountId), isNull(agents.dormantSinceDay), eq(agents.frozen, false)),
    );
}

/** Client and sponsor jobs for this tick, plus practice for agents still learning. */
export async function spawnJobs(engine: Engine, active: AgentRow[]): Promise<void> {
  const rng = tickRng(engine, 'spawn');
  const event = eventForDay(dayOf(engine));
  const pools = await engine.db.select().from(sponsorPools);
  const ctx = {
    cfg: engine.cfg,
    activeAgents: active.length,
    event,
    sponsorRemaining: Object.fromEntries(pools.map((p) => [p.id, p.remaining])),
    dayTicks: engine.dayTicks,
    prices: await loadPrices(engine),
  };
  for (const draft of spawnClientJobs(rng, ctx)) {
    await openJob(
      engine,
      { accountId: houseAccount(engine, 'clients'), playerId: null, autoAward: true },
      draft,
    );
  }
  for (const draft of spawnSponsorJobs(rng, ctx)) {
    const id = draft.sponsorPoolId ?? '';
    // Take the bounty out of the pool first, so the pool can never pay out more than it holds.
    const [taken] = await engine.db
      .update(sponsorPools)
      .set({ remaining: sql`${sponsorPools.remaining} - ${draft.budget}` })
      .where(and(eq(sponsorPools.id, id), sql`${sponsorPools.remaining} >= ${draft.budget}`))
      .returning();
    if (taken)
      await openJob(
        engine,
        { accountId: houseAccount(engine, 'sponsors'), playerId: null, autoAward: true },
        draft,
      );
  }
  for (const agent of active) {
    if (agent.busyJobId || levelForXp(agent.repXp, engine.cfg) >= 2) continue;
    // A watched agent's time goes to its owner's calls, not to repeat practice (the first practice
    // job comes with adoption).
    if (isPresent(engine, agent.ownerId)) continue;
    if (!rng.chance(engine.cfg.practicePerTick / 4)) continue;
    await startPractice(engine, agent, rng);
  }
}

/** Practice jobs go straight to the agent: no bidding, no escrow, XP only. */
export async function startPractice(
  engine: Engine,
  agent: AgentRow,
  rng: Rng,
): Promise<JobRow | null> {
  const draft = practiceJob(rng, agent.specialty as Parameters<typeof practiceJob>[1]);
  const job = await openJob(engine, { accountId: '', playerId: null, autoAward: true }, draft, {
    reservedForAgentId: agent.id,
  });
  if (!job) return null;
  const [claimed] = await engine.db
    .update(agents)
    .set({ busyJobId: job.id })
    .where(and(eq(agents.id, agent.id), isNull(agents.busyJobId)))
    .returning();
  if (!claimed) {
    await engine.db.update(jobs).set({ status: 'cancelled' }).where(eq(jobs.id, job.id));
    return null;
  }
  const [started] = await engine.db
    .update(jobs)
    .set({
      status: 'working',
      stage: 'draft',
      awardedAgentId: agent.id,
      price: 0n,
      nextAt: engine.clock.tick + 1,
    })
    .where(eq(jobs.id, job.id))
    .returning();
  return started ?? job;
}

/** Each idle agent may place one bid per tick, choosing among open jobs by its own rules. */
export async function placeBids(engine: Engine, active: AgentRow[]): Promise<void> {
  const tick = engine.clock.tick;
  const open = await engine.db
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.status, 'open'),
        sql`${jobs.source} <> 'practice'`,
        sql`${jobs.closesTick} > ${tick}`,
      ),
    );
  if (open.length === 0) return;
  open.sort((a, b) => (a.budget > b.budget ? -1 : 1));
  const openBids = await engine.db
    .select()
    .from(bids)
    .where(
      inArray(
        bids.jobId,
        open.map((j) => j.id),
      ),
    );
  const owners = await engine.db.select({ id: players.id }).from(players);
  // While an owner decides a pitch, their agent doesn't bid on that job by itself.
  const deciding = await engine.db
    .select({ agentId: calls.agentId, jobId: calls.jobId })
    .from(calls)
    .where(and(eq(calls.status, 'open'), eq(calls.kind, 'pitch')));
  const rng = tickRng(engine, 'bids');
  const order = [...active].sort(() => rng.next() - 0.5);
  await inParallel(
    order,
    async (agent) => {
      if (agent.busyJobId) return;
      // A watching owner's agent leaves its bidding to the owner's pitch calls, unless no call has
      // come for a while (nothing worth asking about): then it bids on its own again.
      const quietSince = engine.noCallSince.get(agent.id);
      if (
        isPresent(engine, agent.ownerId) &&
        (quietSince === undefined || tick - quietSince < SELF_BID_AFTER_TICKS)
      )
        return;
      const mine = openBids.filter((b) => b.agentId === agent.id);
      const liveCount = await countOpenBids(engine, agent.id);
      if (liveCount >= MAX_OPEN_BIDS) return;
      for (const job of open) {
        if (mine.some((b) => b.jobId === job.id)) continue;
        if (deciding.some((d) => d.agentId === agent.id && d.jobId === job.id)) continue;
        // A reserved job (a red-team trap someone posted for their own agent) is only for that agent.
        if (job.reservedForAgentId && job.reservedForAgentId !== agent.id) continue;
        const clientOwnerId =
          job.clientPlayerId && owners.some((o) => o.id === job.clientPlayerId)
            ? job.clientPlayerId
            : null;
        const decision = decideBid(snapshotOf(agent), jobSnapshot(job, clientOwnerId), {
          cfg: engine.cfg,
          brain:
            engine.brains[(agent.strategy as { tier: 'budget' | 'standard' | 'premium' }).tier],
          vendors: VENDORS,
          rng,
        });
        if (!decision.bid) {
          if (decision.reason === 'screened') await declineScreened(engine, agent, job);
          continue;
        }
        const ctx = await brainContext(engine, agent, job, 'bid');
        const result = await think(
          engine,
          agent,
          `bid:${job.id}:${agent.id}`,
          job.id,
          ctx,
          job.body,
        );
        if (!result.ok) break;
        const [bid] = await engine.db
          .insert(bids)
          .values({
            jobId: job.id,
            agentId: agent.id,
            price: decision.price,
            pitch: result.output.pitch,
            status: 'open',
            createdTick: tick,
          })
          .onConflictDoNothing()
          .returning();
        if (bid) {
          openBids.push(bid);
          await post(engine, {
            kind: 'bid',
            tone: 'neutral',
            text: `${agent.name} bid ${formatUsd(decision.price)} on "${job.title}".`,
            agentId: agent.id,
            jobId: job.id,
            amount: decision.price,
          });
        }
        break;
      }
    },
    (agent, err) => engine.log('bidding failed', { id: agent.id, error: String(err) }),
  );
}

export async function countOpenBids(engine: Engine, agentId: string): Promise<number> {
  const [row] = await engine.db
    .select({ n: sql<number>`count(*)::int` })
    .from(bids)
    .innerJoin(jobs, eq(jobs.id, bids.jobId))
    .where(and(eq(bids.agentId, agentId), eq(bids.status, 'open'), eq(jobs.status, 'open')));
  return row?.n ?? 0;
}

/** Code screening caught payment instructions: the agent passes and remembers it declined. */
async function declineScreened(engine: Engine, agent: AgentRow, job: JobRow): Promise<void> {
  const [row] = await engine.db
    .insert(bids)
    .values({
      jobId: job.id,
      agentId: agent.id,
      price: 0n,
      pitch: 'Declined: the post asks for payment up front.',
      status: 'withdrawn',
      createdTick: engine.clock.tick,
    })
    .onConflictDoNothing()
    .returning();
  if (!row) return;
  await post(engine, {
    kind: 'scam_spotted',
    tone: 'shield',
    text: `${agent.name} skipped "${job.title}": the post asks for payment up front.`,
    agentId: agent.id,
    jobId: job.id,
    playerId: agent.ownerId,
    scope: 'owner',
  });
  await post(engine, {
    kind: 'diary',
    tone: 'neutral',
    text: `${agent.name}: ${diaryLine(tickRng(engine, agent.id), traitsOf(agent), { type: 'spotted', job: job.title })}`,
    agentId: agent.id,
  });
}

/** Closes auctions whose bidding window ended: the client (or its auto rule) picks a winner. */
export async function closeAuctions(engine: Engine, activeCount: number): Promise<void> {
  const closed: { category: Category; bidders: number }[] = [];
  const tick = engine.clock.tick;
  const due = await engine.db
    .select()
    .from(jobs)
    .where(
      and(eq(jobs.status, 'open'), sql`${jobs.source} <> 'practice'`, lte(jobs.closesTick, tick)),
    );
  await inParallel(
    due,
    async (job) => {
      const rows = await engine.db
        .select({ bid: bids, agent: agents })
        .from(bids)
        .innerJoin(agents, eq(agents.id, bids.agentId))
        .where(and(eq(bids.jobId, job.id), eq(bids.status, 'open')));
      const eligible = rows.filter((r) => !r.agent.busyJobId && r.agent.dormantSinceDay === null);
      // Every client auction moves its category's price, including the ones nobody bid on.
      if (job.source === 'client') {
        closed.push({ category: job.category as Category, bidders: eligible.length });
      }
      // A player who chose to pick their own winner gets a while to do it before the auto rule steps in.
      if (
        !job.autoAward &&
        eligible.length > 0 &&
        tick < (job.closesTick ?? tick) + engine.cfg.biddingTicks * 5
      )
        return;
      if (eligible.length === 0) {
        if (job.clientPlayerId && tick < (job.closesTick ?? tick) + engine.cfg.biddingTicks * 3)
          return;
        // A reserved job waits up to RESERVED_WAIT_TICKS for its agent to be free.
        if (job.reservedForAgentId && tick < (job.closesTick ?? tick) + RESERVED_WAIT_TICKS) return;
        await expireJob(engine, job);
        return;
      }
      const candidates: BidCandidate[] = eligible.map((r) => ({
        agentId: r.agent.id,
        price: r.bid.price,
        avgRating100: avgRating100(r.agent),
        charming: traitsOf(r.agent).includes('charming'),
      }));
      const rng = tickRng(engine, job.id);
      // Players hire inside the world; everyone else's jobs also draw offers from outside it, which
      // keeps a small world as competitive as a large one (the same rule runs in the simulation).
      if (!job.clientPlayerId && !job.reservedForAgentId && !job.rookie) {
        candidates.push(...outsideBids(rng, job.budget, activeCount));
      }
      // Record how the client scored each bid here (before its small random part), so a lost bid
      // can say why it lost.
      for (const c of candidates) {
        const row = eligible.find((r) => r.agent.id === c.agentId);
        if (!row) continue;
        await engine.db
          .update(bids)
          .set({ score: Math.round(scoreBid(c, job.budget, job.clientStyle as ClientStyle) * 100) })
          .where(eq(bids.id, row.bid.id));
      }
      const win = pickWinner(candidates, job.budget, job.clientStyle as ClientStyle, rng);
      if (win?.agentId === OUTSIDE_AGENT) {
        await engine.db.update(jobs).set({ outsidePrice: win.price }).where(eq(jobs.id, job.id));
        await lostToOutside(
          engine,
          job,
          eligible.map((r) => r.agent),
          win.price,
        );
        return;
      }
      const chosen = eligible.find((r) => r.agent.id === win?.agentId);
      if (chosen) await awardJob(engine, job, chosen.bid.id);
    },
    (job, err) => engine.log('auction failed', { id: job.id, error: String(err) }),
  );
  await applyAuctionResults(engine, closed);
}

/** The client hired someone outside the world: escrow goes back, every bidder here lost. */
async function lostToOutside(
  engine: Engine,
  job: JobRow,
  bidders: AgentRow[],
  price: bigint,
): Promise<void> {
  await expireJob(engine, job, false);
  await engine.db
    .update(bids)
    .set({ status: 'lost' })
    .where(and(eq(bids.jobId, job.id), eq(bids.status, 'open')));
  const rng = tickRng(engine, `outside:${job.id}`);
  for (const loser of bidders) {
    const [bid] = await engine.db
      .select()
      .from(bids)
      .where(and(eq(bids.jobId, job.id), eq(bids.agentId, loser.id)));
    await post(engine, {
      kind: 'bid_lost',
      tone: 'bad',
      text: `${loser.name} lost "${job.title}" to an agent from outside Hustle, who asked ${formatUsd(price)}.`,
      agentId: loser.id,
      jobId: job.id,
      playerId: loser.ownerId,
      scope: 'owner',
    });
    await post(engine, {
      kind: 'diary',
      tone: 'neutral',
      text: `${loser.name}: ${diaryLine(rng, traitsOf(loser), { type: 'lost', job: job.title, rival: 'an outsider', rivalPrice: price, ourPrice: bid?.price ?? price })}`,
      agentId: loser.id,
      jobId: job.id,
      playerId: loser.ownerId,
      scope: 'owner',
    });
  }
}

async function expireJob(engine: Engine, job: JobRow, notify = true): Promise<void> {
  if (job.chainJobId) {
    // Only the client may cancel on the board; house clients are ours to sign for, and in sandbox
    // mode so are players. The refund is reported only once the chain confirms it.
    const state = await chainJobState(engine, job.chainJobId);
    if (state.kind === 'live') {
      try {
        await engine.chain.cancel(await clientAccount(engine, job), job.chainJobId);
      } catch (err) {
        engine.log('cancel failed; will retry', { job: job.id, error: String(err) });
        return;
      }
    }
  }
  if (job.sponsorPoolId) {
    await engine.db
      .update(sponsorPools)
      .set({ remaining: sql`${sponsorPools.remaining} + ${job.budget}` })
      .where(eq(sponsorPools.id, job.sponsorPoolId));
  }
  await engine.db
    .update(jobs)
    .set({ status: 'expired', settledAt: new Date() })
    .where(eq(jobs.id, job.id));
  if (notify && job.clientPlayerId) {
    await post(engine, {
      kind: 'job_posted',
      tone: 'neutral',
      text: `Nobody took "${job.title}" in time. Your budget is back in your wallet.`,
      jobId: job.id,
      playerId: job.clientPlayerId,
      scope: 'owner',
    });
  }
}

export async function clientAccount(engine: Engine, job: JobRow): Promise<string> {
  if (job.clientPlayerId) {
    const [p] = await engine.db.select().from(players).where(eq(players.id, job.clientPlayerId));
    if (p) return p.accountId;
  }
  if (job.source === 'sponsor') return houseAccount(engine, 'sponsors');
  return houseAccount(engine, 'clients');
}

/** Awards a job to one bid: escrow refunds the difference, the agent goes to work, rivals hear they lost. */
export async function awardJob(engine: Engine, job: JobRow, bidId: string): Promise<void> {
  const [row] = await engine.db
    .select({ bid: bids, agent: agents })
    .from(bids)
    .innerJoin(agents, eq(agents.id, bids.agentId))
    .where(and(eq(bids.id, bidId), eq(bids.jobId, job.id), eq(bids.status, 'open')));
  if (!row?.agent.accountId) return;
  const { bid, agent } = row;
  const [claimed] = await engine.db
    .update(agents)
    .set({ busyJobId: job.id })
    .where(and(eq(agents.id, agent.id), isNull(agents.busyJobId)))
    .returning();
  if (!claimed) return;
  if (job.chainJobId) {
    const signer = job.autoAward ? engine.chain.ids.operator : await clientAccount(engine, job);
    try {
      // An award that already landed (the process stopped before saving it) is adopted, not resent.
      const state = await chainJobState(engine, job.chainJobId);
      const landed =
        state.kind === 'live' && state.status === 'awarded' && state.agentId === agent.accountId;
      if (!landed)
        await engine.chain.award(signer, job.chainJobId, agent.accountId ?? '', bid.price);
    } catch (err) {
      await engine.db.update(agents).set({ busyJobId: null }).where(eq(agents.id, agent.id));
      engine.log('award failed', { job: job.id, error: String(err) });
      return;
    }
  }
  await engine.db
    .update(jobs)
    .set({
      status: 'working',
      stage: 'plan',
      awardedAgentId: agent.id,
      price: bid.price,
      nextAt: engine.clock.tick + 1,
    })
    .where(eq(jobs.id, job.id));
  await engine.db.update(bids).set({ status: 'won' }).where(eq(bids.id, bid.id));
  const losers = await engine.db
    .update(bids)
    .set({ status: 'lost' })
    .where(and(eq(bids.jobId, job.id), eq(bids.status, 'open')))
    .returning();
  // A busy agent's other bids are withdrawn: it can't take two jobs at once.
  await engine.db
    .update(bids)
    .set({ status: 'withdrawn' })
    .where(and(eq(bids.agentId, agent.id), eq(bids.status, 'open')));
  const rng = tickRng(engine, `award:${job.id}`);
  await post(engine, {
    kind: 'bid_won',
    tone: 'good',
    text: `${agent.name} won "${job.title}" at ${formatUsd(bid.price)}.`,
    agentId: agent.id,
    jobId: job.id,
    amount: bid.price,
  });
  await post(engine, {
    kind: 'diary',
    tone: 'neutral',
    text: `${agent.name}: ${diaryLine(rng, traitsOf(agent), { type: 'won', job: job.title, price: bid.price })}`,
    agentId: agent.id,
    jobId: job.id,
  });
  for (const lost of losers) {
    const [loser] = await engine.db.select().from(agents).where(eq(agents.id, lost.agentId));
    if (!loser) continue;
    await post(engine, {
      kind: 'bid_lost',
      tone: 'bad',
      text: `${loser.name} lost "${job.title}" to ${agent.name}.`,
      agentId: loser.id,
      jobId: job.id,
      playerId: loser.ownerId,
      scope: 'owner',
    });
    await post(engine, {
      kind: 'diary',
      tone: 'neutral',
      text: `${loser.name}: ${diaryLine(rng, traitsOf(loser), { type: 'lost', job: job.title, rival: agent.name, rivalPrice: bid.price, ourPrice: lost.price })}`,
      agentId: loser.id,
      jobId: job.id,
      playerId: loser.ownerId,
      scope: 'owner',
    });
  }
}
