import { formatUsd, usd } from '@hustle/core';
import { jobSteps, jobs, sandboxRuns, spends } from '@hustle/db';
import { ACT_CALL, callCostMicro, toolCost } from '@hustle/economy';
import { and, asc, eq } from 'drizzle-orm';
import { type AgentRow, loadAgent, tierOf } from '../agents/state.ts';
import type { ActOutput } from '../brain/prompts.ts';
import { think } from '../brain/think.ts';
import { type Engine, toolsFor } from '../context.ts';
import {
  isAgentFileName,
  jobFilesOf,
  MAX_AGENT_FILE_CHARS,
  MAX_AGENT_FILES,
  saveJobFile,
} from '../files.ts';
import { chainKey, post } from '../record.ts';
import { RUNNERS, usableTools } from '../tools/index.ts';
import { runSandboxStep } from '../tools/python.ts';
import { brainContext } from './context.ts';
import { hire, specialistsFor } from './hire.ts';
import type { JobRow } from './jobs.ts';

/** Most turns one job's loop takes (the last one must deliver). */
export const MAX_TURNS = 8;
/** What a turn sees of a recent step's result, and of an older one's. */
const SEEN_RECENT = 2_500;
const SEEN_OLDER = 240;
const RECENT_STEPS = 3;
const PREVIEW = 400;

type Act = typeof ActOutput._output;

/** A live agent with tools works a client job by its own loop; everyone else follows the pipeline. */
export const loopEligible = (engine: Engine, agent: AgentRow, job: JobRow): boolean =>
  job.source !== 'practice' && toolsFor(engine, agent).length > 0;

export interface LoopOutcome {
  /** The agent's delivery, or null when it produced nothing (it ran out of money or turns). */
  delivered: string | null;
  /** It stopped before delivering, and the delivery is its files and last note. */
  partial: boolean;
  /** Tools that returned something the work used (searches, chain reads, sandbox runs). */
  toolUses: number;
  /** Payees it paid (a specialist it bought from, or a scam it fell for). */
  paid: string[];
  /** It asked the client a question and is waiting for the answer: nothing to deliver yet. */
  waiting: boolean;
}

/** How a step that ended the loop begins, so a restart doesn't carry on past it. */
const STOPPED = "Couldn't take this step";
const TOOL_ACTIONS = ['python', 'search', 'chain', 'fetch'];
/** A question's step while the client hasn't answered, and how long the agent waits. */
const WAITING = 'Waiting for the client to answer.';
export const ASK_WAIT_TICKS = 12;

/**
 * A live agent's loop for one job: each turn it reads the brief, its files and its steps so far, and
 * chooses one action (search, chain data, a page, Python, a specialist, a question, write a file,
 * pay, deliver);
 * the action runs and its result becomes part of the next turn. Every turn is an attested, metered
 * call paid from its wallet, keyed by job and turn, so a restart resumes where it stopped and never
 * pays twice. It sees what it can still spend (per-job cap, day cap, balance) and must deliver before
 * it runs out; a step that would leave too little to deliver is refused. If it stops without
 * delivering, its files and last note are the delivery.
 */
