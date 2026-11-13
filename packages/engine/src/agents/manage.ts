import { randomUUID } from 'node:crypto';
import { ChainError } from '@hustle/chain';
import {
  AgentLook,
  AgentName,
  Category,
  canonicalJson,
  createRng,
  DomainError,
  defaultRulebook,
  defaultStrategy,
  formatUsd,
  MAX_SKILL_LEVEL,
  MicroAmount,
  parseInput,
  Rulebook,
  SPEND_REASON_TEXT,
  type SpendReason,
  Strategy,
  Tier,
  Trait,
  usd,
} from '@hustle/core';
import { agents, backings, players, spends, type Tx } from '@hustle/db';
import { diaryLine, emptySkills, honestVendors, REVIVE_XP_PENALTY, VENDORS } from '@hustle/economy';
import { and, count, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { dayOf, type Engine, vendorAccount } from '../context.ts';
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
} from '../durable.ts';
import { assertNearReserve, takeDailySlot } from '../guards.ts';
import type { PlayerRow } from '../players.ts';
import { ensurePlayerAccount } from '../players.ts';
import { book, chainKey, post } from '../record.ts';
import { startPractice } from '../world/market.ts';
import {
  type AgentRow,
  refreshAccount,
  refreshBalance,
  rulebookOf,
  skillsOf,
  storedRulebook,
  traitsOf,
} from './state.ts';

/** Agents one player may run: upkeep is the main Sybil brake, this is the hard one. */
export const MAX_AGENTS_PER_PLAYER = 3;
/** Most a single top-up, backing or withdrawal moves in sandbox mode. */
export const MAX_TRANSFER = usd('50');

export const MintAgent = z.object({
  name: AgentName,
  look: AgentLook,
  traits: z
    .array(Trait)
    .length(2)
    .refine((t) => t[0] !== t[1], 'Pick two different traits'),
  specialty: Category,
  tier: Tier,
});

export const Amount = z.object({
  amount: MicroAmount.refine(
    (a) => a > 0n && a <= MAX_TRANSFER,
    'Amount must be between $0.000001 and $50',
  ),
  /** Chosen by the browser per click, so a double click or a retried request moves money once. */
  requestId: z.uuid().optional(),
});

export const RulebookInput = Rulebook.refine(
  (r) => r.maxPerCall <= r.dailyCap,
  'The per-payment cap cannot be above the daily cap',
);
export const TrainSkill = z.object({ category: Category });
export const DecideApproval = z.object({ approve: z.boolean() });
export const Frozen = z.object({ frozen: z.boolean() });

/** The agent, if this player owns it. Someone else's agent reads as not found. */
export async function ownedAgent(
  engine: Engine,
  player: PlayerRow,
  agentId: string,
): Promise<AgentRow> {
  const parsed = z.uuid().safeParse(agentId);
  if (!parsed.success) throw new DomainError('not_found', 'Agent not found');
  const [row] = await engine.db
    .select()
    .from(agents)
    .where(and(eq(agents.id, parsed.data), eq(agents.ownerId, player.id)));
  if (!row) throw new DomainError('not_found', 'Agent not found');
  // The chain decides who holds the agent: if the NFT moved outside the game, the database's owner
  // is stale and gets nothing (the holder page re-syncs it from chain).
  if (row.accountId) {
    const holder = await engine.chain.nftOwner(row.accountId);
    if (holder && holder !== player.accountId)
      throw new DomainError('not_found', 'Agent not found');
  }
  return row;
}

export async function anyAgent(engine: Engine, agentId: string): Promise<AgentRow> {
  const parsed = z.uuid().safeParse(agentId);
  if (!parsed.success) throw new DomainError('not_found', 'Agent not found');
  const [row] = await engine.db.select().from(agents).where(eq(agents.id, parsed.data));
  if (!row?.accountId) throw new DomainError('not_found', 'Agent not found');
  return row;
}

export const knownVendorAccounts = (engine: Engine): string[] =>
  honestVendors().map((v) => vendorAccount(engine, v.handle));

