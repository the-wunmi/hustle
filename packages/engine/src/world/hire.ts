import { CATEGORIES, type Category, formatUsd, usd } from '@hustle/core';
import { agents, jobs } from '@hustle/db';
import { ACT_CALL, callCostMicro } from '@hustle/economy';
import { and, eq, isNotNull, isNull, ne } from 'drizzle-orm';
import { type AgentRow, avgRating100, loadAgent, refreshBalance, tierOf } from '../agents/state.ts';
import type { BrainContext } from '../brain/prompts.ts';
import { dayOf, type Engine, toolsFor } from '../context.ts';
import { isFileName, jobFilesOf, saveJobFile } from '../files.ts';
import { book, chainKey, post } from '../record.ts';
import { type JobRow, NEVER_TICK } from './jobs.ts';
import { pay } from './pay.ts';

/** Specialists offered per turn, and the most a hire may cost (the wallet's rules still apply). */
const OFFERED = 4;
const MAX_HIRE = usd('5');
/** A specialist takes at least three of its own turns' worth: one call can't do a part. */
const LEAST_TURNS = 3n;
/** Most of a specialist's answer that goes into the hiring agent's next turn (the rest is in the saved file). */
const SEEN = 4_000;

type Specialist = NonNullable<BrainContext['specialists']>[number];

/** The least a specialist takes for a part: three of its own loop turns, rounded up to the cent. */
function leastFor(engine: Engine, agent: AgentRow): bigint {
  const turns = callCostMicro(engine.brains[tierOf(agent)], ACT_CALL) * LEAST_TURNS;
  return ((turns + 9_999n) / 10_000n) * 10_000n;
}

/**
 * Agents this one may hire for part of a job: awake, listed, live with tools (so they work by their
 * own loop), best rated first. None for a subcontract (one level only) or when the client said no.
 */
export async function specialistsFor(
  engine: Engine,
  agent: AgentRow,
  job: JobRow,
  opts: { all?: boolean } = {},
): Promise<{ row: AgentRow; offer: Specialist }[]> {
  if (job.source === 'subcontract' || !job.subcontracting) return [];
  const rows = await engine.db
    .select()
    .from(agents)
    .where(
      and(
        isNotNull(agents.accountId),
        isNull(agents.dormantSinceDay),
        eq(agents.hidden, false),
        eq(agents.frozen, false),
        ne(agents.id, agent.id),
      ),
    );
  return (
    rows
      .filter((a) => toolsFor(engine, a).length > 0)
      .sort((a, b) => (avgRating100(b) ?? 300) - (avgRating100(a) ?? 300))
      // The turn is shown a shortlist; a hire by name may pick anyone eligible.
      .slice(0, opts.all ? undefined : OFFERED)
      .map((row) => {
        const skills = row.skills as Record<string, { level: number }>;
        const best = CATEGORIES.filter((c) => (skills[c]?.level ?? 0) > 0)
          .sort((x, y) => (skills[y]?.level ?? 0) - (skills[x]?.level ?? 0))
          .slice(0, 3);
        return {
          row,
          offer: {
            name: row.name,
            skills: best.length ? best.join(', ') : 'new',
            rating:
              avgRating100(row) === null ? 'unrated' : ((avgRating100(row) ?? 0) / 100).toFixed(1),
            least: formatUsd(leastFor(engine, row)),
          },
        };
      })
  );
}

type Performed = { ok: boolean; observation: string; cost: bigint };
const no = (observation: string): Performed => ({ ok: false, observation, cost: 0n });

/**
 * A hire from inside the loop: `hire <name> <price> [files…]` with a brief for one part. The hiring
 * agent pays through its wallet's rulebook (kind `helper`); the specialist works a subcontract job of
 * its own (its loop, its wallet, its playbook) that holds only that brief and the files named, never
 * the client's brief. Its result comes back as files on the parent job. Keyed by job and step, so a
 * restart neither pays twice nor starts a second subcontract; the specialist's loop resumes.
 */
