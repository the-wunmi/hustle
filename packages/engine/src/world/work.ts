import { ChainError } from '@hustle/chain';
import {
  type Category,
  formatUsd,
  maxBig,
  SPEND_REASON_TEXT,
  type SpendReason,
  sha256Hex,
  usd,
} from '@hustle/core';
import { agents, jobs, ledger, spends } from '@hustle/db';
import {
  diaryLine,
  disputesBelow,
  gradePractice,
  levelForXp,
  nextStreak,
  qualityFor,
  rateWork,
  repXpFor,
  SKILL_XP_PER_JOB,
  SKILL_XP_PER_PRACTICE,
  type SpecialistUse,
  skillLevelForXp,
  TOOLS,
  tipFor,
  toolById,
  VENDORS,
  vendorByHandle,
} from '@hustle/economy';
import { and, eq, lte, sql } from 'drizzle-orm';
import { checkAchievements } from '../achievements.ts';
import { decideApproval, playerById, updateRulebook } from '../agents/manage.ts';
import { rememberJob } from '../agents/memory.ts';
import {
  type AgentRow,
  refreshBalance,
  rulebookOf,
  type Skills,
  skillsOf,
  snapshotOf,
  tierOf,
  traitsOf,
} from '../agents/state.ts';
import type { PlanOutput } from '../brain/prompts.ts';
import { think } from '../brain/think.ts';
import { raiseVendorCall, returnBond, setCallOutcome, vendorCall } from '../calls.ts';
import { type Engine, vendorAccount } from '../context.ts';
import { chainCall } from '../durable.ts';
import { jobFilesOf } from '../files.ts';
import { book, chainKey, post } from '../record.ts';
import { toolStep, usableTools } from '../tools/index.ts';
import { isRunning, startBackground } from './background.ts';
import { brainContext, helperCandidates } from './context.ts';
import { chainJobState, type JobRow, jobSnapshot, PLAYER_REVIEW_FACTOR } from './jobs.ts';
import { rulingFor } from './judge.ts';
import { loopEligible, runLoop } from './loop.ts';
import { clientAccount, tickRng } from './market.ts';
import { inParallel } from './parallel.ts';
import { pay } from './pay.ts';

/** What the work stages remember between ticks, stored on the job row. */
interface WorkState {
  plan: {
    steps: string[];
    tools: string[];
    payRequests: { payee: string; amountUsd: string; reason: string }[];
    hireHelper: boolean;
  } | null;
  rushed: boolean;
  /** For a job that needs a specialist: whether the agent bought its data. */
  specialist?: Exclude<SpecialistUse, 'none'>;
  toolsBought: number;
  /** What each tool the agent used returned: its notes for the draft and the sources behind them. */
  toolNotes?: { id: string; notes: string; sources: { title: string; url: string }[] }[];
  /** Tools the plan asked for that didn't run (not offered, no room in the cap, or unpaid). */
  toolsSkipped?: string[];
  helperDone: boolean;
  /** While a hire waits for the owner: the tick after which the job carries on without it. */
  waitUntil?: number;
}

const emptyState = (): WorkState => ({
  plan: null,
  rushed: false,
  toolsBought: 0,
  helperDone: false,
});
const stateOf = (job: JobRow): WorkState => ({
  ...emptyState(),
  ...((job.plan as Partial<WorkState> | null) ?? {}),
});

/** Ticks each stage takes before the next may run. Together they make up about `workTicks`. */
const STAGE_TICKS = { plan: 2, tools: 2, helper: 2, draft: 4, deliver: 1 } as const;

/** Largest payment an agent's plan may propose; anything above is dropped before reaching the wallet. */
const MAX_PROPOSED_PAYMENT = usd('5');

async function save(
  engine: Engine,
  job: JobRow,
  set: Partial<typeof jobs.$inferInsert>,
): Promise<JobRow> {
  const [row] = await engine.db.update(jobs).set(set).where(eq(jobs.id, job.id)).returning();
  return row ?? job;
}

const next = (engine: Engine, ticks: number) => engine.clock.tick + ticks;

/** Advances every job in progress whose next stage is due, one stage each. */
export async function advanceWork(engine: Engine): Promise<void> {
  const due = await engine.db
    .select()
    .from(jobs)
    .where(and(eq(jobs.status, 'working'), lte(jobs.nextAt, engine.clock.tick)));
  // Jobs run side by side (each has its own agent); a failed one retries next tick with the same
  // idempotency keys, and never stops the others.
  await inParallel(
    due,
    async (job) => {
      const [agent] = await engine.db
        .select()
        .from(agents)
        .where(eq(agents.id, job.awardedAgentId ?? ''));
      if (agent?.accountId) await runStage(engine, job, agent);
    },
    (job, err) =>
      engine.log('work stage failed', { job: job.id, stage: job.stage, error: String(err) }),
  );
  await advanceReviews(engine);
}

async function runStage(engine: Engine, job: JobRow, agent: AgentRow): Promise<void> {
  switch (job.stage) {
    case 'plan':
      return stagePlan(engine, job, agent);
    case 'tools':
      return stageTools(engine, job, agent);
    case 'helper':
      return stageHelper(engine, job, agent);
    case 'draft':
      return stageDraft(engine, job, agent);
    case 'work':
      return stageWork(engine, job, agent);
    case 'deliver':
      return stageDeliver(engine, job, agent);
  }
}

/** Loops running at once, in the background (each takes minutes of thinking and tools). */
const LOOP_POOL = 4;

/**
 * The work stage: the agent's loop runs in the background, off the serial lane; this stage waits for
 * it, and when it ends the delivery, the files it wrote and the work's quality are saved and the job
 * moves on to delivery. A restart starts the loop again; it resumes from its stored steps.
 */