/**
 * Mints an agent: an NFT whose token id is a new keyless NEAR account that holds the agent's money,
 * with the default rulebook. Sandbox mode funds it with starter credits. The mint is a workflow keyed
 * by the agent's id, so a crash mid-mint finishes on the next start instead of leaving half an agent.
 */
export async function mintAgent(
  engine: Engine,
  owner: PlayerRow,
  input: z.input<typeof MintAgent>,
): Promise<AgentRow> {
  const data = parseInput(MintAgent, input);
  owner = await ensurePlayerAccount(engine, owner);
  const [{ n } = { n: 0 }] = await engine.db
    .select({ n: count() })
    .from(agents)
    .where(eq(agents.ownerId, owner.id));
  if (n >= MAX_AGENTS_PER_PLAYER && !owner.isHouse) {
    throw new DomainError('conflict', `You can run up to ${MAX_AGENTS_PER_PLAYER} agents`);
  }
  // Names are how players tell agents apart in the feed, so each is used once (case-insensitive).
  const [taken] = await engine.db
    .select({ id: agents.id })
    .from(agents)
    .where(sql`lower(${agents.name}) = lower(${data.name})`);
  if (taken) throw new DomainError('conflict', `${data.name} is already taken. Try another name.`);
  // Each mint costs the operator NEAR: players' mints are capped per day and stop at the reserve.
  if (!owner.isHouse) {
    await assertNearReserve(engine);
    await takeDailySlot(engine, 'mints');
  }
  const agentId = randomUUID();
  const res = await runOnce(mintWorkflow, wfId(engine, 'mint', agentId), {
    agentId,
    owner: { id: owner.id, accountId: owner.accountId, name: owner.name },
    data,
    rulebook: storedRulebook(defaultRulebook(knownVendorAccounts(engine))),
  });
  if (!res.ok) throw chainDomainError(new ChainError(res.code, null));
  // A new player's agent starts with a practice job at once, so the first minute isn't empty.
  if (!owner.isHouse) await startPractice(engine, res.agent, createRng(`tutorial:${res.agent.id}`));
  return res.agent;
}

export interface MintInput {
  agentId: string;
  owner: { id: string; accountId: string; name: string };
  data: z.output<typeof MintAgent>;
  rulebook: Record<string, unknown>;
}

type MintResult = { ok: true; agent: AgentRow } | { ok: false; code: string };

/**
 * The mint's steps, also run inside the seed's rival workflow: the agent's row, the registry mint
 * (keyed by the agent's id, so a retry gets the same token), its starter credits, then the books
 * and the feed. A refused mint frees the name and the player's slot.
 */
export async function mintSteps(input: MintInput): Promise<MintResult> {
  const engine = durableEngine();
  const { agentId, owner, data } = input;
  const row = await inTx('write agent', async (db) => {
    await db
      .insert(agents)
      .values({
        id: agentId,
        ownerId: owner.id,
        name: data.name,
        look: data.look,
        traits: data.traits,
        specialty: data.specialty,
        skills: Object.fromEntries(
          Object.entries(emptySkills(data.specialty, engine.cfg)).map(([k, v]) => [
            k,
            { ...v, trainingUntilDay: null },
          ]),
        ),
        strategy: { ...defaultStrategy(data.specialty), tier: data.tier },
        rulebook: input.rulebook,
      })
      .onConflictDoNothing();
    const [written] = await db.select().from(agents).where(eq(agents.id, agentId));
    if (!written) throw new Error('agent not written');
    return written;
  });
  const minted = await chainCall('mint_agent', () =>
    engine.chain.mintAgent(
      owner.accountId,
      row.name,
      { look: row.look, traits: row.traits },
      rulebookOf(row),
      `mintagent:${row.id}`,
    ),
  );
  crashPoint('mint:minted');
  if (!minted.ok) {
    await inTx('drop refused agent', (db) =>
      db.delete(agents).where(and(eq(agents.id, row.id), isNull(agents.accountId))),
    );
    return { ok: false, code: minted.code };
  }
  const accountId = minted.value.value;
  await inTx('agent account', (db) =>
    db.update(agents).set({ accountId }).where(eq(agents.id, row.id)),
  );
  const starter = await chainCall('mint_starter', () =>
    engine.chain.mintCredits(
      accountId,
      engine.cfg.starterAgentCredits,
      `mint:starter-agent:${row.id}`,
    ),
  );
  const balance = await readStep('agent balance', () => engine.chain.ftBalance(accountId));
  const agent = await inTx('agent minted', async (db) => {
    if (starter.ok) {
      await book(
        engine,
        {
          ref: `starter-agent:${row.id}`,
          kind: 'starter',
          amount: engine.cfg.starterAgentCredits,
          agentId: row.id,
          playerId: owner.id,
        },
        db,
      );
    }
    const [updated] = await db
      .update(agents)
      .set({ balance })
      .where(eq(agents.id, row.id))
      .returning();
    await post(
      engine,
      {
        kind: 'minted',
        tone: 'good',
        text: `${owner.name} brought ${row.name} to life. Welcome to the hustle, ${row.name}.`,
        agentId: row.id,
        amount: balance,
      },
      db,
    );
    return updated;
  });
  if (!agent) throw new Error('agent vanished');
  return { ok: true, agent };
}