export async function runLoop(engine: Engine, agent: AgentRow, job: JobRow): Promise<LoopOutcome> {
  const brain = engine.brains[tierOf(agent)];
  const turnCost = callCostMicro(brain, ACT_CALL);
  const outcome: LoopOutcome = {
    delivered: null,
    partial: false,
    toolUses: 0,
    paid: [],
    waiting: false,
  };
  const done = await stepsOf(engine, job, agent);
  let stopped = false;
  for (const s of done) {
    if (s.action === 'deliver') outcome.delivered = s.input;
    if (s.action === 'none' && s.observation.startsWith(STOPPED)) stopped = true;
    if (s.ok && TOOL_ACTIONS.includes(s.action)) outcome.toolUses += 1;
    if (s.ok && s.action === 'pay') outcome.paid.push(s.args.split(/\s+/)[0] ?? '');
  }
  // A question still open: wait for the answer (or the time limit), then carry on with it.
  const asked = done.at(-1);
  if (asked?.action === 'ask' && asked.observation === WAITING) {
    const [fresh] = await engine.db.select().from(jobs).where(eq(jobs.id, job.id));
    const answer = fresh?.answer;
    const late = engine.clock.tick >= (fresh?.askedTick ?? 0) + ASK_WAIT_TICKS;
    if (!answer && !late) return { ...outcome, waiting: true };
    await engine.db
      .update(jobSteps)
      .set({
        ok: !!answer,
        observation: answer
          ? `The client answered: ${answer}`
          : "The client didn't answer in time: go with your best judgement, and say in your delivery what you assumed.",
      })
      .where(and(eq(jobSteps.id, asked.id), eq(jobSteps.observation, WAITING)));
  }
  for (let n = done.length + 1; n <= MAX_TURNS && outcome.delivered === null && !stopped; n++) {
    const steps = await stepsOf(engine, job, agent);
    const left = await spendable(engine, agent, job);
    // Two turns of thinking (a delivery, with margin) stay out of reach of tools, payments and hires.
    const reserve = turnCost * 2n;
    const mustDeliver = n === MAX_TURNS || left < turnCost * 3n;
    const files = await jobFilesOf(engine, job.id);
    const specialists = mustDeliver ? [] : await specialistsFor(engine, agent, job);
    const canAsk = !mustDeliver && (await mayAsk(engine, job));
    const ctx = await brainContext(engine, agent, job, 'act', {
      canAsk,
      specialists: specialists.map((s) => s.offer),
      files: files.map((f) => ({
        name: f.name,
        bytes: f.content.length,
        preview: f.content.slice(0, PREVIEW),
      })),
      steps: steps.map((s, i) => ({
        n: s.n,
        action: s.action,
        args: s.args,
        observation: s.observation.slice(
          0,
          i >= steps.length - RECENT_STEPS ? SEEN_RECENT : SEEN_OLDER,
        ),
      })),
      budget: { left: formatUsd(left > 0n ? left : 0n), turnsLeft: MAX_TURNS - n + 1, mustDeliver },
    });
    const key = `act:${job.id}:${n}`;
    let turn = await think(engine, agent, key, job.id, ctx, job.body);
    // One provider error (a 5xx, an empty reply) is retried once under its own key, not fatal.
    if (!turn.ok && turn.reason === 'provider')
      turn = await think(engine, agent, `${key}:retry`, job.id, ctx, job.body);
    if (!turn.ok) {
      // It couldn't pay for (or get) the turn: it stops here, with whatever it has.
      await record(engine, job, agent, n, NO_ACT, {
        ok: false,
        observation: `${STOPPED} (${turn.reason}).`,
        cost: 0n,
      });
      break;
    }
    const act = turn.output as Act;
    let result: Performed;
    try {
      result = await perform(engine, agent, job, n, act, { left, room: left - reserve });
    } catch (err) {
      // The first time, the loop stops and a later tick resumes this step (every effect is keyed, so
      // nothing repeats). A step that throws again is recorded as failed, so the job moves on.
      const seen = `${job.id}:${n}`;
      engine.log('loop step failed', { job: job.id, n, error: String(err) });
      if (!thrownOnce.has(seen)) {
        thrownOnce.add(seen);
        throw err;
      }
      thrownOnce.delete(seen);
      result = no('That step failed twice on our side; try something else.');
    }
    await record(engine, job, agent, n, act, { ...result, cost: turn.cost + result.cost });
    if (act.action === 'ask' && result.observation === WAITING)
      return { ...outcome, waiting: true };
    if (act.action === 'deliver')
      outcome.delivered = act.body.trim() || '(delivered without a message)';
    if (result.ok && TOOL_ACTIONS.includes(act.action)) outcome.toolUses += 1;
    if (result.ok && act.action === 'pay') outcome.paid.push(act.args.split(/\s+/)[0] ?? '');
  }
  if (outcome.delivered === null) {
    // Stopped short: what it wrote is still work, delivered as it stands and said so.
    const written = (await jobFilesOf(engine, job.id)).filter((f) => f.source === 'agent');
    if (written.length) {
      const last = (await stepsOf(engine, job, agent)).findLast((s) => s.thought)?.thought;
      outcome.delivered = `The agent stopped before writing its final message. Its work so far: ${written.map((f) => f.name).join(', ')}.${last ? `\n\nIts last note: ${last}` : ''}`;
      outcome.partial = true;
    }
  }
  return outcome;
}

/** Steps that threw once in this process: the next throw is recorded instead of retried. */
const thrownOnce = new Set<string>();

/** One question per job, and only to a client who is a person (house clients never answer). */
async function mayAsk(engine: Engine, job: JobRow): Promise<boolean> {
  if (job.source !== 'player' || !job.clientPlayerId) return false;
  const [fresh] = await engine.db.select().from(jobs).where(eq(jobs.id, job.id));
  return !fresh?.question;
}

