import { type Category, formatUsd } from '@hustle/core';
import { agents } from '@hustle/db';
import { BID_CALL, type CallSpec, honestVendors, workCalls } from '@hustle/economy';
import { and, eq, isNotNull, isNull, ne } from 'drizzle-orm';
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

export async function brainContext<P extends Purpose>(
  _engine: Engine,
  agent: AgentRow,
  job: JobRow,
  purpose: P,
  extra: { draft?: string; helpers?: AgentRow[] } = {},
): Promise<BrainContext<P>> {
  const workload = workloadFor(agent, job, purpose);
  const category = job.category as Category;
  return {
    purpose,
    persona: { name: agent.name, traits: traitsOf(agent), tier: tierOf(agent) },
    job: { title: job.title, category, budget: formatUsd(job.budget), client: job.clientName },
    tools:
      purpose === 'plan'
        ? honestVendors()
            .filter((v) => v.helps.includes(category))
            .map((v) => ({ handle: v.handle, price: formatUsd(v.price), helps: v.description }))
        : [],
    helpers:
      purpose === 'plan' && rulebookOf(agent).mayHire
        ? (extra.helpers ?? []).map((h) => ({
            name: h.name,
            rating: ((avgRating100(h) ?? 0) / 100).toFixed(1),
          }))
        : [],
    rules: rulesInWords(agent),
    workload: { inTokens: workload.inTokens, outTokens: workload.outTokens },
    ...(extra.draft ? { draft: extra.draft } : {}),
  };
}