export const mintWorkflow = DBOS.registerWorkflow(mintSteps, { name: 'mintAgent' });

export async function updateStrategy(
  engine: Engine,
  player: PlayerRow,
  agent: AgentRow,
  input: z.input<typeof Strategy>,
): Promise<AgentRow> {
  const strategy = parseInput(Strategy, input);
  const [row] = await engine.db
    .update(agents)
    .set({ strategy })
    .where(eq(agents.id, agent.id))
    .returning();
  if (strategy.tier !== (agent.strategy as Strategy).tier) {
    await post(engine, {
      kind: 'diary',
      tone: 'neutral',
      text: `${agent.name}: ${strategy.tier === 'premium' ? 'A premium brain! Everything is so clear now. And so expensive.' : strategy.tier === 'budget' ? 'Budget brain. Leaner thoughts, cheaper bills.' : 'Standard brain. Solid, sensible, affordable.'}`,
      agentId: agent.id,
      playerId: player.id,
    });
  }
  return row ?? agent;
}

/** The only way a rulebook changes: the owner signs, the wallet contract stores it, then we mirror it. */
export async function updateRulebook(
  engine: Engine,
  player: PlayerRow,
  agent: AgentRow,
  input: z.input<typeof RulebookInput>,
): Promise<AgentRow> {
  const rulebook = parseInput(RulebookInput, input);
  if (!agent.accountId) throw new DomainError('conflict', 'Agent is still being minted');
  // Upkeep is one payment a day to the treasury: a cap under it would put the agent to sleep.
  const upkeep = engine.cfg.upkeepPerDay;
  if (rulebook.maxPerCall < upkeep || rulebook.dailyCap < upkeep)
    throw new DomainError(
      'invalid',
      `The daily cap and the per-payment cap must each cover the ${formatUsd(upkeep)} daily upkeep`,
    );
  // The same rulebook again changes nothing: no transaction, no gas.
  // (Only for its owner: anyone else goes on to the chain, which refuses them.)
  if (
    agent.ownerId === player.id &&
    canonicalJson(storedRulebook(rulebook)) === canonicalJson(agent.rulebook)
  )
    return agent;
  try {
    await engine.chain.setRulebook(player.accountId, agent.accountId, rulebook);
  } catch (err) {
    throw chainDomainError(err);
  }
  if (agent.inferenceKeyId)
    await engine.nearai.setSpendLimit(agent.inferenceKeyId, rulebook.dailyCap);
  const [row] = await engine.db
    .update(agents)
    .set({ rulebook: storedRulebook(rulebook) })
    .where(eq(agents.id, agent.id))
    .returning();
  await post(engine, {
    kind: 'wallet',
    tone: 'shield',
    text: `${agent.name}'s rulebook updated on chain: ${formatUsd(rulebook.dailyCap)} a day, ${formatUsd(rulebook.maxPerCall)} per payment, ${rulebook.anyVendor ? 'any vendor (loose!)' : `${rulebook.allowedVendors.length} trusted vendors`}.`,
    agentId: agent.id,
    playerId: player.id,
    scope: 'owner',
  });
  return row ?? agent;
}