const NO_ACT: Act = { thought: '', action: 'none', args: '', body: '', cut: false };

/** What the agent can still spend on this job: the least of its per-job cap, day cap and balance. */
async function spendable(engine: Engine, agent: AgentRow, job: JobRow): Promise<bigint> {
  const wallet = await engine.chain.getWallet(agent.accountId ?? '');
  const perJob = wallet.rulebook.maxPerJob - (wallet.jobSpent[job.id] ?? 0n);
  const today = wallet.rulebook.dailyCap - wallet.spentToday;
  const balance = (await loadAgent(engine, agent.id))?.balance ?? agent.balance;
  return [perJob, today, balance].reduce((a, b) => (b < a ? b : a));
}

const stepsOf = (engine: Engine, job: JobRow, agent: AgentRow) =>
  engine.db
    .select()
    .from(jobSteps)
    .where(and(eq(jobSteps.jobId, job.id), eq(jobSteps.agentId, agent.id)))
    .orderBy(asc(jobSteps.n));

async function record(
  engine: Engine,
  job: JobRow,
  agent: AgentRow,
  n: number,
  act: Act,
  result: { ok: boolean; observation: string; cost: bigint },
): Promise<void> {
  await engine.db
    .insert(jobSteps)
    .values({
      jobId: job.id,
      agentId: agent.id,
      n,
      action: act.action,
      args: act.args,
      thought: act.thought,
      input: act.body.slice(0, MAX_AGENT_FILE_CHARS),
      observation: result.observation.slice(0, 8_000),
      ok: result.ok,
      cost: result.cost,
      tick: engine.clock.tick,
    })
    .onConflictDoNothing();
}

type Performed = { ok: boolean; observation: string; cost: bigint };