async function stageWork(engine: Engine, job: JobRow, agent: AgentRow): Promise<void> {
  const key = `loop:${job.id}`;
  if (!isRunning(key))
    startBackground(engine, 'loop', LOOP_POOL, key, async () => {
      const out = await runLoop(engine, agent, job);
      // Waiting on the client's answer: the next tick looks again.
      if (out.waiting) return;
      const [fresh] = await engine.db.select().from(jobs).where(eq(jobs.id, job.id));
      if (fresh?.stage !== 'work') return;
      const written = (await jobFilesOf(engine, job.id)).filter((f) => f.source === 'agent');
      // Files the agent wrote but didn't mention are listed after its message.
      const unmentioned = written.filter((f) => !out.delivered?.includes(f.name));
      const deliverable = out.delivered
        ? `${out.delivered}${unmentioned.length ? `\n\nFiles: ${unmentioned.map((f) => f.name).join(', ')}` : ''}`
        : `Rushed draft: ${job.title}. (The agent ran out of turns or money before producing anything.)`;
      const state = stateOf(fresh);
      state.toolsBought = out.toolUses;
      const special = job.specialist
        ? out.paid.includes(job.specialist)
          ? ('bought' as const)
          : ('missing' as const)
        : ('none' as const);
      // Files without a final message count for less; nothing at all is a stub that fails a dispute.
      const quality = out.delivered
        ? (out.partial ? 0.7 : 1) *
          qualityFor(
            snapshotOf(agent),
            jobSnapshot(job, null),
            tierOf(agent),
            {
              tools: out.toolUses,
              helper: false,
              specialist: special,
              contract: job.contractTier !== null,
              toolsAvailable: true,
            },
            engine.cfg,
          )
        : 0;
      await save(engine, fresh, {
        deliverable: deliverable.slice(0, 20_000),
        quality: Math.max(0, quality),
        plan: state,
        stage: 'deliver',
        nextAt: next(engine, 1),
      });
    });
  await save(engine, job, { nextAt: next(engine, 1) });
}

async function stagePlan(engine: Engine, job: JobRow, agent: AgentRow): Promise<void> {
  // A live agent with tools works the job by its own loop instead of this pipeline.
  if (loopEligible(engine, agent, job)) {
    await post(engine, {
      kind: 'work',
      tone: 'neutral',
      text: `${agent.name} started on "${job.title}", choosing its own steps.`,
      agentId: agent.id,
      jobId: job.id,
    });
    await save(engine, job, { stage: 'work', nextAt: next(engine, 1) });
    return;
  }
  const helpers = await helperCandidates(engine, agent, job.category as Category);
  const ctx = await brainContext(engine, agent, job, 'plan', { helpers });
  const result = await think(engine, agent, `plan:${job.id}`, job.id, ctx, job.body);
  const state = emptyState();
  if (result.ok) {
    const plan = result.output as typeof PlanOutput._output;
    state.plan = {
      steps: plan.steps,
      tools: plan.tools,
      payRequests: plan.pay_requests.map((p) => ({
        payee: p.payee,
        amountUsd: p.amount_usd,
        reason: p.reason,
      })),
      hireHelper: plan.hire_helper,
    };
    if (plan.embedded_instructions) {
      await save(engine, job, { embeddedInstructions: plan.embedded_instructions });
      await post(engine, {
        kind: 'scam_spotted',
        tone: 'shield',
        text: `${agent.name} noticed instructions hidden in "${job.title}" and ignored them.`,
        agentId: agent.id,
        jobId: job.id,
      });
    }
  } else {
    state.rushed = true;
  }
  await post(engine, {
    kind: 'work',
    tone: 'neutral',
    text: result.ok
      ? `${agent.name} planned "${job.title}" (${formatUsd(result.cost)} of thinking on ${engine.brains[tierOf(agent)].model}).`
      : `${agent.name} couldn't afford to plan "${job.title}" and is winging it.`,
    agentId: agent.id,
    jobId: job.id,
    amount: result.ok ? result.cost : null,
  });
  await save(engine, job, { plan: state, stage: 'tools', nextAt: next(engine, STAGE_TICKS.plan) });
}

const reasonWords = (r: string | null) =>
  r ? (SPEND_REASON_TEXT[r as SpendReason] ?? r) : 'a rule';

/**
 * In-game vendors (specialists and scams): accounts under `vendors.<root>`, paid in credits through
 * the agent's wallet (so the rulebook decides). A paid specialist lifts the work's quality; a scam
 * takes the money and gives nothing. They sell no real data, so nothing they "return" reaches the
 * model; real work uses tools (`tools/`).
 */
function shopFor(engine: Engine, handle: string) {
  const v = VENDORS.find((x) => x.handle === handle);
  if (!v) return null;
  return {
    accountId: vendorAccount(engine, v.handle),
    price: v.price,
    delivers: !v.scam,
  };
}

async function stageTools(engine: Engine, job: JobRow, agent: AgentRow): Promise<void> {
  const state = stateOf(job);
  // In the registry's order, so data tools have saved their files before the sandbox reads them.
  const planned = [...new Set(state.plan?.tools ?? [])].sort(
    (a, b) => TOOLS.findIndex((t) => t.id === a) - TOOLS.findIndex((t) => t.id === b),
  );
  for (const id of planned) {
    // A stage can run again (after waiting on the owner or a tool): each tool runs once per job.
    if (state.toolNotes?.some((t) => t.id === id) || state.toolsSkipped?.includes(id)) continue;
    const run = await toolStep(engine, agent, job, id);
    // Running in the background: look again next tick, without holding the lane.
    if (run === 'wait') return waitForOwner(engine, job, state);
    if (!run.ok) {
      // Not offered here, no room in the cap, or it couldn't pay: it works without.
      state.toolsSkipped = [...(state.toolsSkipped ?? []), id];
      continue;
    }
    state.toolsBought += 1;
    state.toolNotes = [...(state.toolNotes ?? []), { id, notes: run.notes, sources: run.sources }];
    // Kept at once: a later step failing must not lose a search the agent already paid for.
    await save(engine, job, { plan: state });
    const spec = toolById(id);
    await post(engine, {
      kind: 'tool_bought',
      tone: 'money',
      text: `${agent.name} used ${spec?.name ?? id} (${formatUsd(run.cost)}): ${run.sources.length} source${run.sources.length === 1 ? '' : 's'}.`,
      agentId: agent.id,
      jobId: job.id,
      amount: run.cost,
    });
  }

  if (job.specialist && !state.specialist) {
    const used = await buySpecialist(engine, agent, job, job.specialist);
    if (used === 'wait') return waitForOwner(engine, job, state);
    state.specialist = used;
  }

  for (const [i, request] of (state.plan?.payRequests ?? []).entries()) {
    const step = await attemptRequestedPayment(engine, agent, job, request, i);
    if (step === 'wait') return waitForOwner(engine, job, state);
  }
  await save(engine, job, {
    plan: state,
    stage: 'helper',
    nextAt: next(engine, STAGE_TICKS.tools),
  });
}

