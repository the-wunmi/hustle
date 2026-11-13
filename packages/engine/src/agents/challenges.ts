import { randomBytes } from 'node:crypto';
import { type Category, createRng, DomainError, type Rng } from '@hustle/core';
import { agentCredentials, jobs, sandboxRuns } from '@hustle/db';
import { briefOf } from '@hustle/economy';
import { verifyCompletion } from '@hustle/nearai';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { reserveLive, settleLive } from '../brain/budget.ts';
import { attestationFor } from '../brain/think.ts';
import { dayOf, type Engine } from '../context.ts';
import { jobFilesOf, saveJobFile } from '../files.ts';
import type { PlayerRow } from '../players.ts';
import { post } from '../record.ts';
import { isRunning, startBackground } from '../world/background.ts';
import { NEVER_TICK } from '../world/jobs.ts';
import { loopEligible, runLoop } from '../world/loop.ts';
import { type AgentRow, tierOf } from './state.ts';

/**
 * Challenges: proof of a skill on fresh problems. Each attempt is generated from a new seed (new
 * ledgers, a new bug, a new token), and code works out the right answer for that instance, so nothing
 * can be memorised: a playbook that lists last time's answers fails. The agent works it with its own
 * loop and pays like any job; the same model, plain (one call, no playbook, no tools), sits the same
 * instance, so the record shows what the owner's craft adds.
 */
interface Instance {
  title: string;
  body: string;
  criteria: string;
  files: { name: string; content: string }[];
  /** How many checks the work passed, and of how many. */
  grade: (engine: Engine, work: Work) => Promise<{ passed: number; checks: number }>;
}

/** What an attempt produced: its text (delivery, written files, printed output) and its files. */
interface Work {
  text: string;
  files: Record<string, string>;
}

interface Challenge {
  id: string;
  name: string;
  category: Category;
  make: (rng: Rng) => Instance;
}

const cents = (n: number) =>
  `${n < 0 ? '-' : ''}${Math.floor(Math.abs(n) / 100)}.${String(Math.abs(n) % 100).padStart(2, '0')}`;
const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A money figure written either way: 67.00 or 67, with or without a thousands comma. */
const moneyRe = (n: number) => {
  const whole = Math.floor(Math.abs(n) / 100);
  const frac = String(Math.abs(n) % 100).padStart(2, '0');
  const w = `(${whole}|${whole.toLocaleString('en')})`.replace(/,/g, ',?');
  return new RegExp(`(^|[^\\d])${w}${frac === '00' ? '(\\.00)?' : `\\.${frac}`}(?!\\d)`);
};
const count = (checks: boolean[]) => ({
  passed: checks.filter(Boolean).length,
  checks: checks.length,
});

const reconciliation: Challenge = {
  id: 'reconciliation',
  name: 'Reconciliation',
  category: 'data_cleanup',
  make(rng) {
    const n = rng.int(12, 18);
    const first = rng.int(1000, 8000);
    const rows = Array.from({ length: n }, (_, i) => ({
      date: `2026-10-${String(1 + Math.floor((i * 30) / n)).padStart(2, '0')}`,
      ref: `T${first + i}`,
      what: rng.pick([
        'Client payment',
        'Supplier invoice',
        'Payroll',
        'Hosting',
        'Card fees',
        'Rent',
        'Travel',
        'Equipment',
      ]),
      amount: (rng.chance(0.4) ? 1 : -1) * rng.int(500, 600_000),
    }));
    const [a, b, c] = pickDistinct(rng, n, 3) as [number, number, number];
    const delta = (rng.chance(0.5) ? 1 : -1) * rng.int(100, 9_900);
    const books = rows
      .filter((_, i) => i !== a)
      .flatMap((r) => {
        const i = rows.indexOf(r);
        const row = i === b ? { ...r, amount: r.amount + delta } : r;
        return i === c ? [row, row] : [row];
      });
    const csv = (list: typeof rows) =>
      `date,ref,description,amount\n${list.map((r) => `${r.date},${r.ref},${r.what},${cents(r.amount)}`).join('\n')}\n`;
    const [missing, wrong, doubled] = [rows[a], rows[b], rows[c]];
    if (!missing || !wrong || !doubled) throw new Error('reconciliation rows');
    const net = missing.amount - delta - doubled.amount;
    const [ra, rb, rc] = [missing.ref, wrong.ref, doubled.ref];
    return {
      title: 'Challenge: reconcile a bank export against the books',
      body: 'Our books do not match the bank for October. Both exports are attached. Find every difference and tell us what to fix.',
      criteria:
        'Every transaction missing, duplicated or with a different amount, by reference, with the amount of each difference and the net difference in total, computed from the files.',
      files: [
        { name: 'bank.csv', content: csv(rows) },
        { name: 'books.csv', content: csv(books) },
      ],
      async grade(_engine, work) {
        const t = work.text;
        return count([
          new RegExp(`\\b${ra}\\b`).test(t),
          new RegExp(`\\b${rb}\\b`).test(t) && moneyRe(delta).test(t),
          new RegExp(`\\b${rc}\\b`).test(t) && /duplicat|twice|double/i.test(t),
          moneyRe(net).test(t),
        ]);
      },
    };
  },
};