export async function hire(
  engine: Engine,
  agent: AgentRow,
  job: JobRow,
  n: number,
  act: { args: string; body: string },
): Promise<Performed> {
  const [name = '', price = '', ...fileNames] = act.args.split(/\s+/).filter(Boolean);
  const brief = act.body.trim();
  if (!brief) return no('The hire had no brief.');
  const offered = await specialistsFor(engine, agent, job, { all: true });
  const pick = offered.find((s) => s.row.name.toLowerCase() === name.toLowerCase());
  if (!pick?.row.accountId)
    return no(
      offered.length
        ? `${name || 'That agent'} isn't one of the specialists you can hire here.`
        : 'Nobody can be hired for this job.',
    );
  if (!/^\$?\d+(\.\d{1,6})?$/.test(price)) return no(`"${price}" isn't a price.`);
  const amount = usd(price.replace(/^\$/, ''));
  const least = leastFor(engine, pick.row);
  if (amount < least) return no(`${pick.row.name} takes at least ${formatUsd(least)} for a part.`);
  if (amount > MAX_HIRE) return no(`A hire is at most ${formatUsd(MAX_HIRE)}.`);
  const files = await jobFilesOf(engine, job.id);
  const shared = fileNames.map((f) => files.find((x) => x.name === f));
  const missing = fileNames.filter((_, i) => !shared[i]);
  if (missing.length) return no(`No such file to share: ${missing.join(', ')}.`);

  const key = chainKey('hire', `${job.id}:${n}`);
  const { outcome } = await pay(
    engine,
    agent,
    job,
    key,
    'helper',
    pick.row.accountId,
    amount,
    `part of "${job.title.slice(0, 60)}"`,
  );
  if (outcome.status !== 'settled')
    return no(
      `Your wallet refused the hire (${outcome.reason?.replaceAll('_', ' ') ?? 'not settled'}). No money moved.`,
    );
  await book(engine, {
    ref: `spend:hire:${job.id}:${n}`,
    kind: 'helper_paid',
    amount: -amount,
    agentId: agent.id,
    playerId: agent.ownerId,
    jobId: job.id,
  });
  await book(engine, {
    ref: `earn:hire:${job.id}:${n}`,
    kind: 'helper_earned',
    amount,
    agentId: pick.row.id,
    playerId: pick.row.ownerId,
    jobId: job.id,
  });

  const child = await subcontract(engine, agent, job, n, pick.row, brief, amount);
  for (const f of shared)
    if (f && isFileName(f.name)) await saveJobFile(engine, child.id, f.name, f.content, 'client');
  await post(engine, {
    kind: 'helper_hired',
    tone: 'money',
    text: `${agent.name} hired ${pick.row.name} for part of a job, for ${formatUsd(amount)}.`,
    agentId: agent.id,
    jobId: child.id,
  });

  // The specialist works it now, by its own loop (this runs in the hiring agent's background task).
  const { runLoop } = await import('./loop.ts');
  const helper = (await loadAgent(engine, pick.row.id)) ?? pick.row;
  const out = await runLoop(engine, helper, child);
  await engine.db
    .update(jobs)
    .set({
      status: 'paid',
      stage: null,
      deliverable: out.delivered ?? '(no answer)',
      settledAt: new Date(),
    })
    .where(and(eq(jobs.id, child.id), eq(jobs.status, 'working')));
  await refreshBalance(engine, helper);

  // What came back is the hiring agent's to use: their answer and the files they wrote.
  const theirs = (await jobFilesOf(engine, child.id)).filter((f) => f.source === 'agent');
  const saved: string[] = [];
  const answer = `from_${pick.row.name}_${n}.md`.replace(/[^\w.-]/g, '_');
  await saveJobFile(engine, job.id, answer, out.delivered ?? '', 'tool:hire');
  saved.push(answer);
  for (const f of theirs) {
    const name = `from_${pick.row.name}_${f.name}`.replace(/[^\w.-]/g, '_').slice(0, 80);
    if (!isFileName(name)) continue;
    await saveJobFile(engine, job.id, name, f.content, 'tool:hire');
    saved.push(name);
  }
  if (!out.delivered)
    return {
      ok: false,
      observation: `${pick.row.name} couldn't finish the part (it ran out of turns or money). You paid ${formatUsd(amount)}.`,
      cost: amount,
    };
  return {
    ok: true,
    observation: `${pick.row.name} delivered:\n${out.delivered.slice(0, SEEN)}\n\n[saved as ${saved.join(', ')}]`,
    cost: amount,
  };
}

/** The subcontract job for one hire: made once per (job, step). */
async function subcontract(
  engine: Engine,
  agent: AgentRow,
  job: JobRow,
  n: number,
  helper: AgentRow,
  brief: string,
  amount: bigint,
): Promise<JobRow> {
  const found = () =>
    engine.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.parentJobId, job.id), eq(jobs.parentStep, n)));
  const [existing] = await found();
  if (existing) return existing;
  await engine.db
    .insert(jobs)
    .values({
      source: 'subcontract',
      category: job.category as Category,
      title: `Part of "${job.title.slice(0, 80)}"`,
      body: brief,
      budget: amount,
      price: amount,
      clientPlayerId: agent.ownerId,
      clientName: agent.name,
      clientStyle: 'quality',
      status: 'working',
      stage: 'work',
      awardedAgentId: helper.id,
      // Worked right away by the hiring agent's task, never by the work stages.
      nextAt: NEVER_TICK,
      openedTick: engine.clock.tick,
      createdDay: dayOf(engine),
      subcontracting: false,
      parentJobId: job.id,
      parentStep: n,
    })
    .onConflictDoNothing();
  const [row] = await found();
  if (!row) throw new Error('subcontract not written');
  return row;
}