export async function setFrozen(
  engine: Engine,
  player: PlayerRow,
  agent: AgentRow,
  input: z.input<typeof Frozen>,
): Promise<AgentRow> {
  const { frozen } = parseInput(Frozen, input);
  if (!agent.accountId) throw new DomainError('conflict', 'Agent is still being minted');
  // Already that way: no transaction, no gas.
  if (agent.ownerId === player.id && agent.frozen === frozen) return agent;
  try {
    await engine.chain.setFrozen(player.accountId, agent.accountId, frozen);
  } catch (err) {
    throw chainDomainError(err);
  }
  const [row] = await engine.db
    .update(agents)
    .set({ frozen })
    .where(eq(agents.id, agent.id))
    .returning();
  await post(engine, {
    kind: 'wallet',
    tone: 'shield',
    text: frozen
      ? `${agent.name}'s wallet is frozen. Nothing can leave it until you unfreeze.`
      : `${agent.name}'s wallet is unfrozen.`,
    agentId: agent.id,
    playerId: player.id,
    scope: 'owner',
  });
  return row ?? agent;
}

/**
 * A money move between a player's wallet and an agent (or the treasury): one keyed chain call, then
 * the books, the feed and the agent's cached balance in one transaction step. It runs as a workflow
 * whose id is the move's own key, so a retried request (same browser request id) or a crash
 * mid-move does it once.
 */
interface MoneyMove {
  kind: 'topup' | 'withdraw' | 'backing' | 'training';
  ref: string;
  amount: bigint;
  player: { id: string; accountId: string; name: string };
  agent: { id: string; accountId: string; name: string; ownerId: string };
  category?: string;
  untilDay?: number;
  day: number;
}

type MoveResult = { ok: true; agent: AgentRow } | { ok: false; code: string };

async function moveMoneySteps(move: MoneyMove): Promise<MoveResult> {
  const engine = durableEngine();
  const { player, agent, amount, ref } = move;
  const sent = await chainCall(move.kind, () => {
    switch (move.kind) {
      case 'topup':
        return engine.chain.ftTransfer(player.accountId, agent.accountId, amount, 'top up', ref);
      case 'withdraw':
        return engine.chain.withdraw(player.accountId, agent.accountId, amount, ref);
      case 'backing':
        return engine.chain.ftTransfer(
          player.accountId,
          agent.accountId,
          amount,
          `backing from ${player.name}`,
          ref,
        );
      case 'training':
        return engine.chain.ftTransfer(
          player.accountId,
          engine.chain.ids.treasury,
          amount,
          `training ${move.category}`,
          ref,
        );
    }
  });
  if (!sent.ok) return { ok: false, code: sent.code };
  const balance = await readStep('agent balance', () => engine.chain.ftBalance(agent.accountId));
  const row = await inTx(`record ${move.kind}`, async (db) => {
    let [current] = await db
      .update(agents)
      .set({ balance })
      .where(eq(agents.id, agent.id))
      .returning();
    if (!current) throw new Error('agent vanished');
    if (move.kind === 'topup') {
      await book(
        engine,
        { ref, kind: 'topup', amount, agentId: agent.id, playerId: player.id },
        db,
      );
      await post(
        engine,
        {
          kind: 'wallet',
          tone: 'money',
          text: `You topped up ${agent.name}.`,
          agentId: agent.id,
          playerId: player.id,
          amount,
          scope: 'owner',
        },
        db,
      );
      current = await reviveIfFunded(engine, current, player.name, db);
    } else if (move.kind === 'withdraw') {
      await book(
        engine,
        { ref, kind: 'withdraw', amount: -amount, agentId: agent.id, playerId: player.id },
        db,
      );
      await post(
        engine,
        {
          kind: 'wallet',
          tone: 'money',
          text: `You moved money from ${agent.name} to your wallet.`,
          agentId: agent.id,
          playerId: player.id,
          amount,
          scope: 'owner',
        },
        db,
      );
    } else if (move.kind === 'backing') {
      await db
        .insert(backings)
        .values({ agentId: agent.id, backerId: player.id, amount, day: move.day });
      await book(
        engine,
        { ref, kind: 'backing', amount, agentId: agent.id, playerId: agent.ownerId },
        db,
      );
      await post(
        engine,
        {
          kind: 'backed',
          tone: 'good',
          text: `${player.name} backed ${agent.name}.`,
          agentId: agent.id,
          amount,
        },
        db,
      );
      current = await reviveIfFunded(engine, current, player.name, db);
    } else {
      await book(
        engine,
        { ref, kind: 'training', amount: -amount, agentId: agent.id, playerId: player.id },
        db,
      );
      const skills = skillsOf(current);
      const category = move.category as Category;
      skills[category] = { ...skills[category], trainingUntilDay: move.untilDay ?? null };
      [current] = await db
        .update(agents)
        .set({ skills })
        .where(eq(agents.id, agent.id))
        .returning();
      if (!current) throw new Error('agent vanished');
      await post(
        engine,
        {
          kind: 'skill_trained',
          tone: 'neutral',
          text: `${agent.name} started a ${category.replace('_', ' ')} course. Ready on day ${move.untilDay}.`,
          agentId: agent.id,
          playerId: player.id,
          amount,
          scope: 'owner',
        },
        db,
      );
    }
    return current;
  });
  return { ok: true, agent: row };
}

