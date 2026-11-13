import type { Engine } from '../context.ts';
import { saveJobFile } from '../files.ts';
import type { ToolRunner } from './index.ts';

/** NEAR account ids named in a brief that could be token contracts (at most three). */
export function tokenIdsIn(text: string): string[] {
  const found = text.toLowerCase().match(/\b[a-z0-9_-]+(?:\.[a-z0-9_-]+)*\.near\b/g) ?? [];
  return [...new Set(found)].slice(0, 3);
}

const FETCH_MS = 15_000;
const TOP_HOLDERS = 25;

async function getJson(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_MS) });
  if (!res.ok) throw new Error(`${new URL(url).host} returned ${res.status}`);
  return res.json();
}

/** A read-only view call on NEAR mainnet. */
async function view(engine: Engine, account: string, method: string): Promise<unknown> {
  const body = (await getJson(engine.mainnetRpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'query',
      params: {
        request_type: 'call_function',
        finality: 'final',
        account_id: account,
        method_name: method,
        args_base64: Buffer.from('{}').toString('base64'),
      },
    }),
  })) as { result?: { result?: number[] }; error?: unknown };
  if (!body.result?.result) throw new Error(`${account} has no ${method}`);
  return JSON.parse(Buffer.from(body.result.result).toString('utf8'));
}

interface TokenData {
  token_id: string;
  name: string;
  symbol: string;
  decimals: number;
  total_supply: string;
  top_holders: { account_id: string; balance: string }[];
  fetched_at: string;
  sources: string[];
}

async function tokenData(engine: Engine, token: string): Promise<TokenData> {
  const meta = (await view(engine, token, 'ft_metadata')) as {
    name?: string;
    symbol?: string;
    decimals?: number;
  };
  const supply = (await view(engine, token, 'ft_total_supply')) as string;
  const holdersUrl = `${engine.fastNearApiUrl}/v1/ft/${encodeURIComponent(token)}/top`;
  const holders = (await getJson(holdersUrl)) as {
    accounts?: { account_id: string; balance: string }[];
  };
  if (typeof supply !== 'string' || !/^\d+$/.test(supply))
    throw new Error(`${token}: no total supply`);
  return {
    token_id: token,
    name: String(meta.name ?? '').slice(0, 80),
    symbol: String(meta.symbol ?? '').slice(0, 20),
    decimals: Number(meta.decimals ?? 0),
    total_supply: supply,
    top_holders: (holders.accounts ?? [])
      .filter((h) => typeof h.account_id === 'string' && /^\d+$/.test(h.balance))
      .slice(0, TOP_HOLDERS),
    fetched_at: new Date().toISOString(),
    sources: [`${engine.mainnetRpcUrl} (ft_metadata, ft_total_supply)`, holdersUrl],
  };
}

/** Share of supply as a percentage with one decimal, from integer strings. */
const pct = (part: string, whole: string): string =>
  whole === '0' ? '0' : (Number((BigInt(part) * 1000n) / BigInt(whole)) / 10).toFixed(1);

function summary(t: TokenData): string {
  const top10 = t.top_holders.slice(0, 10);
  const held = top10.reduce((s, h) => s + BigInt(h.balance), 0n).toString();
  return [
    `${t.symbol || t.token_id} (${t.token_id}), ${t.decimals} decimals, total supply ${t.total_supply} (base units).`,
    `Top 10 holders hold ${pct(held, t.total_supply)}% of supply:`,
    ...top10.map((h, i) => `${i + 1}. ${h.account_id}: ${pct(h.balance, t.total_supply)}%`),
    `Full data in token_${t.token_id}.json (top ${t.top_holders.length} holders). Read from NEAR mainnet at ${t.fetched_at}.`,
  ].join('\n');
}

export const chainData: ToolRunner = {
  id: 'chain_data',
  async run(engine, _agent, job, _spec, use) {
    const tokens = tokenIdsIn(use?.input ?? `${job.title}\n${job.body}`);
    if (tokens.length === 0) return { ok: false, reason: 'unavailable' };
    const notes: string[] = [];
    const sources: { title: string; url: string }[] = [];
    for (const token of tokens) {
      try {
        const data = await tokenData(engine, token);
        await saveJobFile(
          engine,
          job.id,
          `token_${token}.json`,
          JSON.stringify(data, null, 1),
          'tool:chain_data',
        );
        notes.push(summary(data));
        sources.push({
          title: `${data.symbol || token} on NEAR (nearblocks)`,
          url: `https://nearblocks.io/token/${encodeURIComponent(token)}`,
        });
      } catch (err) {
        notes.push(
          `${token}: not a token the chain could describe (${String(err).slice(0, 120)}).`,
        );
      }
    }
    if (sources.length === 0) return { ok: false, reason: 'unavailable' };
    return { ok: true, notes: notes.join('\n\n'), sources, cost: 0n };
  },
};