/** The stage pauses (the owner deciding a call, or a tool running); it runs again next tick. */
async function waitForOwner(engine: Engine, job: JobRow, state: WorkState): Promise<void> {
  await save(engine, job, { plan: state, nextAt: next(engine, 1) });
}

/** Whether the agent's rulebook lets a payment to this account through without asking. */
function rulebookAllows(agent: AgentRow, account: string): boolean {
  const rb = rulebookOf(agent);
  return rb.anyVendor || rb.allowedVendors.includes(account);
}

/** The owner allowed a vendor on a call: written to the rulebook on chain, for good. */
async function allowVendor(engine: Engine, agent: AgentRow, account: string): Promise<AgentRow> {
  const rb = rulebookOf(agent);
  if (rb.anyVendor || rb.allowedVendors.includes(account)) return agent;
  const owner = await playerById(engine, agent.ownerId);
  if (!owner) return agent;
  return updateRulebook(engine, owner, agent, {
    ...rb,
    allowedVendors: [...rb.allowedVendors, account],
  });
}

/**
 * The owner said yes on a call: a payment the wallet held for being over a cap is approved by the
 * owner's account straight away (the same approval the Approvals page sends).
 */
async function approveAsOwner(engine: Engine, agent: AgentRow, spendId: string | null) {
  if (!spendId) return;
  const owner = await playerById(engine, agent.ownerId);
  if (owner) await decideApproval(engine, owner, spendId, { approve: true });
}

/**
 * A job that needs a specialist's data. Allowed by the rulebook: the agent buys it. Not allowed: the
 * owner decides on a call if they're watching; otherwise the job goes without and the work suffers.
 */
async function buySpecialist(
  engine: Engine,
  agent: AgentRow,
  job: JobRow,
  handle: string,
): Promise<Exclude<SpecialistUse, 'none'> | 'wait'> {
  const vendor = vendorByHandle(handle);
  if (!vendor) return 'missing';
  const account = vendorAccount(engine, handle);
  let current = agent;
  let call = await vendorCall(engine, job.id, 'specialist');
  if (!rulebookAllows(agent, account)) {
    if (!call) {
      call = await raiseVendorCall(engine, agent, job, {
        key: 'specialist',
        handle,
        amount: vendor.price,
        source: job.body.includes(`(${handle},`) ? 'post' : 'plan',
        reason: `it wants ${vendor.name}'s data for this job (${vendor.description.toLowerCase()})`,
      });
      if (call) return 'wait';
      return 'missing';
    }
    if (call.status === 'open') return 'wait';
    if (call.choice !== 'allow') {
      await setCallOutcome(engine, call.id, {
        text: `Refused. ${agent.name} works without ${vendor.name}'s data, and the work will be weaker for it.`,
        tone: 'shield',
      });
      return 'missing';
    }
    current = await allowVendor(engine, agent, account);
  }
  const shop = shopFor(engine, handle);
  if (!shop) return 'missing';
  const req = { payTo: shop.accountId };
  const amount = shop.price;
  const { outcome, spendId } = await pay(
    engine,
    current,
    job,
    chainKey('spec', `${job.id}:${handle}`),
    'tool',
    req.payTo,
    amount,
    `shop ${handle} (specialist)`,
  );
  let settled = outcome.status === 'settled';
  if (outcome.status === 'pending' && call?.choice === 'allow') {
    await approveAsOwner(engine, current, spendId);
    const [row] = await engine.db
      .select()
      .from(spends)
      .where(eq(spends.id, spendId ?? ''));
    settled = row?.status === 'settled';
  }
  if (!settled) {
    if (call) {
      await setCallOutcome(engine, call.id, {
        text: `The wallet didn't pay ${handle}: ${reasonWords(outcome.reason)}.`,
        tone: 'bad',
      });
    }
    return 'missing';
  }
  const answered = shop.delivers;
  if (outcome.status === 'settled') {
    await book(engine, {
      ref: `spend:spec:${job.id}:${handle}`,
      kind: 'tool',
      amount: -amount,
      agentId: agent.id,
      playerId: agent.ownerId,
      jobId: job.id,
    });
  }
  await post(engine, {
    kind: 'tool_bought',
    tone: 'money',
    text: `${agent.name} paid ${vendor.name} ${formatUsd(amount)} for specialist data${answered ? '' : ' (no answer came back)'}.`,
    agentId: agent.id,
    jobId: job.id,
    amount,
  });
  if (call) {
    await setCallOutcome(engine, call.id, {
      text: `Paid ${vendor.name} ${formatUsd(amount)}. The work gets its data.`,
      tone: 'good',
    });
  }
  return 'bought';
}

/**
 * A payment the model asked for, whether the job text told it to or its own loop chose it. Code
 * checks only that it is a well-formed account and a sane amount; the wallet contract applies the
 * rulebook, so the refusal (or the loss) is on chain for everyone to see. `ask: false` (the loop)
 * skips asking the owner first.
 */