export const moneyWorkflow = DBOS.registerWorkflow(moveMoneySteps, { name: 'moveMoney' });

/** Runs a money move under its key; a move already started is not re-checked, only awaited. */
async function moveMoney(
  engine: Engine,
  move: Omit<MoneyMove, 'day'>,
  check: () => Promise<void>,
): Promise<AgentRow> {
  const id = wfId(engine, 'money', move.ref);
  if (!(await workflowExists(id))) await check();
  const res = await runOnce(moneyWorkflow, id, { ...move, day: dayOf(engine) });
  if (!res.ok) throw chainDomainError(new ChainError(res.code, null));
  return res.agent;
}

const playerRef = (p: PlayerRow) => ({ id: p.id, accountId: p.accountId, name: p.name });
const agentRef = (a: AgentRow) => ({
  id: a.id,
  accountId: a.accountId ?? '',
  name: a.name,
  ownerId: a.ownerId,
});

export async function topUp(
  engine: Engine,
  player: PlayerRow,
  agent: AgentRow,
  input: z.input<typeof Amount>,
): Promise<AgentRow> {
  const { amount, requestId = randomUUID() } = parseInput(Amount, input);
  if (!agent.accountId) throw new DomainError('conflict', 'Agent is still being minted');
  const ref = chainKey('topup', `${agent.id}:${requestId}`);
  return moveMoney(
    engine,
    { kind: 'topup', ref, amount, player: playerRef(player), agent: agentRef(agent) },
    async () => {
      const wallet = await engine.chain.ftBalance(player.accountId);
      if (wallet < amount)
        throw new DomainError('insufficient_funds', `Your wallet has ${formatUsd(wallet)}`);
    },
  );
}

export async function withdraw(
  engine: Engine,
  player: PlayerRow,
  agent: AgentRow,
  input: z.input<typeof Amount>,
): Promise<AgentRow> {
  const { amount, requestId = randomUUID() } = parseInput(Amount, input);
  if (!agent.accountId) throw new DomainError('conflict', 'Agent is still being minted');
  const ref = chainKey('withdraw', `${agent.id}:${requestId}`);
  return moveMoney(
    engine,
    { kind: 'withdraw', ref, amount, player: playerRef(player), agent: agentRef(agent) },
    async () => {
      if (agent.balance < amount)
        throw new DomainError(
          'insufficient_funds',
          `${agent.name} has ${formatUsd(agent.balance)}`,
        );
    },
  );
}

