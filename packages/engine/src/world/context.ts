import { type Category, formatUsd } from '@hustle/core';
import { agents } from '@hustle/db';
import {
  ACT_CALL,
  BID_CALL,
  type CallSpec,
  REFLECT_CALL,
  toolById,
  toolCall,
  toolCost,
  workCalls,
} from '@hustle/economy';
import { and, eq, isNotNull, isNull, ne } from 'drizzle-orm';
import { recall } from '../agents/memory.ts';
import {
  type AgentRow,
  avgRating100,
  rulebookOf,
  snapshotOf,
  tierOf,
  traitsOf,
} from '../agents/state.ts';
import type { BrainContext, Purpose } from '../brain/prompts.ts';
import type { Engine } from '../context.ts';
import { usableTools } from '../tools/index.ts';
import { type JobRow, jobSnapshot } from './jobs.ts';

const rulesInWords = (agent: AgentRow): string => {
  const r = rulebookOf(agent);
  return [
    `Daily spending cap ${formatUsd(r.dailyCap)}, ${formatUsd(r.maxPerCall)} per payment, ${formatUsd(r.maxPerJob)} per job.`,
    r.anyVendor
      ? 'Any vendor may be paid.'
      : `Only these vendors may be paid: ${r.allowedVendors.map((v) => v.split('.')[0]).join(', ') || 'none'}.`,
    r.mayHire ? `May hire helpers up to ${formatUsd(r.helperBudget)}.` : 'May not hire helpers.',
  ].join(' ');
};

export function workloadFor(agent: AgentRow, job: JobRow, purpose: Purpose): CallSpec {
  if (purpose === 'bid') return BID_CALL;
  if (purpose === 'reflect') return REFLECT_CALL;
  if (purpose === 'act') return ACT_CALL;
  const calls = workCalls(snapshotOf(agent), jobSnapshot(job, null));
  const call = calls.find((c) => c.purpose === purpose) ?? calls.at(-1);
  return call ?? { purpose, inTokens: 1000, outTokens: 300 };
}

export async function helperCandidates(
  engine: Engine,
  agent: AgentRow,
  category: Category,
): Promise<AgentRow[]> {
  const rows = await engine.db
    .select()
    .from(agents)
    .where(
      and(
        isNotNull(agents.accountId),
        isNull(agents.dormantSinceDay),
        eq(agents.hidden, false),
        ne(agents.id, agent.id),
      ),
    );
  return rows
    .filter((a) => ((a.skills as Record<string, { level: number }>)[category]?.level ?? 0) > 0)
    .sort((a, b) => (avgRating100(b) ?? 300) - (avgRating100(a) ?? 300))
    .slice(0, 3);
}

/** A tool's action in the agent loop. */
const LOOP_ACTION: Record<string, string> = { web_search: 'search', chain_data: 'chain' };

export async function brainContext<P extends Purpose>(
  engine: Engine,
  agent: AgentRow,
  job: JobRow,
  purpose: P,
  extra: {
    draft?: string;
    helpers?: AgentRow[];
    outcome?: BrainContext['outcome'];
    tool?: BrainContext['tool'];
    notes?: string[];
    files?: BrainContext['files'];
    runs?: BrainContext['runs'];
    steps?: BrainContext['steps'];
    budget?: BrainContext['budget'];
    specialists?: BrainContext['specialists'];
    canAsk?: boolean;
  } = {},
): Promise<BrainContext<P>> {
  const spec = extra.tool ? toolById(extra.tool.id) : undefined;
  const workload = spec ? toolCall(spec) : workloadFor(agent, job, purpose);
  const category = job.category as Category;
  // Memory is recalled for the work itself; the playbook is read on every call. Work calls already
  // count both in `workCalls` (contextTokens); bids and reflections add the playbook here.
  const memory =
    purpose === 'plan' || purpose === 'draft' || purpose === 'review' || purpose === 'act'
      ? await recall(engine, agent, job)
      : [];
  const extraTokens =
    (purpose === 'bid' || purpose === 'reflect' || purpose === 'tool' || purpose === 'act'
      ? Math.ceil(agent.playbook.length / 4)
      : 0) +
    Math.ceil((extra.notes ?? []).join('\n').length / 4) +
    Math.ceil((extra.files ?? []).reduce((t, f) => t + f.preview.length + 40, 0) / 4) +
    Math.ceil(JSON.stringify(extra.steps ?? []).length / 4);
  return {
    purpose,
    persona: { name: agent.name, traits: traitsOf(agent), tier: tierOf(agent) },
    job: { title: job.title, category, budget: formatUsd(job.budget), client: job.clientName },
    tools:
      purpose === 'plan'
        ? usableTools(engine, agent, job).map((t) => ({
            handle: t.id,
            price: formatUsd(toolCost(t, engine.brains[tierOf(agent)])),
            helps: t.description,
          }))
        : purpose === 'act'
          ? // The loop names tools by their action (search, python, ...), priced per use.
            usableTools(engine, agent, job, { loop: true }).map((t) => ({
              handle: LOOP_ACTION[t.id] ?? t.id,
              price: formatUsd(t.fee),
              helps: t.description,
            }))
          : [],
    helpers:
      purpose === 'plan' && rulebookOf(agent).mayHire
        ? (extra.helpers ?? []).map((h) => ({
            name: h.name,
            rating: ((avgRating100(h) ?? 0) / 100).toFixed(1),
          }))
        : [],
    rules: rulesInWords(agent),
    workload: { inTokens: workload.inTokens + extraTokens, outTokens: workload.outTokens },
    ...(extra.draft ? { draft: extra.draft } : {}),
    ...(memory.length ? { memory } : {}),
    ...(extra.outcome ? { outcome: extra.outcome } : {}),
    ...(extra.tool ? { tool: extra.tool } : {}),
    ...(extra.notes?.length ? { notes: extra.notes } : {}),
    ...(extra.files ? { files: extra.files } : {}),
    ...(extra.runs?.length ? { runs: extra.runs } : {}),
    ...(extra.steps ? { steps: extra.steps } : {}),
    ...(extra.budget ? { budget: extra.budget } : {}),
    ...(extra.specialists?.length ? { specialists: extra.specialists } : {}),
    ...(extra.canAsk ? { canAsk: true } : {}),
    ...(agent.playbook ? { playbook: agent.playbook } : {}),
  };
}
