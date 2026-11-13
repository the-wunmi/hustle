import type { ProviderToolResult } from '@hustle/nearai';
import { think } from '../brain/think.ts';
import { brainContext } from '../world/context.ts';
import type { ToolRunner } from './index.ts';

/** NEAR AI Cloud's provider-side search on chat completions (docs.near.ai/cloud/guides/web-search). */
const PROVIDER_TOOL = 'web_context_search';

/**
 * Sources from a search result: NEAR AI returns numbered entries, `[n] Title` then the URL on the
 * next line (verified live 2026-11-13).
 */
export function searchSources(results: ProviderToolResult[]): { title: string; url: string }[] {
  const out: { title: string; url: string }[] = [];
  for (const r of results) {
    if (r.name !== PROVIDER_TOOL || r.status !== 'ok') continue;
    const lines = r.output.split('\n');
    lines.forEach((line, i) => {
      const title = /^\[\d+\]\s+(.+)$/.exec(line.trim())?.[1];
      const url = lines[i + 1]?.trim();
      if (title && url && /^https?:\/\//.test(url) && !out.some((s) => s.url === url))
        out.push({ title: title.slice(0, 200), url: url.slice(0, 500) });
    });
  }
  return out.slice(0, 20);
}

export const webSearch: ToolRunner = {
  id: 'web_search',
  async run(engine, agent, job, spec, use) {
    const ctx = await brainContext(engine, agent, job, 'tool', {
      tool: { id: spec.id, name: spec.name, description: spec.description },
    });
    const key = use?.key ?? `tool:${spec.id}:${job.id}`;
    const body = use ? `${job.body}\n\nSearch the web for: ${use.input}` : job.body;
    const result = await think(engine, agent, key, job.id, ctx, body, {
      provider: [{ type: PROVIDER_TOOL }],
      feePerUse: spec.fee,
      expectedUses: spec.usesPerCall,
      uses: (results) =>
        results.filter((r) => r.name === PROVIDER_TOOL && r.status === 'ok').length,
      sources: searchSources,
    });
    if (!result.ok) return { ok: false, reason: result.reason };
    const out = result.output as { notes: string; sources: { title: string; url: string }[] };
    return { ok: true, notes: out.notes, sources: out.sources, cost: result.cost };
  },
};