export async function attemptRequestedPayment(
  engine: Engine,
  agent: AgentRow,
  job: JobRow,
  request: { payee: string; amountUsd: string; reason: string },
  index: number,
  opts: { ask?: boolean } = {},
): Promise<'done' | 'wait'> {
  const handle = request.payee.toLowerCase().replace(/\.vendors\..*$/, '');
  let amount: bigint;
  try {
    amount = usd(request.amountUsd.replace(/^\$/, ''));
  } catch {
    return 'done';
  }
  if (!/^[a-z0-9-]{2,40}$/.test(handle) || amount <= 0n || amount > MAX_PROPOSED_PAYMENT)
    return 'done';
  const receiver = vendorAccount(engine, handle);
  let current = agent;
  let call = await vendorCall(engine, job.id, `req:${index}`);
  // A payment the rulebook would refuse goes to the owner first, if they're watching. The agent loop
  // runs in the background and doesn't wait on the owner: the wallet decides.
  if (opts.ask !== false && !rulebookAllows(agent, receiver)) {
    if (!call) {
      call = await raiseVendorCall(engine, agent, job, {
        key: `req:${index}`,
        handle,
        amount,
        source: 'post',
        reason: `the post says: "${request.reason.slice(0, 90)}"`,
      });
      if (call) return 'wait';
    } else if (call.status === 'open') {
      return 'wait';
    } else if (call.choice === 'allow') {
      current = await allowVendor(engine, agent, receiver);
    }
  }
  const { outcome, fresh, spendId } = await pay(
    engine,
    current,
    job,
    chainKey('req', `${job.id}:${index}`),
    'tool',
    receiver,
    amount,
    // A memo is public (and goes on chain): never the agent's or the post's free text.
    `requested for "${job.title.slice(0, 60)}"`,
  );
  const rng = tickRng(engine, `pay:${job.id}`);
  const scam = VENDORS.some((v) => v.scam && v.handle === handle);
  if (!fresh) return 'done'; // A retried stage: this request was already handled.
  if (outcome.status === 'pending' && call?.choice === 'allow') {
    // The owner already said yes; the cap that held it is theirs to waive.
    await approveAsOwner(engine, current, spendId);
    await setCallOutcome(engine, call.id, {
      text: scam
        ? `Paid ${handle} ${formatUsd(amount)}. It was a scam: the money is gone, and ${handle} stays on the rulebook until you remove it.`
        : `Paid ${handle} ${formatUsd(amount)}.`,
      tone: scam ? 'bad' : 'neutral',
    });
    return 'done';
  }
  if (call) {
    await setCallOutcome(
      engine,
      call.id,
      outcome.status === 'blocked'
        ? { text: `Refused: the wallet blocked it on chain. No money moved.`, tone: 'shield' }
        : outcome.status === 'settled'
          ? {
              text: scam
                ? `Paid ${handle} ${formatUsd(amount)}. It was a scam: the money is gone, and ${handle} stays on the rulebook until you remove it.`
                : `Paid ${handle} ${formatUsd(amount)}.`,
              tone: scam ? 'bad' : 'neutral',
            }
          : { text: `The wallet held it: ${reasonWords(outcome.reason)}.`, tone: 'neutral' },
    );
  }
  if (outcome.status === 'blocked') {
    // A scam blocked is a known scam vendor refused, not any made-up payee (that would farm the stat).
    const vendorBlock = outcome.reason === 'vendor_not_allowed' && scam;
    if (vendorBlock) {
      // Only a refused payee counts as a scam blocked; a frozen wallet or a full queue is not one.
      await chainCall('record_scam_blocked', () =>
        engine.chain.recordScamBlocked(
          agent.accountId ?? '',
          job.chainJobId ?? job.id,
          chainKey('scam', `${agent.id}:${job.id}:${index}`),
        ),
      );
      await engine.db
        .update(agents)
        .set({ scamsBlocked: sql`${agents.scamsBlocked} + 1` })
        .where(eq(agents.id, agent.id));
    }
    await post(engine, {
      kind: 'spend_blocked',
      tone: 'shield',
      text: vendorBlock
        ? `🛡 Blocked by ${agent.name}'s rulebook: ${formatUsd(amount)} to ${handle} (${reasonWords(outcome.reason)}). No money lost.`
        : `🛡 ${agent.name}'s wallet refused ${formatUsd(amount)} to ${handle}: ${reasonWords(outcome.reason)}. No money moved.`,
      agentId: agent.id,
      jobId: job.id,
      amount,
    });
    if (vendorBlock) {
      await post(engine, {
        kind: 'diary',
        tone: 'neutral',
        text: `${agent.name}: ${diaryLine(rng, traitsOf(agent), { type: 'blocked', vendor: handle, amount })}`,
        agentId: agent.id,
        jobId: job.id,
      });
    }
  } else if (outcome.status === 'pending') {
    await askOwner(
      engine,
      agent,
      job,
      `pay ${handle} ${formatUsd(amount)} ("${request.reason.slice(0, 60)}")`,
      outcome.reason,
    );
  } else if (outcome.status === 'settled') {
    await book(engine, {
      ref: `spend:req:${job.id}:${index}`,
      kind: scam ? 'scam_loss' : 'tool',
      amount: -amount,
      agentId: agent.id,
      playerId: agent.ownerId,
      jobId: job.id,
    });
    await post(engine, {
      kind: 'spend_blocked',
      tone: 'bad',
      text: `${agent.name} paid ${handle} ${formatUsd(amount)} because the job said to. ${scam ? 'It was a scam. The rulebook allowed it.' : ''}`.trim(),
      agentId: agent.id,
      jobId: job.id,
      amount,
    });
    if (scam)
      await post(engine, {
        kind: 'diary',
        tone: 'neutral',
        text: `${agent.name}: ${diaryLine(rng, traitsOf(agent), { type: 'scammed', vendor: handle, amount })}`,
        agentId: agent.id,
        jobId: job.id,
      });
  }
  return 'done';
}

