import { JsonRpcProvider } from 'near-api-js';

type BlockReference = Parameters<JsonRpcProvider['viewBlock']>[0];
type BlockResult = Awaited<ReturnType<JsonRpcProvider['viewBlock']>>;

/** What the game's RPC traffic looked like: for logs and the testnet report. */
export interface RpcStats {
  requests: number;
  /** Answers the RPC refused for its rate limit (HTTP 429 or JSON-RPC -429). */
  rateLimited: number;
  /** Requests that failed at the transport (5xx, timeouts, refused connections). */
  transportErrors: number;
  /** Requests moved to another endpoint after one refused or failed. */
  failovers: number;
  byUrl: Record<string, number>;
  byMethod: Record<string, number>;
}

export interface PacedRpcOptions {
  /** Endpoints in order of preference; later ones take over while earlier ones cool down. */
  urls: string[];
  /** Most requests per second to any one endpoint (default: unlimited, for a local node). */
  maxPerSecond?: number;
  /** How long one request may keep trying across endpoints before it fails (default 90 s). */
  deadlineMs?: number;
  /**
   * How long the latest final block may be reused as transactions' reference block (default 0:
   * never). A transaction stays valid for about a day of blocks after its reference, so a block
   * under a minute old is as good as a fresh one, and saves one request per transaction.
   */
  finalBlockMaxAgeMs?: number;
}

interface Endpoint {
  url: string;
  inner: JsonRpcProvider;
  /** Earliest time the next request may go to this endpoint (pacing). */
  nextAt: number;
  /** Until when this endpoint is resting after refusing or failing. */
  coolUntil: number;
  /** Consecutive refusals, for a growing rest. */
  strikes: number;
  /** Recent answer time for ordinary reads (ms; 0 until measured), so slow endpoints serve overflow. */
  latencyMs: number;
}

/** Calls whose answer time is the chain's, not the endpoint's: left out of its measured speed. */
const WAITS_FOR_CHAIN = new Set(['send_tx', 'broadcast_tx_commit', 'tx', 'EXPERIMENTAL_tx_status']);
/** Blocks looked up by hash never change; this many are kept. */
const BLOCKS_BY_HASH = 256;

const isRateLimit = (err: unknown) =>
  /429|rate limit/i.test(String((err as Error)?.message ?? err));
const isTransport = (err: unknown) =>
  /Internal server error|Timeout error|Bad Gateway|unavailable|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|RetriesExceeded|socket hang up/i.test(
    `${String((err as Error)?.message ?? err)} ${(err as { type?: string })?.type ?? ''}`,
  );

/**
 * A JSON-RPC provider for public endpoints with rate limits: it paces requests per endpoint, and
 * when one refuses (429) or fails at the transport it rests that endpoint and sends the request to
 * the next. A request fails only after every endpoint has refused it for `deadlineMs`. Contract and
 * protocol errors are answers, not failures, and go straight back to the caller. Every gateway call
 * (views, transactions, status checks) goes through `sendJsonRpc`, so all of it is paced.
 */
export class PacedRpcProvider extends JsonRpcProvider {
  private readonly endpoints: Endpoint[];
  private readonly spacingMs: number;
  private readonly deadlineMs: number;
  private readonly finalBlockMaxAgeMs: number;
  private finalBlock: { at: number; block: BlockResult } | null = null;
  private finalBlockPending: Promise<BlockResult> | null = null;
  private readonly blocksByHash = new Map<string, BlockResult>();
  readonly stats: RpcStats = {
    requests: 0,
    rateLimited: 0,
    transportErrors: 0,
    failovers: 0,
    byUrl: {},
    byMethod: {},
  };

  constructor(opts: PacedRpcOptions) {
    if (opts.urls.length === 0) throw new Error('PacedRpcProvider needs at least one URL');
    super({ url: opts.urls[0] ?? '' });
    // The library's own retry waits up to ~30 s on a 429 before giving up; here an endpoint is
    // tried once or twice, then the next one takes the request.
    this.endpoints = opts.urls.map((url) => ({
      url,
      inner: new JsonRpcProvider({ url }, { retries: 2, wait: 200, backoff: 1.5 }),
      nextAt: 0,
      coolUntil: 0,
      strikes: 0,
      latencyMs: 0,
    }));
    this.spacingMs = opts.maxPerSecond ? 1000 / opts.maxPerSecond : 0;
    this.deadlineMs = opts.deadlineMs ?? 90_000;
    this.finalBlockMaxAgeMs = opts.finalBlockMaxAgeMs ?? 0;
  }

