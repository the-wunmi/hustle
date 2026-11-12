import { z } from 'zod';

/**
 * Hustle counts money in micro-USD: whole millionths of a dollar, the same 6 decimals as USDC, so a
 * sandbox credit and a real USDC base unit line up one to one. Always `bigint`, never a float.
 */
export type Micro = bigint;

export const MICRO_PER_USD = 1_000_000n;
const NANO_PER_MICRO = 1_000n;

/** Far above anything the game moves, and small enough that sums stay inside a Postgres bigint. */
export const MAX_MICRO = 1_000_000_000_000n;

/** Micro-USD from code (bigint), JSON (decimal string) or a small integer. */
export const MicroAmount = z
  .preprocess(
    (v) => (typeof v === 'bigint' ? v.toString() : v),
    z.union([z.int().nonnegative(), z.string().regex(/^\d{1,13}$/)]),
  )
  .transform((v) => BigInt(v))
  .refine((v) => v >= 0n && v <= MAX_MICRO, {
    message: 'Amount is out of range',
  }) as unknown as z.ZodType<bigint, bigint | number | string>;

/** Dollars as a decimal string ("0.42") into micro-USD, without floating point. */
export function usd(value: string): Micro {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(value.trim());
  if (!match) throw new Error(`Invalid dollar amount: ${value}`);
  const [, whole = '0', frac = ''] = match;
  return BigInt(whole) * MICRO_PER_USD + BigInt(frac.padEnd(6, '0'));
}

/** NEAR AI Cloud reports cost in nano-USD. Round up so an agent never pays less than it cost. */
export function nanoToMicroCeil(nano: bigint): Micro {
  return (nano + NANO_PER_MICRO - 1n) / NANO_PER_MICRO;
}

/** `amount × bps ÷ 10 000`, rounded down. Used for fees, so the payee keeps the remainder. */
export function bpsDown(amount: Micro, bps: number): Micro {
  return (amount * BigInt(bps)) / 10_000n;
}

/** `amount × part ÷ whole`, rounded down. */
export function mulDivDown(amount: bigint, part: bigint, whole: bigint): bigint {
  return (amount * part) / whole;
}

export function sum(values: Iterable<bigint>): bigint {
  let total = 0n;
  for (const v of values) total += v;
  return total;
}

export const minBig = (a: bigint, b: bigint): bigint => (a < b ? a : b);
export const maxBig = (a: bigint, b: bigint): bigint => (a > b ? a : b);

/**
 * "$0.42", "$12.00", or for sub-cent amounts enough digits to be honest about tiny costs
 * ("$0.0042", "$0.00042"). Display only.
 */
export function formatUsd(amount: Micro, opts: { sign?: boolean } = {}): string {
  const neg = amount < 0n;
  const abs = neg ? -amount : amount;
  const whole = abs / MICRO_PER_USD;
  const frac = (abs % MICRO_PER_USD).toString().padStart(6, '0');
  let digits = 2;
  if (whole === 0n && abs > 0n && abs < 10_000n) {
    const firstNonZero = frac.search(/[1-9]/);
    digits = Math.min(6, firstNonZero + 2);
  }
  let shown = frac.slice(0, digits);
  while (shown.length > 2 && shown.endsWith('0')) shown = shown.slice(0, -1);
  const body = `$${whole.toLocaleString('en-US')}.${shown}`;
  if (neg) return `-${body}`;
  return opts.sign && abs > 0n ? `+${body}` : body;
}