const debugging: Challenge = {
  id: 'debugging',
  name: 'Debugging',
  category: 'code_review',
  make(rng) {
    const from = rng.pick([20, 25, 30, 40, 50, 60]);
    const bulk = rng.pick([10, 15, 20]);
    const [code, pct] = rng.pick([
      ['SAVE5', 5],
      ['TAKE10', 10],
      ['EXTRA8', 8],
    ] as const);
    const total = (units: number, each: number, coupon: boolean) =>
      units * each * (units >= from ? 1 - bulk / 100 : 1) * (coupon ? 1 - pct / 100 : 1);
    const check = (units: number, each: number, coupon: boolean, why = '') =>
      `assert abs(price(${units}, ${each.toFixed(1)}${coupon ? `, "${code}"` : ''}) - ${total(units, each, coupon).toFixed(4)}) < 0.006${why ? `, "${why}"` : ''}`;
    const tests = (cases: string[]) =>
      `from pricing import price\n\n${cases.join('\n')}\nprint("all tests passed")\n`;
    const visible = tests([
      check(10, 2, false),
      check(from, 2, false, `${from} units should get the bulk discount`),
      check(100, 1, true, `${code} is a further ${pct}%, not $${pct} off`),
      check(1, 1, true),
    ]);
    const hidden = tests([
      check(from - 1, 3, false),
      check(from + 7, 1.5, true),
      check(from, 4, true),
    ]);
    return {
      title: 'Challenge: make a failing function pass its tests',
      body: `pricing.py fails the checks in test_pricing.py. Find every bug and explain each in one line. Write the corrected file as pricing_fixed.py and show the tests passing against it.`,
      criteria:
        'Each failing check named with its cause; pricing_fixed.py with a corrected price() that passes every check in test_pricing.py (and keeps the documented behaviour).',
      files: [
        {
          name: 'pricing.py',
          content: `def price(units, unit_price, coupon=None):\n    """Order total: ${bulk}% off from ${from} units, a further ${pct}% with coupon ${code}, never below zero."""\n    total = units * unit_price\n    if units > ${from}:\n        total = total * ${(1 - bulk / 100).toFixed(2)}\n    if coupon == "${code}":\n        total = total - ${pct}\n    return round(max(total, 0), 2)\n`,
        },
        { name: 'test_pricing.py', content: visible },
      ],
      // The fixed file is run against the visible tests and against hidden ones it never saw.
      async grade(engine, work) {
        const fixed =
          work.files['pricing_fixed.py'] ??
          Object.entries(work.files).find(
            ([n, c]) => n.endsWith('.py') && /def price\(/.test(c),
          )?.[1] ??
          lastPriceBlock(work.text);
        const sandbox = engine.sandbox;
        if (!fixed || !sandbox) return { passed: 0, checks: 2 };
        const run = async (test: string) => {
          const out = await sandbox.run({
            code: test.replace('from pricing import price', ''),
            files: { 'pricing.py': fixed },
            timeoutMs: 10_000,
          });
          return out.error === null && out.stdout.includes('all tests passed');
        };
        const prelude =
          'import importlib.util, sys\nsys.path.insert(0, ".")\nfrom pricing import price\n';
        return count([await run(prelude + visible), await run(prelude + hidden)]);
      },
    };
  },
};

const holders: Challenge = {
  id: 'token-holders',
  name: 'Token due diligence',
  category: 'research',
  make(rng) {
    const supply = 1_000_000;
    const big = rng.int(1, 3);
    const names = [
      'team.multisig.near',
      'treasury.dao.near',
      'exchange-hot.near',
      'early-fund.near',
      'lp.pool.near',
      'market-maker.near',
      'angel.near',
      'ops.near',
      'grants.near',
      'advisor.near',
    ];
    const order = pickDistinct(rng, names.length, names.length).flatMap((i) => names[i] ?? []);
    const balances: { account: string; balance: number }[] = [];
    let left = supply;
    for (let i = 0; i < 10; i++) {
      const share = i < big ? rng.int(105, 300) / 1000 : rng.int(10, 90) / 1000;
      const bal = Math.min(Math.round(supply * share), left - 1000);
      balances.push({ account: order[i] ?? `holder-${i}.near`, balance: bal });
      left -= bal;
    }
    let k = 0;
    while (left > 0) {
      const bal = Math.min(left, rng.int(500, 3000));
      balances.push({ account: `holder-${String(++k).padStart(3, '0')}.near`, balance: bal });
      left -= bal;
    }
    const shuffled = pickDistinct(rng, balances.length, balances.length).flatMap(
      (i) => balances[i] ?? [],
    );
    const sorted = [...balances].sort((x, y) => y.balance - x.balance);
    const top10 = (sorted.slice(0, 10).reduce((t, h) => t + h.balance, 0) / supply) * 100;
    const over = sorted.filter((h) => h.balance / supply > 0.1);
    const pctRe = (p: number) =>
      new RegExp(
        `(^|[^\\d])(${reEscape(p.toFixed(1))}|${reEscape(p.toFixed(2))}|${Math.round(p)})\\s?%`,
      );
    return {
      title: 'Challenge: how concentrated is this token?',
      body: 'holders.csv lists every holder of a token (total supply 1,000,000). Before we buy: how concentrated is the supply, who holds more than 10%, and what is the risk of a large holder selling?',
      criteria:
        'The top-10 share of supply, every holder above 10% named with its share, and a short risk read. Use the attached file.',
      files: [
        {
          name: 'holders.csv',
          content: `account,balance\n${shuffled.map((h) => `${h.account},${h.balance}`).join('\n')}\n`,
        },
      ],
      async grade(_engine, work) {
        const t = work.text;
        return count([
          pctRe(top10).test(t),
          ...over.map((h) => t.includes(h.account) && pctRe((h.balance / supply) * 100).test(t)),
        ]);
      },
    };
  },
};

export const CHALLENGES: readonly Challenge[] = [reconciliation, debugging, holders];

function pickDistinct(rng: Rng, n: number, k: number): number[] {
  const all = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = rng.int(0, i);
    const swap = all[i] ?? i;
    all[i] = all[j] ?? j;
    all[j] = swap;
  }
  return all.slice(0, k);
}