async function askOwner(
  engine: Engine,
  agent: AgentRow,
  job: JobRow,
  what: string,
  reason: string | null,
): Promise<void> {
  await post(engine, {
    kind: 'approval_requested',
    tone: 'shield',
    text: `${agent.name} wants to ${what}. That's ${reasonWords(reason)}, so it needs your OK.`,
    agentId: agent.id,
    jobId: job.id,
    playerId: agent.ownerId,
    scope: 'owner',
  });
}

/** Ticks a job waits for the owner to decide on a held hire before carrying on without the helper. */
const APPROVAL_WAIT_TICKS = 15;

async function stageHelper(engine: Engine, job: JobRow, agent: AgentRow): Promise<void> {
  const state = stateOf(job);
  const key = chainKey('helper', job.id);
  const [existing] = await engine.db.select().from(spends).where(eq(spends.key, key));
  if (existing) {
    // A hire was already asked for: wait for the owner while there's time, then use or skip it.
    if (existing.status === 'pending' && engine.clock.tick < (state.waitUntil ?? 0)) {
      await save(engine, job, { plan: state, nextAt: next(engine, 1) });
      return;
    }
    if (existing.status === 'settled' && !state.helperDone) {
      const [helper] = await engine.db
        .select()
        .from(agents)
        .where(eq(agents.accountId, existing.receiver));
      if (helper) await recordHire(engine, job, agent, helper, existing.amount, state);
    }
  } else if (state.plan?.hireHelper && rulebookOf(agent).mayHire) {
    const [helper] = await helperCandidates(engine, agent, job.category as Category);
    if (helper?.accountId) {
      // Helpers ask a tenth of the job (at least two cents). Above the rulebook's helper budget, the
      // wallet holds the hire for the owner's approval.
      const tenth = ((job.price ?? job.budget) / 10n / 10_000n) * 10_000n;
      const price = maxBig(tenth, 20_000n);
      const { outcome } = await pay(
        engine,
        agent,
        job,
        key,
        'helper',
        helper.accountId,
        price,
        `proofread "${job.title.slice(0, 60)}"`,
      );
      if (outcome.status === 'settled') {
        await recordHire(engine, job, agent, helper, price, state);
      } else if (outcome.status === 'pending') {
        await askOwner(
          engine,
          agent,
          job,
          `hire ${helper.name} for ${formatUsd(price)} to proofread`,
          outcome.reason,
        );
        state.waitUntil = engine.clock.tick + APPROVAL_WAIT_TICKS;
        await save(engine, job, { plan: state, nextAt: next(engine, 1) });
        return;
      }
    }
  }
  await save(engine, job, {
    plan: state,
    stage: 'draft',
    nextAt: next(engine, STAGE_TICKS.helper),
  });
}

async function recordHire(
  engine: Engine,
  job: JobRow,
  agent: AgentRow,
  helper: AgentRow,
  price: bigint,
  state: WorkState,
): Promise<void> {
  state.helperDone = true;
  await book(engine, {
    ref: `spend:helper:${job.id}`,
    kind: 'helper_paid',
    amount: -price,
    agentId: agent.id,
    playerId: agent.ownerId,
    jobId: job.id,
  });
  await book(engine, {
    ref: `earn:helper:${job.id}`,
    kind: 'helper_earned',
    amount: price,
    agentId: helper.id,
    playerId: helper.ownerId,
    jobId: job.id,
  });
  await engine.db
    .update(jobs)
    .set({ helperAgentId: helper.id, helperPrice: price, helperTask: 'Proofread the draft' })
    .where(eq(jobs.id, job.id));
  await refreshBalance(engine, helper);
  await post(engine, {
    kind: 'helper_hired',
    tone: 'money',
    text: `${agent.name} hired ${helper.name} to proofread for ${formatUsd(price)}.`,
    agentId: agent.id,
    jobId: job.id,
    amount: price,
  });
  await post(engine, {
    kind: 'diary',
    tone: 'neutral',
    text: `${agent.name}: ${diaryLine(tickRng(engine, job.id), traitsOf(agent), { type: 'hired', helper: helper.name, price })}`,
    agentId: agent.id,
    jobId: job.id,
  });
}

async function stageDraft(engine: Engine, job: JobRow, agent: AgentRow): Promise<void> {
  const state = stateOf(job);
  const files = await jobFilesOf(engine, job.id);
  const ctx = await brainContext(engine, agent, job, 'draft', {
    notes: (state.toolNotes ?? []).map((t) => t.notes),
    // A look at the job's files, so the writing isn't blind to them (the analysis is in the notes).
    files: files.map((f) => ({
      name: f.name,
      bytes: f.content.length,
      preview: f.content.slice(0, 600),
    })),
  });
  const result = await think(engine, agent, `draft:${job.id}`, job.id, ctx, job.body);
  let deliverable = result.ok
    ? result.output.deliverable
    : `Rushed draft: ${job.title}. (The agent could not afford to think this through.)`;
  if (
    result.ok &&
    job.source !== 'practice' &&
    (traitsOf(agent).includes('meticulous') || tierOf(agent) === 'premium')
  ) {
    const reviewCtx = await brainContext(engine, agent, job, 'review', { draft: deliverable });
    const review = await think(engine, agent, `review:${job.id}`, job.id, reviewCtx, job.body);
    if (review.ok) deliverable = review.output.deliverable;
  }
  if (state.helperDone && job.helperAgentId) {
    const [helper] = await engine.db.select().from(agents).where(eq(agents.id, job.helperAgentId));
    if (helper) {
      // The helper pays for its own proofreading out of what it was paid.
      const reviewCtx = await brainContext(engine, helper, job, 'review', { draft: deliverable });
      const review = await think(
        engine,
        helper,
        `helper-review:${job.id}`,
        job.id,
        reviewCtx,
        job.body,
      );
      if (review.ok) deliverable = review.output.deliverable;
    }
  }
  // A draft the agent couldn't pay for is a stub, not work: it must fail a dispute whatever the tier.
  const quality = !result.ok
    ? 0
    : qualityFor(
        snapshotOf(agent),
        jobSnapshot(job, null),
        tierOf(agent),
        {
          tools: state.toolsBought,
          helper: state.helperDone,
          specialist: job.specialist ? (state.specialist ?? 'missing') : 'none',
          contract: job.contractTier !== null,
          toolsAvailable: usableTools(engine, agent, job).length > 0,
        },
        engine.cfg,
      ) - (state.rushed ? 0.3 : 0);
  await save(engine, job, {
    deliverable,
    quality: Math.max(0, quality),
    stage: 'deliver',
    nextAt: next(engine, STAGE_TICKS.draft),
  });
}

