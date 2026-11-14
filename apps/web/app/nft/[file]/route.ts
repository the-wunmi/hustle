import type { AgentView } from '@hustle/core/browser';
import { agentCardJson, agentCardSvg } from '@/lib/nft-card';

const API_ORIGIN = process.env.HUSTLE_API_ORIGIN ?? 'http://localhost:4300';
/** Wallets cache images; a minute keeps the card close to the agent's live state. */
const CACHE = 'public, max-age=60, stale-while-revalidate=300';

/** `/nft/<token id>.svg` (the card) and `/nft/<token id>.json` (its attributes), per agent NFT. */
export async function GET(req: Request, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  const match = /^([a-z0-9._-]{2,64})\.(svg|json)$/.exec(file);
  if (!match) return new Response('Not found', { status: 404 });
  const [, tokenId, kind] = match;
  const res = await fetch(`${API_ORIGIN}/api/agents/${tokenId}`, { cache: 'no-store' });
  if (!res.ok) return new Response('Not found', { status: 404 });
  const agent = (await res.json()) as AgentView;
  if (kind === 'svg')
    return new Response(agentCardSvg(agent), {
      headers: { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': CACHE },
    });
  // Links come from the configured public URL, never from request headers a client can set.
  const origin = (process.env.PUBLIC_ORIGIN || new URL(req.url).origin).replace(/\/$/, '');
  return Response.json(agentCardJson(agent, origin), {
    headers: { 'cache-control': CACHE, 'access-control-allow-origin': '*' },
  });
}