/**
 * The last `def price(` the work shows, fenced or not: the def line and the indented lines after it,
 * up to the first line back at the margin.
 */
function lastPriceBlock(text: string): string | null {
  const start = text.lastIndexOf('def price(');
  if (start === -1) return null;
  const lines = text.slice(start).split('\n');
  const body = [lines[0] ?? ''];
  for (const line of lines.slice(1)) {
    if (line.trim() && !/^\s/.test(line)) break;
    body.push(line);
  }
  return `${body.join('\n').trimEnd()}\n`;
}

/** An instance from its seed: the same seed always makes the same problem and the same answer. */
export function instanceOf(challengeId: string, seed: string): Instance | null {
  const c = CHALLENGES.find((x) => x.id === challengeId);
  return c ? c.make(createRng(`${challengeId}:${seed}`)) : null;
}

/** What the agent produced on a job: its delivery, its own files and what its code printed. */
async function workOf(engine: Engine, jobId: string): Promise<Work> {
  const [job] = await engine.db.select().from(jobs).where(eq(jobs.id, jobId));
  const mine = (await jobFilesOf(engine, jobId)).filter((f) => f.source === 'agent');
  const runs = await engine.db.select().from(sandboxRuns).where(eq(sandboxRuns.jobId, jobId));
  return {
    text: [
      job?.deliverable ?? '',
      ...mine.map((f) => f.content),
      ...runs.map((r) => r.stdout),
    ].join('\n\n'),
    files: Object.fromEntries(mine.map((f) => [f.name, f.content])),
  };
}

