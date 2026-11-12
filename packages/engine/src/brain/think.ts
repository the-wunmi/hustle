import { nanoToMicroCeil, openSecret, sealSecret, sha256Hex } from '@hustle/core';
import { agents, inferenceCalls, players, spends } from '@hustle/db';
import { callCostMicro } from '@hustle/economy';
import {
  type AttestationReport,
  freshNonce,
  NearAiError,
  REASONING_BUDGET,
  verifyCompletion,
} from '@hustle/nearai';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { type AgentRow, refreshBalance, rulebookOf, tierOf } from '../agents/state.ts';
import { dayOf, type Engine } from '../context.ts';
import { book, chainKey, post } from '../record.ts';
import { reserveLive, settleLive } from './budget.ts';
import {
  type BrainContext,
  buildMessages,
  OUTPUT,
  type OutputOf,
  type Purpose,
  SCHEMA_NAME,
} from './prompts.ts';

export type ThinkResult<T> =
  | { ok: true; output: T; cost: bigint; callId: string }
  | {
      ok: false;
      reason: 'funds' | 'capped' | 'unpaid' | 'unverified' | 'provider' | 'invalid_output';
    };

/** Most output tokens a call may request: caps the bill no matter what the model wants to write. */
const MAX_TOKENS = 6_000;
/**
 * How long a verified attestation is trusted for signatures that follow it. The docs require the
 * report to be fetched (with our nonce) before the completion it vouches for, so it is cached ahead.
 */
const ATTESTATION_TTL_MS = 10 * 60_000;

interface CachedAttestation {
  nonce: string;
  report: AttestationReport;
  fetchedAt: number;
}
const attestations = new WeakMap<Engine, Map<string, CachedAttestation>>();

async function attestationFor(
  engine: Engine,
  provider: Engine['nearai'],
  model: string,
): Promise<CachedAttestation> {
  const cacheKey = `${provider.mode}:${model}`;
  let byModel = attestations.get(engine);
  if (!byModel) {
    byModel = new Map();
    attestations.set(engine, byModel);
  }
  const cached = byModel.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < ATTESTATION_TTL_MS) return cached;
  const nonce = freshNonce();
  const fresh = {
    nonce,
    report: await provider.attestation(nonce, model),
    fetchedAt: Date.now(),
  };
  byModel.set(cacheKey, fresh);
  return fresh;
}

async function agentKey(engine: Engine, agent: AgentRow): Promise<string> {
  // A key the recorded brain issued (`key_…`) means nothing to the live API: make a live one.
  const issuedByRecorded = agent.inferenceKeyId?.startsWith('key_') ?? false;
  const stale = engine.nearai.mode === 'live' && issuedByRecorded;
  if (agent.inferenceKeyId && agent.inferenceKeySealed && !stale)
    return openSecret(engine.secret, agent.inferenceKeySealed);
  // The provider-side limit mirrors the wallet's daily cap, so even a runaway loop stops at the provider.
  const key = await engine.nearai.createAgentKey(agent.name, rulebookOf(agent).dailyCap);
  await engine.db
    .update(agents)
    .set({ inferenceKeyId: key.id, inferenceKeySealed: sealSecret(engine.secret, key.key) })
    .where(eq(agents.id, agent.id));
  return key.key;
}

const recordedKeys = new WeakMap<Engine, string>();

/** The recorded brain's own key (it checks keys like the real API does), made once per engine. */
async function recordedKey(engine: Engine): Promise<string> {
  let key = recordedKeys.get(engine);
  if (!key) {
    key = (await engine.recordedBrain.createAgentKey('recorded brain', 10n ** 15n)).key;
    recordedKeys.set(engine, key);
  }
  return key;
}

/**
 * `live` when NEAR AI Cloud is live and the agent belongs to a real player; house and rival agents
 * always think with the recorded brain, so the org's budget goes to the people playing.
 */
export async function brainSourceFor(
  engine: Engine,
  agent: AgentRow,
): Promise<'live' | 'recorded'> {
  if (engine.nearai.mode !== 'live') return 'recorded';
  const [owner] = await engine.db
    .select({ isHouse: players.isHouse })
    .from(players)
    .where(eq(players.id, agent.ownerId));
  return owner && !owner.isHouse ? 'live' : 'recorded';
}

