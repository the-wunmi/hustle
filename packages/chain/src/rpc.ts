import { JsonRpcProvider } from 'near-api-js';

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
}

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
    }));
    this.spacingMs = opts.maxPerSecond ? 1000 / opts.maxPerSecond : 0;
    this.deadlineMs = opts.deadlineMs ?? 90_000;
  }

  /** The endpoint to use now: the first not resting, else the one that wakes soonest. */
  private pick(): Endpoint {
    const now = Date.now();
    const awake = this.endpoints.filter((e) => e.coolUntil <= now);
    const pool = awake.length > 0 ? awake : this.endpoints;
    return pool.reduce((best, e) =>
      Math.max(e.nextAt, e.coolUntil) < Math.max(best.nextAt, best.coolUntil) ? e : best,
    );
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
        const result = await ep.inner.sendJsonRpc(method, params);
        ep.strikes = 0;
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