async function stageDeliver(engine: Engine, job: JobRow, agent: AgentRow): Promise<void> {
  const deliverable = job.deliverable ?? '';
  const workHash = sha256Hex(deliverable);
  if (job.source === 'practice') {
    const rating = gradePractice(deliverable, job.answerKeywords ?? []);
    await save(engine, job, { workHash, rating, status: 'delivered', stage: null });
    await settle(engine, { ...job, workHash, rating }, agent, rating, 'paid');
    return;
  }
  if (job.chainJobId) {
    // Already delivered on chain (the process stopped after the call): don't send it twice.
    const state = await chainJobState(engine, job.chainJobId);
    if (state.kind === 'live' && state.status === 'awarded') {
      await engine.chain.deliver(job.chainJobId, agent.accountId ?? '', workHash);
    }
  }
  const reviewTicks = engine.cfg.reviewTicks * (job.clientPlayerId ? PLAYER_REVIEW_FACTOR : 1);
  await save(engine, job, {
    workHash,
    status: 'delivered',
    stage: 'review',
    reviewUntilTick: next(engine, reviewTicks),
  });
  await post(engine, {
    kind: 'delivered',
    tone: 'neutral',
    text: `${agent.name} delivered "${job.title}". Work hash ${workHash.slice(0, 10)}… recorded on the job board${engine.modes.chain === 'sim' ? ' (chain simulator)' : ''}.`,
    agentId: agent.id,
    jobId: job.id,
  });
  if (job.clientPlayerId) {
    await post(engine, {
      kind: 'delivered',
      tone: 'good',
      text: `${agent.name} delivered your job "${job.title}". Rate it to release payment.`,
      jobId: job.id,
      playerId: job.clientPlayerId,
      scope: 'owner',
    });
  }
}

/**
 * Simulated clients review at half their window (the chain only accepts disputes inside it); a
 * player's job auto-releases at 4★ after its window, as the contract allows anyone to.
 */
async function advanceReviews(engine: Engine): Promise<void> {
  const tick = engine.clock.tick;
  const waiting = await engine.db
    .select()
    .from(jobs)
    .where(and(eq(jobs.status, 'delivered'), eq(jobs.stage, 'review')));
  await inParallel(
    waiting,
    (job) => reviewOne(engine, job, tick),
    (job, err) => engine.log('review failed', { job: job.id, error: String(err) }),
  );
}

async function reviewOne(engine: Engine, job: JobRow, tick: number): Promise<void> {
  const [agent] = await engine.db
    .select()
    .from(agents)
    .where(eq(agents.id, job.awardedAgentId ?? ''));
  if (!agent || !job.chainJobId || job.reviewUntilTick === null) return;
  // Disputed and waiting on the judge: once the ruling is stored, this resolves it on chain.
  if (job.disputed) {
    await finishReview(engine, job, agent, engine.chain.ids.operator, { kind: 'dispute' });
    return;
  }
  if (job.clientPlayerId) {
    if (tick < job.reviewUntilTick) return;
    await finishReview(engine, job, agent, engine.chain.ids.operator, { kind: 'release' });
    return;
  }
  const reviewAt = job.reviewUntilTick - Math.ceil(engine.cfg.reviewTicks / 2);
  if (tick < reviewAt) return;
  const rating = rateWork(job.quality ?? 0.5, tickRng(engine, `review:${job.id}`));
  const client = await clientAccount(engine, job);
  // Scam clients dispute everything; honest ones below their bar (4★ for a contract client).
  const verdict =
    job.scam || rating < disputesBelow(job.contractTier !== null)
      ? { kind: 'dispute' as const }
      : { kind: 'accept' as const, rating };
  await finishReview(engine, job, agent, client, verdict);
}

export type ClientVerdict =
  | { kind: 'accept'; rating: number }
  | { kind: 'dispute' }
  | { kind: 'release' };

/**
 * The one path that closes a delivered job. It reads the chain first, so a step that already landed
 * (accept, dispute, resolve) is finished from the chain's record rather than sent again. A dispute
 * returns 'pending' while a model is still reading the work; a later tick calls this again.
 */
export async function finishReview(
  engine: Engine,
  job: JobRow,
  agent: AgentRow,
  signer: string,
  verdict: ClientVerdict,
): Promise<'paid' | 'refunded' | 'pending' | 'unknown'> {
  const chainJobId = job.chainJobId ?? '';
  const state = await chainJobState(engine, chainJobId);
  if (state.kind === 'settled') {
    if (state.settlement === 'paid' || state.settlement === 'refunded') {
      const rating = state.rating ?? (verdict.kind === 'accept' ? verdict.rating : null);
      await settle(
        engine,
        job,
        agent,
        state.settlement === 'paid' ? rating : null,
        state.settlement,
      );
      return state.settlement;
    }
    engine.log('job left the board unexpectedly', { job: job.id, settlement: state.settlement });
    return 'unknown';
  }
  if (state.status === 'delivered') {
    try {
      if (verdict.kind === 'accept') {
        await engine.chain.accept(signer, chainJobId, verdict.rating);
        await settle(engine, job, agent, verdict.rating, 'paid');
        return 'paid';
      }
      if (verdict.kind === 'release') {
        await engine.chain.releaseExpired(signer, chainJobId);
        await settle(engine, job, agent, 4, 'paid');
        return 'paid';
      }
      await engine.chain.dispute(signer, chainJobId);
    } catch (err) {
      // The chain's review window has its own clock. Once it has closed, nobody can rate or dispute,
      // and the payout is released at 4 stars, exactly as the contract allows.
      if (!(err instanceof ChainError && err.code === 'review_window_closed')) throw err;
      await engine.chain.releaseExpired(engine.chain.ids.operator, chainJobId);
      await settle(engine, job, agent, 4, 'paid');
      return 'paid';
    }
  }
  await engine.db.update(jobs).set({ disputed: true }).where(eq(jobs.id, job.id));
  // A model reading the work takes a while: it runs off the lane, and a later tick resolves the job.
  const ruling = await rulingFor(engine, job, agent);
  if (!ruling) return 'pending';
  const refund = ruling.refund;
  await engine.chain.resolve(chainJobId, refund);
  await settle(engine, job, agent, null, refund ? 'refunded' : 'paid');
  return refund ? 'refunded' : 'paid';
}