/** Runs one chosen action and says what came back, in words the next turn reads. */
async function perform(
  engine: Engine,
  agent: AgentRow,
  job: JobRow,
  n: number,
  act: Act,
  /** What it can still spend, and what it may spend on this step and still afford to deliver. */
  money: { left: bigint; room: bigint },
): Promise<Performed> {
  const { left, room } = money;
  // A block the reply cut off (no closing fence) is unfinished: running or saving it would mislead.
  if (act.cut && act.action !== 'deliver')
    return no(
      'Your reply was cut off before the block closed, so it was not run or saved. Make it shorter, or split it across steps.',
    );
  // A payment its caps or balance can't cover still goes to the wallet, whose refusal is the on-chain
  // evidence; one it could pay but that would leave nothing to deliver is stopped here.
  const tooDear = (cost: bigint, payment = false) =>
    cost > room && !(payment && cost > left)
      ? no(
          `That would leave too little of your budget to deliver (it costs about ${formatUsd(cost)}; you can spend ${formatUsd(room > 0n ? room : 0n)} and still deliver). Deliver with what you have, or choose a cheaper step.`,
        )
      : null;
  const usable = (id: string) =>
    usableTools(engine, agent, job, { loop: true }).find((t) => t.id === id);
  switch (act.action) {
    case 'python': {
      const spec = usable('python');
      if (!spec) return no('There is no Python sandbox for this job.');
      if (!act.body.trim()) return no('The python block was empty.');
      const dear = tooDear(spec.fee);
      if (dear) return dear;
      const run = await runSandboxStep(engine, agent, job, act.body, n, spec.fee);
      if (!run.kept)
        return no(`The sandbox couldn't run it (${run.error}); nothing was charged for the run.`);
      const printed = run.stdout.trim()
        ? run.stdout.slice(0, SEEN_RECENT * 2)
        : '(it printed nothing)';
      return {
        ok: run.error === null,
        observation: run.error ? `It stopped with: ${run.error}\n${printed}` : printed,
        cost: run.cost,
      };
    }
    case 'search':
    case 'chain':
    case 'fetch': {
      const spec = usable(
        act.action === 'search' ? 'web_search' : act.action === 'chain' ? 'chain_data' : 'fetch',
      );
      const runner = spec ? RUNNERS[spec.id] : undefined;
      if (!spec || !runner) return no(`${act.action} isn't available for this job.`);
      // The query or URL may come on the fence line instead of inside the block.
      const input = (act.body.trim() || act.args).slice(0, 300);
      if (!input) return no(`The ${act.action} block was empty.`);
      const dear = tooDear(toolCost(spec, engine.brains[tierOf(agent)]));
      if (dear) return dear;
      const run = await runner.run(engine, agent, job, spec, {
        input,
        key: `tool:${spec.id}:${job.id}:s${n}`,
      });
      if (!run.ok) return no(`${spec.name} found nothing usable (${run.reason}).`);
      const sources = run.sources.map((s) => `- ${s.title}: ${s.url}`).join('\n');
      return {
        ok: true,
        observation: `${run.notes}${sources ? `\n\nSources:\n${sources}` : ''}`,
        cost: run.cost,
      };
    }
    case 'ask': {
      const question = act.body.trim().slice(0, 500);
      if (!question) return no('The ask block was empty.');
      if (!(await mayAsk(engine, job)))
        return no("You can't ask this client a question; use your best judgement.");
      await engine.db
        .update(jobs)
        .set({ question, askedTick: engine.clock.tick })
        .where(eq(jobs.id, job.id));
      await post(engine, {
        kind: 'work',
        tone: 'neutral',
        text: `${agent.name} has a question about "${job.title}". Answer it on the job page.`,
        jobId: job.id,
        playerId: job.clientPlayerId,
        scope: 'owner',
      });
      return { ok: false, observation: WAITING, cost: 0n };
    }
    case 'hire': {
      const price = act.args.split(/\s+/)[1] ?? '';
      const dear = /^\$?\d+(\.\d{1,6})?$/.test(price)
        ? tooDear(usd(price.replace(/^\$/, '')), true)
        : null;
      return dear ?? hire(engine, agent, job, n, act);
    }
    case 'write': {
      const name = act.args.split(/\s+/)[0] ?? '';
      if (!isAgentFileName(name))
        return no(
          `"${name}" isn't a file name it can write (letters, digits, ._- and a text extension).`,
        );
      if (act.body.length > MAX_AGENT_FILE_CHARS) return no('That file is too big.');
      const mine = (await jobFilesOf(engine, job.id)).filter((f) => f.source === 'agent');
      if (!mine.some((f) => f.name === name) && mine.length >= MAX_AGENT_FILES)
        return no(`It has written ${MAX_AGENT_FILES} files already.`);
      const clients = (await jobFilesOf(engine, job.id)).filter((f) => f.source !== 'agent');
      if (clients.some((f) => f.name === name)) return no(`${name} is one of the job's own files.`);
      // A file a sandbox run read stays as it was, so that run can still be re-run and checked.
      const runs = await engine.db
        .select({ inputs: sandboxRuns.inputs })
        .from(sandboxRuns)
        .where(eq(sandboxRuns.jobId, job.id));
      if (mine.some((f) => f.name === name) && runs.some((r) => name in r.inputs))
        return no(`${name} was read by one of your runs, so it can't change; write a new file.`);
      await saveJobFile(engine, job.id, name, act.body, 'agent', { replace: true });
      return {
        ok: true,
        observation: `Saved ${name} (${act.body.length.toLocaleString('en')} characters).`,
        cost: 0n,
      };
    }
    case 'pay': {
      const [payee = '', amountUsd = ''] = act.args.split(/\s+/);
      if (/^\$?\d+(\.\d{1,6})?$/.test(amountUsd)) {
        const dear = tooDear(usd(amountUsd.replace(/^\$/, '')), true);
        if (dear) return dear;
      }
      const { attemptRequestedPayment } = await import('./work.ts');
      await attemptRequestedPayment(
        engine,
        agent,
        job,
        { payee, amountUsd, reason: act.body.trim() || 'requested by the agent' },
        1_000 + n,
        { ask: false },
      );
      const [spend] = await engine.db
        .select()
        .from(spends)
        .where(eq(spends.key, chainKey('req', `${job.id}:${1_000 + n}`)));
      if (!spend) return no(`No payment was made (the payee or amount wasn't valid).`);
      if (spend.status === 'settled')
        return {
          ok: true,
          observation: `Paid ${payee} ${formatUsd(spend.amount)}.`,
          cost: spend.amount,
        };
      return no(
        spend.status === 'blocked'
          ? `Your wallet refused it on chain (${spend.reason?.replaceAll('_', ' ')}). No money moved.`
          : `The wallet held it (${spend.reason?.replaceAll('_', ' ') ?? 'pending'}).`,
      );
    }
    case 'deliver':
      return { ok: true, observation: 'Delivered.', cost: 0n };
    default:
      return no('No action found: reply with exactly one fenced action block.');
  }
}

const no = (observation: string): Performed => ({ ok: false, observation, cost: 0n });