  /**
   * The endpoint that would answer soonest: its wait for a pacing slot plus how long it usually
   * takes. A fast endpoint keeps the traffic and slow ones take only the overflow; resting
   * endpoints are used only when every one is resting. Ties go to the earlier URL.
   */
  private pick(): Endpoint {
    const now = Date.now();
    const awake = this.endpoints.filter((e) => e.coolUntil <= now);
    const pool = awake.length > 0 ? awake : this.endpoints;
    const eta = (e: Endpoint) => Math.max(e.nextAt, e.coolUntil, now) - now + e.latencyMs;
    return pool.reduce((best, e) => (eta(e) < eta(best) ? e : best));
  }

  /** Drops the reused reference block, so the next transaction reads a fresh one. */
  forgetFinalBlock(): void {
    this.finalBlock = null;
  }

  override async viewBlock(query: BlockReference): Promise<BlockResult> {
    if ('finality' in query && query.finality === 'final' && this.finalBlockMaxAgeMs > 0) {
      const kept = this.finalBlock;
      if (kept && Date.now() - kept.at < this.finalBlockMaxAgeMs) return kept.block;
      this.finalBlockPending ??= super
        .viewBlock(query)
        .then((block) => {
          this.finalBlock = { at: Date.now(), block };
          return block;
        })
        .finally(() => {
          this.finalBlockPending = null;
        });
      return this.finalBlockPending;
    }
    if ('blockId' in query && typeof query.blockId === 'string') {
      const kept = this.blocksByHash.get(query.blockId);
      if (kept) return kept;
      const block = await super.viewBlock(query);
      if (this.blocksByHash.size >= BLOCKS_BY_HASH) {
        const oldest = this.blocksByHash.keys().next();
        if (!oldest.done) this.blocksByHash.delete(oldest.value);
      }
      this.blocksByHash.set(query.blockId, block);
      return block;
    }
    return super.viewBlock(query);
  }

  // biome-ignore lint/suspicious/noExplicitAny: the base signature is generic over the RPC method map; this forwards any method unchanged.
  override async sendJsonRpc(method: any, params: any): Promise<any> {
    const started = Date.now();
    let lastErr: unknown;
    let tries = 0;
    for (;;) {
      const ep = this.pick();
      const now = Date.now();
      const wait = Math.max(ep.nextAt, ep.coolUntil) - now;
      ep.nextAt = Math.max(now, ep.nextAt, ep.coolUntil) + this.spacingMs;
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      if (tries > 0) this.stats.failovers++;
      tries++;
      this.stats.requests++;
      this.stats.byUrl[ep.url] = (this.stats.byUrl[ep.url] ?? 0) + 1;
      const what =
        method === 'query' ? `query:${(params as { request_type?: string }).request_type}` : method;
      this.stats.byMethod[what] = (this.stats.byMethod[what] ?? 0) + 1;
      try {
        const sentAt = Date.now();
        const result = await ep.inner.sendJsonRpc(method, params);
        ep.strikes = 0;
        if (!WAITS_FOR_CHAIN.has(method)) {
          const ms = Date.now() - sentAt;
          ep.latencyMs = ep.latencyMs === 0 ? ms : Math.round(ep.latencyMs * 0.8 + ms * 0.2);
        }
        return result;
      } catch (err) {
        const limited = isRateLimit(err);
        if (!limited && !isTransport(err)) throw err;
        if (limited) this.stats.rateLimited++;
        else this.stats.transportErrors++;
        ep.strikes++;
        ep.coolUntil = Date.now() + Math.min(30_000, 1_000 * 2 ** (ep.strikes - 1));
        lastErr = err;
        if (Date.now() - started > this.deadlineMs) throw lastErr;
      }
    }
  }
}