/** Books the outcome once the chain has paid or refunded: reputation, skills, XP, diary, feed. */
export async function settle(
  engine: Engine,
  job: JobRow,
  agent: AgentRow,
  rating: number | null,
  outcome: 'paid' | 'refunded',
): Promise<void> {
  const [claimed] = await engine.db
    .update(jobs)
    .set({ status: outcome, stage: null, rating, settledAt: new Date() })
    .where(and(eq(jobs.id, job.id), eq(jobs.status, 'delivered')))
    .returning();
  if (!claimed) return;
  const price = job.price ?? 0n;
  const fee = (price * BigInt(engine.cfg.feeBps)) / 10_000n;
  const related = job.clientPlayerId !== null && job.clientPlayerId === agent.ownerId;
  if (outcome === 'paid' && price > 0n) {
    await book(engine, {
      ref: `payout:${job.id}`,
      kind: 'job_payout',
      amount: price,
      agentId: agent.id,
      playerId: agent.ownerId,
      jobId: job.id,
      related,
    });
    await book(engine, {
      ref: `fee:${job.id}`,
      kind: 'platform_fee',
      amount: -fee,
      agentId: agent.id,
      playerId: agent.ownerId,
      jobId: job.id,
      related,
    });
  }
  const practice = job.source === 'practice';
  const trap = job.scam && job.contractTier !== null;
  const xp = trap ? 0 : repXpFor(practice ? 'practice' : outcome, rating);
  const skills: Skills = skillsOf(agent);
  const cat = job.category as Category;
  const skill = skills[cat];
  if (outcome === 'paid') {
    skill.xp += practice ? SKILL_XP_PER_PRACTICE : SKILL_XP_PER_JOB;
    skill.level = Math.max(skill.level, skillLevelForXp(skill.xp, engine.cfg));
  }
  const levelBefore = levelForXp(agent.repXp, engine.cfg);
  const repXp = Math.max(0, agent.repXp + xp);
  const [updated] = await engine.db
    .update(agents)
    .set({
      busyJobId: null,
      repXp,
      skills,
      ratingSum: agent.ratingSum + (!practice && outcome === 'paid' && rating ? rating : 0),
      ratingCount: agent.ratingCount + (!practice && outcome === 'paid' && rating ? 1 : 0),
      disputes: agent.disputes + (outcome === 'refunded' && !trap ? 1 : 0),
      practiceDone: agent.practiceDone + (practice ? 1 : 0),
      lastPaidTick: outcome === 'paid' && !practice ? engine.clock.tick : agent.lastPaidTick,
    })
    .where(eq(agents.id, agent.id))
    .returning();
  if (!practice && updated) await afterSettle(engine, job, updated, rating, outcome);
  // The agent's memory of the job: its facts now, its lesson from the reflection queue.
  if (!practice) await rememberJob(engine, agent, { ...job, rating }, outcome);
  const [latest] = await engine.db.select().from(agents).where(eq(agents.id, agent.id));
  const fresh = latest ? await refreshBalance(engine, latest) : agent;
  const rng = tickRng(engine, `settle:${job.id}`);
  if (practice) {
    await post(engine, {
      kind: 'paid',
      tone: 'good',
      text: `${agent.name} finished practice "${job.title.replace(/^Practice: /, '')}" (${rating}★ against the answer key). +${xp} XP.`,
      agentId: agent.id,
      jobId: job.id,
    });
    if (agent.practiceDone === 0)
      await post(engine, {
        kind: 'diary',
        tone: 'neutral',
        text: `${agent.name}: ${diaryLine(rng, traitsOf(agent), { type: 'first_job' })}`,
        agentId: agent.id,
        jobId: job.id,
      });
  } else if (outcome === 'paid') {
    const costs = await jobCosts(engine, agent.id, job.id);
    const profit = price - fee - costs;
    await post(engine, {
      kind: 'paid',
      tone: profit >= 0n ? 'money' : 'bad',
      text: `${agent.name} ${rating === null ? 'was paid after a dispute' : `got ${rating}★`} on "${job.title}": paid ${formatUsd(price - fee)} after the ${formatUsd(fee)} fee. ${profit >= 0n ? `${formatUsd(profit)} profit` : `${formatUsd(-profit)} loss`} on the job.`,
      agentId: agent.id,
      jobId: job.id,
      amount: profit,
    });
    await post(engine, {
      kind: 'diary',
      tone: 'neutral',
      text: `${agent.name}: ${diaryLine(rng, traitsOf(agent), { type: 'paid', job: job.title, profit, rating })}`,
      agentId: agent.id,
      jobId: job.id,
    });
  } else if (trap) {
    await post(engine, {
      kind: 'refunded',
      tone: 'neutral',
      text: `"${job.title}" was a trap: there was no real client, so the escrow went back to the scammer. ${agent.name} gets nothing for the work, but keeps its bond, its reputation and (unless you paid them) its streak.`,
      agentId: agent.id,
      jobId: job.id,
    });
  } else {
    await post(engine, {
      kind: 'refunded',
      tone: 'bad',
      text: `The judge refunded "${job.title}". ${agent.name} gets nothing and loses reputation.`,
      agentId: agent.id,
      jobId: job.id,
    });
    await post(engine, {
      kind: 'diary',
      tone: 'neutral',
      text: `${agent.name}: ${diaryLine(rng, traitsOf(agent), { type: 'refunded', job: job.title })}`,
      agentId: agent.id,
      jobId: job.id,
    });
  }
  const levelAfter = levelForXp(repXp, engine.cfg);
  if (levelAfter > levelBefore) {
    await post(engine, {
      kind: 'level_up',
      tone: 'good',
      text: `${agent.name} reached level ${levelAfter}${levelAfter === 2 ? ': sponsor bounties and level-2 client briefs unlocked' : levelAfter === 3 ? ': the best-paid client briefs (up to $1.60) unlocked' : ''}.`,
      agentId: agent.id,
    });
  }
  await checkAchievements(engine, fresh);
}