/** Whether the wallet would accept a debit of `estimate` right now; checked before paying a provider. */
async function walletWouldPay(engine: Engine, agent: AgentRow, estimate: bigint): Promise<boolean> {
  const wallet = await engine.chain.getWallet(agent.accountId ?? '');
  return (
    !wallet.frozen &&
    estimate <= wallet.rulebook.maxPerCall &&
    wallet.spentToday + estimate <= wallet.rulebook.dailyCap
  );
}

/**
 * One metered, attested model call made by an agent and paid from its own wallet:
 * check the wallet would pay → make sure we hold a verified attestation fetched with our own nonce →
 * call NEAR AI Cloud with the agent's key → read the exact cost → verify the response signature
 * against that attestation → debit the wallet (`spend(kind: inference)`) with the signature hash as
 * the receipt. `key` makes the step happen once: a retry returns the stored result, paid or refused.
 */
export async function think<P extends Purpose>(
  engine: Engine,
  agent: AgentRow,
  key: string,
  jobId: string | null,
  ctx: BrainContext<P>,
  jobBody: string,
): Promise<ThinkResult<OutputOf<P>>> {
  const [prior] = await engine.db.select().from(inferenceCalls).where(eq(inferenceCalls.key, key));
  if (prior?.status === 'done') {
    if (prior.output) {
      return {
        ok: true,
        output: prior.output as OutputOf<P>,
        cost: prior.cost ?? 0n,
        callId: prior.id,
      };
    }
    // Final: a refused, unverified or failed call is not re-run (that would bill the provider again).
    const passed = (prior.verification as { passed?: boolean } | null)?.passed;
    return { ok: false, reason: passed === false ? 'unverified' : 'unpaid' };
  }
  const tier = tierOf(agent);
  const brain = engine.brains[tier];
  const estimate = callCostMicro(brain, { purpose: ctx.purpose, ...ctx.workload });
  if (!agent.accountId || agent.balance < estimate) return { ok: false, reason: 'funds' };
  if (!(await walletWouldPay(engine, agent, estimate))) return { ok: false, reason: 'capped' };
  const maxTokens = Math.min(MAX_TOKENS, ctx.workload.outTokens * 2) + REASONING_BUDGET;

  // Which brain answers: live NEAR AI Cloud for a real player's agent while today's live budget
  // lasts (the call's worst case is reserved first), the recorded brain otherwise.
  const source = await brainSourceFor(engine, agent);
  const worstNano =
    source === 'live'
      ? ((BigInt(Math.ceil(ctx.workload.inTokens * 1.5)) * brain.inputPerM +
          BigInt(maxTokens) * brain.outputPerM) *
          1000n) /
        1_000_000n
      : 0n;
  const reservedDay = source === 'live' ? await reserveLive(engine, worstNano) : null;
  const live = source === 'live' && reservedDay !== null;
  const provider = live ? engine.nearai : engine.recordedBrain;
  const settleBudget = async (nano: bigint | undefined) => {
    if (reservedDay) await settleLive(engine, reservedDay, worstNano, nano ?? worstNano);
  };

  // A row left `started` means the process stopped mid-call: the provider may have billed, so this
  // retry is a known re-bill risk, recorded rather than hidden.
  const [row] = prior
    ? await engine.db
        .update(inferenceCalls)
        .set({ status: 'in_doubt' })
        .where(eq(inferenceCalls.id, prior.id))
        .returning()
    : await engine.db
        .insert(inferenceCalls)
        .values({
          key,
          agentId: agent.id,
          jobId,
          purpose: ctx.purpose,
          model: brain.model,
          tier,
          source: live ? 'live' : 'recorded',
          status: 'started',
          tick: engine.clock.tick,
        })
        .returning();
  if (!row) throw new Error('inference row not written');

  let result: Awaited<ReturnType<Engine['nearai']['chat']>>;
  let attestation: CachedAttestation;
  try {
    attestation = await attestationFor(engine, provider, brain.model);
    // The agent's own key with the live (or, without a key, the only) provider; a shared key for the
    // recorded brain when it stands in for a live build.
    const apiKey =
      provider === engine.nearai ? await agentKey(engine, agent) : await recordedKey(engine);
    result = await provider.chat(apiKey, {
      model: brain.model,
      messages: buildMessages(ctx, jobBody),
      max_tokens: maxTokens,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: SCHEMA_NAME[ctx.purpose],
          schema: z.toJSONSchema(OUTPUT[ctx.purpose]),
        },
      },
    });
  } catch (err) {
    if (err instanceof NearAiError) {
      // A call the provider handled before it failed (a reasoning model that ran out of tokens
      // answers with no content) was still billed: it counts against the budget, never the agent.
      const billed = err.inferenceId
        ? (await provider.costs([err.inferenceId]).catch((): Record<string, bigint> => ({})))[
            err.inferenceId
          ]
        : 0n;
      await settleBudget(billed);
      engine.log('inference failed', { agent: agent.name, code: err.code });
      await engine.db
        .update(inferenceCalls)
        .set({ status: 'done' })
        .where(eq(inferenceCalls.id, row.id));
      return { ok: false, reason: 'provider' };
    }
    throw err;
  }

  const nano = (await provider.costs([result.inferenceId]))[result.inferenceId];
  await settleBudget(nano);
  // No cost from billing yet: charge the estimate rather than nothing. A zero-cost call still moves
  // one micro-USD, because the wallet refuses zero transfers; the ledger books the same amount.
  const metered = nano === undefined ? estimate : nanoToMicroCeil(nano);
  const cost = metered > 0n ? metered : 1n;
  const signature = await provider.signature(result.chatId);
  const verification = verifyCompletion(
    live ? 'live' : 'simulated',
    result,
    signature,
    attestation.report,
    attestation.nonce,
  );
  const callFields = {
    inferenceId: result.inferenceId,
    chatId: result.chatId,
    promptTokens: result.promptTokens,
    completionTokens: result.completionTokens,
    reasoningTokens: result.reasoningTokens,
    costNano: nano ?? null,
    cost,
    requestHash: sha256Hex(result.requestBody),
    responseHash: sha256Hex(result.responseBody),
    verification,
  };

  if (!verification.passed) {
    // A reply that fails its checks is never used and never charged to the agent; Hustle absorbs it.
    await engine.db
      .update(inferenceCalls)
      .set({ ...callFields, cost: 0n, status: 'done', output: null })
      .where(eq(inferenceCalls.id, row.id));
    await post(engine, {
      kind: 'spend_blocked',
      tone: 'shield',
      text: `A reply for ${agent.name} failed verification, so it was discarded. ${agent.name} wasn't charged.`,
      agentId: agent.id,
      jobId,
      playerId: agent.ownerId,
      scope: 'owner',
    });
    return { ok: false, reason: 'unverified' };
  }

  const spendKey = chainKey('inf', key);
  const receipt = sha256Hex(signature.signature);
  const outcome = await engine.chain.spend(agent.accountId, {
    key: spendKey,
    kind: 'inference',
    receiverId: engine.chain.ids.treasury,
    amount: cost,
    jobId,
    memo: `${ctx.purpose} ${brain.model}`.slice(0, 120),
    receipt,
  });
  await engine.db
    .insert(spends)
    .values({
      key: spendKey,
      agentId: agent.id,
      jobId,
      kind: 'inference',
      receiver: engine.chain.ids.treasury,
      amount: cost,
      status: outcome.status,
      reason: outcome.reason,
      requestId: outcome.requestId,
      memo: `${ctx.purpose} (${brain.model})`,
      receipt,
      txHash: outcome.txHash,
      day: dayOf(engine),
      tick: engine.clock.tick,
    })
    .onConflictDoNothing();

  const parsed = parseOutput(ctx.purpose, result.content);
  await engine.db
    .update(inferenceCalls)
    .set({
      ...callFields,
      status: 'done',
      output: outcome.status === 'settled' && parsed ? parsed : null,
      spendKey,
    })
    .where(eq(inferenceCalls.id, row.id));
  await refreshBalance(engine, agent);

  if (outcome.status !== 'settled') {
    // The wallet refused to pay: the work is discarded, so an agent never uses thinking it didn't pay for.
    await post(engine, {
      kind: 'spend_blocked',
      tone: 'shield',
      text: `${agent.name} couldn't pay for thinking: the rulebook's ${outcome.reason?.replaceAll('_', ' ') ?? 'limit'} stopped it.`,
      agentId: agent.id,
      jobId,
      playerId: agent.ownerId,
      scope: 'owner',
    });
    return { ok: false, reason: 'unpaid' };
  }
  await book(engine, {
    ref: spendKey,
    kind: 'inference',
    amount: -cost,
    agentId: agent.id,
    playerId: agent.ownerId,
    jobId,
  });
  if (!parsed) return { ok: false, reason: 'invalid_output' };
  return { ok: true, output: parsed as OutputOf<P>, cost, callId: row.id };
}

function parseOutput(purpose: Purpose, content: string): unknown {
  try {
    const parsed = OUTPUT[purpose].safeParse(JSON.parse(content));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
