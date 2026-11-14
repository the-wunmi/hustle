import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PacedRpcProvider } from '../src/rpc.ts';

/** A stand-in JSON-RPC endpoint that answers after `delayMs` and counts calls by method. */
async function endpoint(delayMs: number) {
  const calls: Record<string, number> = {};
  let height = 100;
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      const { id, method, params } = JSON.parse(body);
      calls[method] = (calls[method] ?? 0) + 1;
      const result =
        method === 'block'
          ? {
              header: {
                height: params.block_id ? 1 : height++,
                hash: params.block_id ?? `h${height}`,
                timestamp_nanosec: '0',
              },
              chunks: [],
            }
          : { amount: '1', locked: '0', code_hash: '', storage_usage: 0, block_height: 1 };
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
      }, delayMs);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, calls, close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe('PacedRpcProvider', () => {
  let fast: Awaited<ReturnType<typeof endpoint>>;
  let slow: Awaited<ReturnType<typeof endpoint>>;
  beforeAll(async () => {
    fast = await endpoint(5);
    slow = await endpoint(300);
  });
  afterAll(async () => {
    await fast.close();
    await slow.close();
  });

  it('reuses a recent final block as the reference block, one request for concurrent callers', async () => {
    const before = fast.calls.block ?? 0;
    const p = new PacedRpcProvider({ urls: [fast.url], finalBlockMaxAgeMs: 30_000 });
    const blocks = await Promise.all(
      Array.from({ length: 5 }, () => p.viewBlock({ finality: 'final' })),
    );
    await p.viewBlock({ finality: 'final' });
    expect(new Set(blocks.map((b) => b.header.hash)).size).toBe(1);
    expect((fast.calls.block ?? 0) - before).toBe(1);
  });

  it('reads a fresh final block every time unless reuse is turned on', async () => {
    const before = fast.calls.block ?? 0;
    const p = new PacedRpcProvider({ urls: [fast.url] });
    await p.viewBlock({ finality: 'final' });
    await p.viewBlock({ finality: 'final' });
    expect((fast.calls.block ?? 0) - before).toBe(2);
  });

  it('keeps blocks looked up by hash', async () => {
    const before = fast.calls.block ?? 0;
    const p = new PacedRpcProvider({ urls: [fast.url] });
    await p.viewBlock({ blockId: 'abc' });
    await p.viewBlock({ blockId: 'abc' });
    expect((fast.calls.block ?? 0) - before).toBe(1);
  });

  it('sends traffic to the fast endpoint and only overflow to a slow one', async () => {
    const fastBefore = fast.calls.query ?? 0;
    const slowBefore = slow.calls.query ?? 0;
    // The slow endpoint is listed first: measured answer times, not list order, decide.
    const p = new PacedRpcProvider({ urls: [slow.url, fast.url], maxPerSecond: 50 });
    for (let i = 0; i < 30; i++) await p.viewAccount({ accountId: 'a.testnet' });
    const toFast = (fast.calls.query ?? 0) - fastBefore;
    const toSlow = (slow.calls.query ?? 0) - slowBefore;
    expect(toFast + toSlow).toBe(30);
    expect(toSlow).toBeLessThanOrEqual(2);
  });
});
