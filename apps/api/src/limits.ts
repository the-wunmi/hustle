import { DomainError } from '@hustle/core';

/**
 * A fixed-window counter per key (an IP, a player). In memory: the API is one process, and losing the
 * counts on restart only resets the windows.
 */
export class RateLimit {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly message: string,
  ) {}

  take(key: string): void {
    const now = Date.now();
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      if (this.hits.size > 10_000) this.sweep(now);
      return;
    }
    if (entry.count >= this.max) throw new DomainError('rate_limited', this.message);
    entry.count += 1;
  }

  private sweep(now: number): void {
    for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
  }
}
