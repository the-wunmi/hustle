import { describe, expect, it } from 'vitest';
import { bpsDown, formatUsd, MicroAmount, nanoToMicroCeil, usd } from '../src/money.ts';

describe('money', () => {
  it('parses dollars into micro-USD without floating point', () => {
    expect(usd('0.42')).toBe(420_000n);
    expect(usd('12')).toBe(12_000_000n);
    expect(usd('0.000001')).toBe(1n);
    expect(() => usd('0.0000001')).toThrow();
    expect(() => usd('-1')).toThrow();
  });

  it('rounds provider nano-USD costs up, so agents never underpay', () => {
    expect(nanoToMicroCeil(1n)).toBe(1n);
    expect(nanoToMicroCeil(1000n)).toBe(1n);
    expect(nanoToMicroCeil(1001n)).toBe(2n);
    expect(nanoToMicroCeil(0n)).toBe(0n);
  });

  it('rounds fees down so the payee keeps the remainder', () => {
    expect(bpsDown(999n, 1000)).toBe(99n);
    expect(bpsDown(1_000_000n, 1000)).toBe(100_000n);
  });

  it('formats tiny costs with enough digits to be honest', () => {
    expect(formatUsd(420_000n)).toBe('$0.42');
    expect(formatUsd(4_200n)).toBe('$0.0042');
    expect(formatUsd(425n)).toBe('$0.00042');
    expect(formatUsd(12_000_000n)).toBe('$12.00');
    expect(formatUsd(1_234_567_000n)).toBe('$1,234.56');
    expect(formatUsd(50_000n, { sign: true })).toBe('+$0.05');
    expect(formatUsd(-50_000n)).toBe('-$0.05');
    expect(formatUsd(0n)).toBe('$0.00');
  });

  it('accepts amounts from JSON strings and rejects negatives and floats', () => {
    expect(MicroAmount.parse('420000')).toBe(420_000n);
    expect(MicroAmount.parse(5)).toBe(5n);
    expect(MicroAmount.safeParse('-1').success).toBe(false);
    expect(MicroAmount.safeParse(0.5).success).toBe(false);
  });
});