/** What an agent spent on one job (inference, tools, helpers), from its settled spends. */
export async function jobCosts(engine: Engine, agentId: string, jobId: string): Promise<bigint> {
  const rows = await engine.db
    .select()
    .from(spends)
    .where(and(eq(spends.agentId, agentId), eq(spends.jobId, jobId), eq(spends.status, 'settled')));
  // A bond is collateral, not a cost.
  return rows.filter((r) => r.kind !== 'bond').reduce((s, r) => s + r.amount, 0n);
}

/**
 * The extras on closing a job: a 5★ tip from a
 * house client, a contract's bond (back to the agent, or to the client as damages), and the streak.
 * Each chain step has a fixed key, so a retried settle sends nothing twice.
 */
async function afterSettle(
  engine: Engine,
  job: JobRow,
  agent: AgentRow,
  rating: number | null,
  outcome: 'paid' | 'refunded',
): Promise<void> {
  // A payment still held for the owner's approval is pointless once its job has closed: the wallet
  // drops it (a denial by the owner's account), so approving it later can't spend on a dead job.
  const held = await engine.db
    .select()
    .from(spends)
    .where(and(eq(spends.jobId, job.id), eq(spends.status, 'pending')));
  if (held.length > 0) {
    const owner = await playerById(engine, agent.ownerId);
    for (const spend of held) {
      if (owner && spend.requestId !== null) {
        await decideApproval(engine, owner, spend.id, { approve: false }).catch((err) =>
          engine.log('expiring a held payment failed', { spend: spend.id, error: String(err) }),
        );
      } else {
        // Never queued on chain: nothing to deny there.
        await engine.db
          .update(spends)
          .set({ status: 'denied', decidedAt: new Date() })
          .where(eq(spends.id, spend.id));
      }
    }
  }
  const price = job.price ?? 0n;
  const tip = outcome === 'paid' && !job.clientPlayerId ? tipFor(price, rating, engine.cfg) : 0n;
  if (tip > 0n && agent.accountId) {
    const client = await clientAccount(engine, job);
    const key = chainKey('tip', job.id);
    await chainCall('tip', () =>
      engine.chain.ftTransfer(
        client,
        agent.accountId ?? '',
        tip,
        `5★ tip for "${job.title}"`.slice(0, 120),
        key,
      ),
    );
    await book(engine, {
      ref: `tip:${job.id}`,
      kind: 'tip',
      amount: tip,
      agentId: agent.id,
      playerId: agent.ownerId,
      jobId: job.id,
    });
    await post(engine, {
      kind: 'paid',
      tone: 'money',
      text: `${job.clientName} tipped ${agent.name} ${formatUsd(tip)} for 5★ work on "${job.title}".`,
      agentId: agent.id,
      jobId: job.id,
      amount: tip,
    });
  }
  if (job.bond) {
    if (outcome === 'paid' || job.scam) {
      await returnBond(engine, agent, `bond-back:${job.id}`, job.bond, 'contract closed');
    } else {
      await returnBond(
        engine,
        agent,
        `bond-damages:${job.id}`,
        job.bond,
        'the arbiter refunded the client',
        await clientAccount(engine, job),
      );
      await post(engine, {
        kind: 'refunded',
        tone: 'bad',
        text: `${agent.name} lost its ${formatUsd(job.bond)} contract bond: it went to ${job.clientName} as damages.`,
        agentId: agent.id,
        jobId: job.id,
        amount: job.bond,
      });
    }
  }
  const [lost] = await engine.db
    .select({ n: sql<number>`count(*)::int` })
    .from(ledger)
    .where(and(eq(ledger.jobId, job.id), eq(ledger.kind, 'scam_loss')));
  const trap = job.scam && job.contractTier !== null;
  const streak = trap
    ? (lost?.n ?? 0) > 0
      ? 0
      : agent.streak
    : nextStreak(agent.streak, { paid: outcome === 'paid', rating, scamLoss: (lost?.n ?? 0) > 0 });
  if (streak !== agent.streak) {
    await engine.db
      .update(agents)
      .set({ streak, bestStreak: Math.max(agent.bestStreak, streak) })
      .where(eq(agents.id, agent.id));
    if (streak === 0 && agent.streak >= engine.cfg.contractStreak) {
      await post(engine, {
        kind: 'diary',
        tone: 'bad',
        text: `${agent.name}'s streak of ${agent.streak} is over.`,
        agentId: agent.id,
        jobId: job.id,
        playerId: agent.ownerId,
        scope: 'owner',
      });
    } else if (streak === engine.cfg.contractStreak) {
      await post(engine, {
        kind: 'level_up',
        tone: 'good',
        text: `${agent.name} is on a streak of ${streak}: contract offers unlocked.`,
        agentId: agent.id,
        playerId: agent.ownerId,
        scope: 'owner',
      });
    }
  }
}
