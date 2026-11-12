import { describe, expect, it } from 'vitest';
import { OneClickSimulator, USDC_BASE, USDC_NEAR } from '../src/index.ts';

const quoteReq = (dry: boolean) => ({
  dry,
  swapType: 'EXACT_INPUT' as const,
  slippageTolerance: 100,
  originAsset: USDC_BASE,
  depositType: 'ORIGIN_CHAIN' as const,
  destinationAsset: USDC_NEAR,
  amount: '5000000',
  recipient: 'p-1.hustle.sim',
  recipientType: 'DESTINATION_CHAIN' as const,
  refundTo: '0xabc',
  refundType: 'ORIGIN_CHAIN' as const,
  deadline: new Date(Date.now() + 600_000).toISOString(),
});

describe('1Click simulator', () => {
  it('a dry quote has no deposit address', async () => {
    const q = await new OneClickSimulator().quote(quoteReq(true));
    expect(q.depositAddress).toBeNull();
    expect(BigInt(q.amountOut)).toBeLessThan(5_000_000n);
  });

  it('a deposit is pending until reported, then processes to success', async () => {
    const sim = new OneClickSimulator();
    const q = await sim.quote(quoteReq(false));
    const addr = q.depositAddress ?? '';
    expect(await sim.status(addr)).toBe('PENDING_DEPOSIT');
    await sim.submitDeposit(addr, '0xtx');
    const seen = [await sim.status(addr), await sim.status(addr), await sim.status(addr)];
    expect(seen).toEqual(['PROCESSING', 'SUCCESS', 'SUCCESS']);
  });

  it('a failed swap ends refunded, never success', async () => {
    const sim = new OneClickSimulator();
    sim.failNextDeposit();
    const addr = (await sim.quote(quoteReq(false))).depositAddress ?? '';
    await sim.submitDeposit(addr, '0xtx');
    await sim.status(addr);
    expect(await sim.status(addr)).toBe('REFUNDED');
  });
});