const OUT_TOKENS = 2_000;

/**
 * The same model, plain, on the same instance: the brief and the files in one call, no playbook, no
 * tools, no memory. Paid from Hustle's live AI budget; verified like every call. Null when it can't run.
 */
async function plainAttempt(engine: Engine, model: string, inst: Instance): Promise<Work | null> {
  if (engine.nearai.mode !== 'live') return null;
  const brain = Object.values(engine.brains).find((b) => b.model === model);
  if (!brain) return null;
  const prompt = [
    briefOf({ body: inst.body, criteria: inst.criteria, files: inst.files }),
    ...inst.files.map((f) => `--- ${f.name} ---\n${f.content}`),
    'Answer the task in full. Show any code you write in a ```python block.',
  ].join('\n\n');
  const inTokens = Math.ceil(prompt.length / 3.5);
  const worst =
    ((BigInt(Math.ceil(inTokens * 1.5)) * brain.inputPerM +
      BigInt(OUT_TOKENS * 2) * brain.outputPerM) *
      1000n) /
    1_000_000n;
  const day = await reserveLive(engine, worst);
  if (!day) return null;
  let billed: bigint | undefined;
  try {
    const attestation = await attestationFor(engine, engine.nearai, model);
    const key = (await engine.nearai.createAgentKey('hustle challenges', 10n ** 9n)).key;
    const result = await engine.nearai.chat(key, {
      model,
      max_tokens: OUT_TOKENS * 2,
      messages: [{ role: 'user', content: prompt }],
    });
    billed = (await engine.nearai.costs([result.inferenceId]))[result.inferenceId];
    const verification = verifyCompletion(
      'live',
      result,
      await engine.nearai.signature(result.chatId),
      attestation.report,
      attestation.nonce,
    );
    if (!verification.passed || !result.content) return null;
    return { text: result.content, files: {} };
  } catch (err) {
    engine.log('plain attempt failed', { error: String(err) });
    return null;
  } finally {
    await settleLive(engine, day, worst, billed ?? worst);
  }
}

/**
 * The owner has the agent take a fresh challenge: a job of its own (source `challenge`), worked by
 * its loop and paid from its wallet, graded by code, and set beside the plain model on the same
 * instance. The tally per challenge is public; the attempt's job keeps the evidence.
 */
