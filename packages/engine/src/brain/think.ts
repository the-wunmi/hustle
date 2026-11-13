import { nanoToMicroCeil, openSecret, sealSecret, sha256Hex } from '@hustle/core';
import { agents, inferenceCalls, spends } from '@hustle/db';
import { callCostMicro } from '@hustle/economy';
import {
  type AttestationReport,
  freshNonce,
  NearAiError,
  type ProviderTool,
  type ProviderToolResult,
  REASONING_BUDGET,
  verifyCompletion,
} from '@hustle/nearai';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { type AgentRow, refreshBalance, rulebookOf, tierOf } from '../agents/state.ts';
import { dayOf, type Engine } from '../context.ts';
import { book, chainKey, post } from '../record.ts';
import { reserveLive, settleLive, toolBudgetNano } from './budget.ts';
import {
  type BrainContext,
  buildMessages,
  MAX_TOOL_NOTES,
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

/**
 * Tools the provider runs during a `tool` call. The agent pays the billed tokens plus `feePerUse`
 * for each billable use, which the provider bills apart from tokens.
 */
export interface CallTools {
  provider: ProviderTool[];
  feePerUse: bigint;
  /** Uses to expect in one call, for the estimate checked against the wallet before calling. */
  expectedUses: number;
  /** Billable uses in a call's results. */
  uses: (results: ProviderToolResult[]) => number;
  /** The sources a call's results name, kept on the receipt so anyone can check them. */
  sources: (results: ProviderToolResult[]) => { title: string; url: string }[];
}

/** Uses reserved against the live AI budget for one tool call (the provider may search more than once). */
const WORST_TOOL_USES = 3;

/** Most output tokens a call may request: caps the bill no matter what the model wants to write. */
const MAX_TOKENS = 6_000;
/**
 * How long a verified attestation is trusted for signatures that follow it. The docs require the
 * report to be fetched (with our nonce) before the completion it vouches for, so it is cached ahead.
 */
const ATTESTATION_TTL_MS = 10 * 60_000;

export interface CachedAttestation {
  nonce: string;
  report: AttestationReport;
  fetchedAt: number;
}
const attestations = new WeakMap<Engine, Map<string, CachedAttestation>>();

export async function attestationFor(
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
  return engine.houseOwners.has(agent.ownerId) ? 'recorded' : 'live';
}

/** Whether the wallet would accept a debit of `estimate` right now; checked before paying a provider. */
async function walletWouldPay(
  engine: Engine,
  agent: AgentRow,
  estimate: bigint,
  jobId: string | null,
): Promise<boolean> {
  const wallet = await engine.chain.getWallet(agent.accountId ?? '');
  const jobSpent = jobId ? (wallet.jobSpent[jobId] ?? 0n) : 0n;
  return (
    !wallet.frozen &&
    estimate <= wallet.rulebook.maxPerCall &&
    (jobId === null || jobSpent + estimate <= wallet.rulebook.maxPerJob) &&
    // Leave the day's upkeep inside the daily cap, or the agent sleeps at day end with money left.
    wallet.spentToday + estimate + engine.cfg.upkeepPerDay <= wallet.rulebook.dailyCap
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
  tools?: CallTools,
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
  if (prior?.status === 'in_doubt') {
    // Already retried once after an interrupted call: a second retry would risk a third bill. The
    // agent goes without; the provider's charges for the lost tries were never passed on to it.
    await engine.db
      .update(inferenceCalls)
      .set({ status: 'done' })
      .where(eq(inferenceCalls.id, prior.id));
    return { ok: false, reason: 'provider' };
  }
  const tier = tierOf(agent);
  const brain = engine.brains[tier];
  const estimate =
    callCostMicro(brain, { purpose: ctx.purpose, ...ctx.workload }) +
    (tools?.feePerUse ?? 0n) * BigInt(tools?.expectedUses ?? 0);
  if (!agent.accountId || agent.balance < estimate) return { ok: false, reason: 'funds' };
  if (!(await walletWouldPay(engine, agent, estimate, jobId)))
    return { ok: false, reason: 'capped' };
  const maxTokens = Math.min(MAX_TOKENS, ctx.workload.outTokens * 2) + REASONING_BUDGET;

  // Which brain answers: live NEAR AI Cloud for a real player's agent while today's live budget
  // lasts (the call's worst case is reserved first), the recorded brain otherwise.
  const source = await brainSourceFor(engine, agent);
  const worstNano =
    source === 'live'
      ? ((BigInt(Math.ceil(ctx.workload.inTokens * 1.5)) * brain.inputPerM +
          BigInt(maxTokens) * brain.outputPerM) *
          1000n) /
          1_000_000n +
        (tools?.feePerUse ?? 0n) *
          1000n *
          BigInt(Math.max(WORST_TOOL_USES, (tools?.expectedUses ?? 0) * 2))
      : 0n;
  // Tool calls draw on their own share of the day's budget; a refusal closes tools until it frees up.
  const reservedDay =
    source === 'live'
      ? await reserveLive(engine, worstNano, tools ? toolBudgetNano(engine) : undefined)
      : null;
  if (tools && !reservedDay) engine.toolsOpen = false;
  const live = source === 'live' && reservedDay !== null;
  // Provider tools are real work only a live provider does: the recorded brain never stands in.
  if (tools && !live) return { ok: false, reason: 'provider' };
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
      // Provider tools don't run alongside a response schema, and code reads better outside JSON:
      // those calls answer in plain text and are parsed here.
      ...(tools
        ? { tools: tools.provider }
        : PLAIN_TEXT[ctx.purpose]
          ? {}
          : {
              response_format: {
                type: 'json_schema' as const,
                json_schema: {
                  name: SCHEMA_NAME[ctx.purpose],
                  schema: z.toJSONSchema(OUTPUT[ctx.purpose]),
                },
              },
            }),
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

  const tokenNano = (await provider.costs([result.inferenceId]))[result.inferenceId];
  // The provider bills tool uses apart from tokens (`/v1/billing/costs` leaves them out: verified
  // 2026-11-13), so they are added at the listed fee.
  const toolResults = result.toolResults ?? [];
  const toolUses = tools ? tools.uses(toolResults) : 0;
  const toolFee = (tools?.feePerUse ?? 0n) * BigInt(toolUses);
  const nano = tokenNano === undefined ? undefined : tokenNano + toolFee * 1000n;
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

  const parsed = tools
    ? (OUTPUT[ctx.purpose].safeParse({
        notes: result.content.trim().slice(0, MAX_TOOL_NOTES),
        sources: tools.sources(toolResults),
        uses: toolUses,
      }).data ?? null)
    : PLAIN_TEXT[ctx.purpose]
      ? (OUTPUT[ctx.purpose].safeParse(PLAIN_TEXT[ctx.purpose]?.(result.content)).data ?? null)
      : parseOutput(ctx.purpose, result.content);
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

/**
 * Purposes answered in plain text instead of JSON, with their parser. A coding turn is a fenced
 * Python block to run, or `DONE` and its notes: models write code far better outside a JSON string
 * (seen live 2026-11-13: a model escaping code into JSON fell into a repetition loop).
 */
const PLAIN_TEXT: Partial<Record<Purpose, (content: string) => unknown>> = {
  code: parseCodeReply,
  act: parseActReply,
};

/**
 * One loop turn: the thought before the first fenced block, the block's kind (`python`, `search`,
 * `chain`, `fetch`, `hire <name> <price> [files]`, `ask`, `write <file>`, `pay <payee> <amount>`,
 * `deliver`) and its text. No block is `none`.
 */
export function parseActReply(content: string): {
  thought: string;
  action: string;
  args: string;
  body: string;
  cut: boolean;
} {
  // Line by line: a block opens with three or more backticks and its kind, and closes only on a line
  // of at least as many backticks, so a write may hold ``` examples inside a ```` fence. The first
  // block whose kind is an action counts (a stray ```json before it doesn't spoil the turn).
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const open = /^\s*(`{3,})([a-z]+)[ \t]*(.*)$/i.exec(lines[i] ?? '');
    if (!open) continue;
    const kind = (open[2] ?? '').toLowerCase();
    const action = kind === 'py' ? 'python' : kind;
    const fence = open[1]?.length ?? 3;
    let end = i + 1;
    while (end < lines.length) {
      const close = /^\s*(`{3,})\s*$/.exec(lines[end] ?? '');
      if (close && (close[1]?.length ?? 0) >= fence) break;
      end++;
    }
    if (!ACT_KINDS.has(action)) {
      i = end;
      continue;
    }
    const body = lines.slice(i + 1, end).join('\n');
    return {
      thought: lines.slice(0, i).join('\n').trim().slice(0, 1_500),
      action,
      args: (open[3] ?? '').trim().slice(0, 200),
      body: body.slice(0, MAX_ACT_BODY),
      // No closing fence (the reply hit its length limit), or a body longer than a turn keeps.
      cut: end >= lines.length || body.length > MAX_ACT_BODY,
    };
  }
  return {
    thought: content.trim().slice(0, 1_500),
    action: 'none',
    args: '',
    body: '',
    cut: false,
  };
}

const ACT_KINDS = new Set([
  'python',
  'search',
  'chain',
  'fetch',
  'hire',
  'ask',
  'shell',
  'write',
  'pay',
  'deliver',
]);
/** Longest action body a turn keeps (an agent's file is at most this long too). */
const MAX_ACT_BODY = 100_000;

export function parseCodeReply(content: string): { code: string; done: boolean; notes: string } {
  const block = /```(?:python|py)?[ \t]*\n([\s\S]*?)```/i.exec(content);
  const code = block?.[1]?.trim() ?? '';
  // DONE counts only outside the code (a program may well say `DONE = True`).
  const prose = block ? content.replace(block[0], '') : content;
  const done = /^\s*DONE\b/im.test(prose) || !code;
  const notes = (done ? prose.replace(/^[\s\S]*?^\s*DONE\b[:\s]*/im, '') : prose)
    .trim()
    .slice(0, 3_000);
  return { code: done ? '' : code, done, notes };
}

function parseOutput(purpose: Purpose, content: string): unknown {
  try {
    const parsed = OUTPUT[purpose].safeParse(JSON.parse(content));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