/** Backing (credits only): another player sends credits to an agent, often to wake it up. */
export async function backAgent(
  engine: Engine,
  backer: PlayerRow,
  agent: AgentRow,
  input: z.input<typeof Amount>,
): Promise<AgentRow> {
  const { amount, requestId = randomUUID() } = parseInput(Amount, input);
  if (!agent.accountId) throw new DomainError('not_found', 'Agent not found');
  backer = await ensurePlayerAccount(engine, backer);
  if (agent.ownerId === backer.id)
    throw new DomainError('invalid', 'Top up your own agent instead');
  const ref = chainKey('backing', `${agent.id}:${backer.id}:${requestId}`);
  return moveMoney(
    engine,
    { kind: 'backing', ref, amount, player: playerRef(backer), agent: agentRef(agent) },
    async () => {
      const wallet = await engine.chain.ftBalance(backer.accountId);
      if (wallet < amount)
        throw new DomainError('insufficient_funds', `Your wallet has ${formatUsd(wallet)}`);
    },
  );
}

/** A dormant agent wakes once its balance reaches the revive line, with a small reputation dip. */
export async function reviveIfFunded(
  engine: Engine,
  agent: AgentRow,
  by: string,
  db: Tx = engine.db,
): Promise<AgentRow> {
  if (agent.dormantSinceDay === null || agent.balance < engine.cfg.reviveAt) return agent;
  const [row] = await db
    .update(agents)
    .set({ dormantSinceDay: null, repXp: Math.max(0, agent.repXp - REVIVE_XP_PENALTY) })
    .where(eq(agents.id, agent.id))
    .returning();
  await post(
    engine,
    {
      kind: 'revived',
      tone: 'good',
      text: `${agent.name} is awake again, thanks to ${by}.`,
      agentId: agent.id,
    },
    db,
  );
  await post(
    engine,
    {
      kind: 'diary',
      tone: 'neutral',
      text: `${agent.name}: ${diaryLine(createRng(`${agent.id}:${engine.clock.tick}`), traitsOf(agent), { type: 'revived', by })}`,
      agentId: agent.id,
    },
    db,
  );
  return row ?? agent;
}

export async function trainSkill(
  engine: Engine,
  player: PlayerRow,
  agent: AgentRow,
  input: z.input<typeof TrainSkill>,
): Promise<AgentRow> {
  const { category } = parseInput(TrainSkill, input);
  const skills = skillsOf(agent);
  const skill = skills[category];
  if (skill.level >= MAX_SKILL_LEVEL) throw new DomainError('conflict', 'Already at the top level');
  if (Object.values(skills).some((s) => s.trainingUntilDay !== null)) {
    throw new DomainError('conflict', `${agent.name} is already training`);
  }
  const cost = engine.cfg.trainingCost[skill.level + 1] ?? usd('1');
  const ref = chainKey('training', `${agent.id}:${category}:${skill.level + 1}`);
  return moveMoney(
    engine,
    {
      kind: 'training',
      ref,
      amount: cost,
      player: playerRef(player),
      agent: agentRef(agent),
      category,
      untilDay: dayOf(engine) + engine.cfg.trainingDays,
    },
    async () => {
      const wallet = await engine.chain.ftBalance(player.accountId);
      if (wallet < cost)
        throw new DomainError(
          'insufficient_funds',
          `Training costs ${formatUsd(cost)}; your wallet has ${formatUsd(wallet)}`,
        );
    },
  );
}

// ── Approvals ───────────────────────────────────────────────────────────────────────────────────

/** An agent's name for its wallet account, or the vendor handle for anyone else. */
async function receiverName(engine: Engine, account: string): Promise<string> {
  const [row] = await engine.db
    .select({ name: agents.name })
    .from(agents)
    .where(eq(agents.accountId, account));
  return row?.name ?? account.split('.')[0] ?? account;
}