export async function takeChallenge(
  engine: Engine,
  player: PlayerRow,
  agent: AgentRow,
  input: { challengeId?: unknown },
): Promise<{ jobId: string }> {
  const challenge = CHALLENGES.find((c) => c.id === input.challengeId);
  if (!challenge) throw new DomainError('invalid', 'No such challenge');
  if (agent.ownerId !== player.id) throw new DomainError('not_found', 'Agent not found');
  const key = `challenge:${agent.id}`;
  if (isRunning(key)) throw new DomainError('conflict', `${agent.name} is already on a challenge`);
  const seed = randomBytes(8).toString('hex');
  const inst = challenge.make(createRng(`${challenge.id}:${seed}`));
  const draft = {
    source: 'challenge',
    category: challenge.category,
    title: inst.title,
    body: briefOf(inst),
    criteria: inst.criteria,
    budget: 0n,
    clientPlayerId: player.id,
    clientName: 'Hustle challenges',
    clientStyle: 'quality',
    status: 'working',
    stage: 'work',
    awardedAgentId: agent.id,
    nextAt: NEVER_TICK,
    openedTick: engine.clock.tick,
    createdDay: dayOf(engine),
    subcontracting: false,
    // The seed regenerates the instance (and its answer) for grading; it is not shown to the agent.
    marketRef: `challenge:${challenge.id}:${seed}`,
  } as const;
  if (!loopEligible(engine, agent, { ...draft, id: '' } as never))
    throw new DomainError(
      'conflict',
      `${agent.name} needs a live brain and tools to take a challenge`,
    );
  const [job] = await engine.db.insert(jobs).values(draft).returning();
  if (!job) throw new DomainError('unavailable', 'Could not start the challenge');
  for (const f of inst.files) await saveJobFile(engine, job.id, f.name, f.content, 'client');
  startBackground(engine, 'challenge', 4, key, async () => {
    const out = await runLoop(engine, agent, job);
    await engine.db
      .update(jobs)
      .set({
        status: 'graded',
        stage: null,
        deliverable: out.delivered ?? '(no answer)',
        settledAt: new Date(),
      })
      .where(eq(jobs.id, job.id));
    const mine = await inst.grade(engine, await workOf(engine, job.id));
    const model = engine.brains[tierOf(agent)].model;
    const plainWork = await plainAttempt(engine, model, inst);
    const plain = plainWork ? await inst.grade(engine, plainWork) : null;
    const solved = mine.passed === mine.checks;
    await engine.db
      .insert(agentCredentials)
      .values({
        agentId: agent.id,
        challengeId: challenge.id,
        attempts: 1,
        solved: solved ? 1 : 0,
        plainAttempts: plain ? 1 : 0,
        plainSolved: plain && plain.passed === plain.checks ? 1 : 0,
        lastJobId: job.id,
      })
      .onConflictDoUpdate({
        target: [agentCredentials.agentId, agentCredentials.challengeId],
        set: {
          attempts: sql`${agentCredentials.attempts} + 1`,
          solved: sql`${agentCredentials.solved} + ${solved ? 1 : 0}`,
          plainAttempts: sql`${agentCredentials.plainAttempts} + ${plain ? 1 : 0}`,
          plainSolved: sql`${agentCredentials.plainSolved} + ${plain && plain.passed === plain.checks ? 1 : 0}`,
          lastJobId: job.id,
          updatedAt: new Date(),
        },
      });
    await engine.db
      .update(jobs)
      .set({
        quality: mine.passed / mine.checks,
        // The grade, for the job page: this attempt's checks beside the plain model's.
        plan: {
          challenge: {
            passed: mine.passed,
            checks: mine.checks,
            plain: plain ? { passed: plain.passed, checks: plain.checks } : null,
          },
        },
      })
      .where(eq(jobs.id, job.id));
    await post(engine, {
      kind: 'work',
      tone: solved ? 'good' : 'neutral',
      text: `${agent.name} ${solved ? 'solved' : 'took'} a fresh ${challenge.name} challenge: ${mine.passed}/${mine.checks} checks${plain ? ` (the same model plain: ${plain.passed}/${plain.checks})` : ''}.`,
      agentId: agent.id,
      jobId: job.id,
    });
  });
  return { jobId: job.id };
}

/** An agent's challenge record: per challenge, fresh attempts solved, beside the plain model. */
export async function challengesOf(engine: Engine, agentId: string) {
  const rows = await engine.db
    .select()
    .from(agentCredentials)
    .where(eq(agentCredentials.agentId, agentId));
  return CHALLENGES.map((c) => {
    const r = rows.find((x) => x.challengeId === c.id);
    return {
      id: c.id,
      name: c.name,
      category: c.category,
      attempts: r?.attempts ?? 0,
      solved: r?.solved ?? 0,
      plainAttempts: r?.plainAttempts ?? 0,
      plainSolved: r?.plainSolved ?? 0,
      lastJobId: r?.lastJobId ?? null,
    };
  });
}

export const TakeChallenge = z.object({ challengeId: z.string() });
