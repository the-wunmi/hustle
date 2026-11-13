import { describe, expect, it } from 'vitest';
import { SignerQueue } from '../src/signer-queue.ts';

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('one transaction in flight per signer', () => {
  it('runs one signer’s sends one at a time and different signers side by side', async () => {
    const q = new SignerQueue();
    const inFlight = new Map<string, number>();
    let most = 0;
    let both = false;
    const send = (signer: string) =>
      q.run(signer, async () => {
        inFlight.set(signer, (inFlight.get(signer) ?? 0) + 1);
        most = Math.max(most, inFlight.get(signer) ?? 0);
        if ((inFlight.get('clients') ?? 0) > 0 && (inFlight.get('sponsors') ?? 0) > 0) both = true;
        await tick();
        inFlight.set(signer, (inFlight.get(signer) ?? 0) - 1);
        return signer;
      });
    // A resume storm: 45 sends from one account at once, plus another account's.
    const results = await Promise.all([
      ...Array.from({ length: 45 }, () => send('clients')),
      ...Array.from({ length: 5 }, () => send('sponsors')),
    ]);
    expect(results).toHaveLength(50);
    expect(most).toBe(1);
    expect(both).toBe(true);
    expect(q.busy).toBe(0);
  });

  it('a failed send releases the signer for the next one', async () => {
    const q = new SignerQueue();
    await expect(q.run('x', async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await q.run('x', async () => 'next')).toBe('next');
  });
});