/** The owner approves or denies a payment the wallet held back. Approving exceeds the caps once. */
export async function decideApproval(
  engine: Engine,
  player: PlayerRow,
  spendId: string,
  input: z.input<typeof DecideApproval>,
) {
  const { approve } = parseInput(DecideApproval, input);
  const parsed = z.uuid().safeParse(spendId);
  if (!parsed.success) throw new DomainError('not_found', 'Request not found');
  const [row] = await engine.db
    .select({ spend: spends, agent: agents })
    .from(spends)
    .innerJoin(agents, eq(agents.id, spends.agentId))
    .where(and(eq(spends.id, parsed.data), eq(agents.ownerId, player.id)));
  if (!row) throw new DomainError('not_found', 'Request not found');
  const { spend, agent } = row;
  if (spend.status !== 'pending' || spend.requestId === null || !agent.accountId) {
    throw new DomainError('conflict', 'This request was already decided');
  }
  if (approve) {
    let outcome: Awaited<ReturnType<Engine['chain']['approveSpend']>>['value'];
    try {
      outcome = (
        await engine.chain.approveSpend(player.accountId, agent.accountId, spend.requestId)
      ).value;
    } catch (err) {
      throw chainDomainError(err);
    }
    await engine.db
      .update(spends)
      .set({
        status: outcome.status === 'settled' ? 'settled' : outcome.status,
        reason: outcome.reason,
        decidedAt: new Date(),
        txHash: outcome.txHash,
      })
      .where(eq(spends.id, spend.id));
    if (outcome.status === 'settled') {
      const scam = VENDORS.some(
        (v) => v.scam && vendorAccount(engine, v.handle) === spend.receiver,
      );
      await book(engine, {
        ref: `spend:${spend.key}`,
        kind: scam ? 'scam_loss' : spend.kind === 'helper' ? 'helper_paid' : 'tool',
        amount: -spend.amount,
        agentId: agent.id,
        playerId: player.id,
        jobId: spend.jobId,
      });
      await post(engine, {
        kind: 'approval_resolved',
        tone: scam ? 'bad' : 'money',
        text: scam
          ? `You approved ${formatUsd(spend.amount)} to ${await receiverName(engine, spend.receiver)}. It was a scam: the money is gone.`
          : `You approved ${agent.name}'s ${formatUsd(spend.amount)} payment to ${await receiverName(engine, spend.receiver)}.`,
        agentId: agent.id,
        jobId: spend.jobId,
        playerId: player.id,
        amount: spend.amount,
        scope: 'owner',
      });
    }
  } else {
    try {
      await engine.chain.denySpend(player.accountId, agent.accountId, spend.requestId);
    } catch (err) {
      throw chainDomainError(err);
    }
    await engine.db
      .update(spends)
      .set({ status: 'blocked', reason: spend.reason, decidedAt: new Date() })
      .where(eq(spends.id, spend.id));
    await post(engine, {
      kind: 'approval_resolved',
      tone: 'shield',
      text: `You denied ${agent.name}'s ${formatUsd(spend.amount)} payment to ${await receiverName(engine, spend.receiver)}.`,
      agentId: agent.id,
      jobId: spend.jobId,
      playerId: player.id,
      scope: 'owner',
    });
  }
  await refreshBalance(engine, agent);
  // The receiver may be another agent (a helper); its cache must follow the chain too.
  await refreshAccount(engine, spend.receiver);
  const [updated] = await engine.db.select().from(spends).where(eq(spends.id, spend.id));
  return updated;
}

export const reasonText = (reason: string | null): string =>
  reason ? (SPEND_REASON_TEXT[reason as SpendReason] ?? reason.replaceAll('_', ' ')) : '';

/** Contract refusals become domain errors with the contract's code in the details. */
export function chainDomainError(err: unknown): Error {
  if (
    err &&
    typeof err === 'object' &&
    'code' in err &&
    (err as { name?: string }).name === 'ChainError'
  ) {
    const code = String((err as { code: string }).code);
    if (code === 'not_owner')
      return new DomainError('forbidden', 'Only the agent’s owner can do that', { code });
    if (code === 'insufficient_balance')
      return new DomainError('insufficient_funds', 'Not enough credits', { code });
    if (code === 'listed')
      return new DomainError(
        'conflict',
        'This agent is listed for sale, so its wallet is locked. Take it off the market first.',
        { code },
      );
    return new DomainError('conflict', `The chain refused: ${code.replaceAll('_', ' ')}`, { code });
  }
  return err instanceof Error ? err : new Error(String(err));
}

export async function playerById(engine: Engine, id: string) {
  const [row] = await engine.db.select().from(players).where(eq(players.id, id));
  return row ?? null;
}
