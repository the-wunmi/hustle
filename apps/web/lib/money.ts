import { formatUsd, usd } from '@hustle/core/browser';

/** Formats a micro-USD decimal string (as the API sends it). */
export const fmt = (micro: string | bigint | null | undefined, opts?: { sign?: boolean }) =>
  micro === null || micro === undefined ? '–' : formatUsd(BigInt(micro), opts);

/** Dollars typed by a player ("1.5", "$0.25") into a micro string, or null when it isn't a price. */
export function parseDollars(input: string): string | null {
  const clean = input.trim().replace(/^\$/, '');
  if (!/^\d+(\.\d{1,6})?$/.test(clean)) return null;
  return usd(clean).toString();
}

/** A micro string as plain dollars for an input field ("0.4", "1.5"). */
export function toDollarInput(micro: string): string {
  const v = BigInt(micro);
  const whole = v / 1_000_000n;
  const frac = (v % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

export const stars = (avg100: number | null | undefined) =>
  avg100 === null || avg100 === undefined ? null : (avg100 / 100).toFixed(1);

/**
 * A sum as days of the agent's upkeep, so cents read as something at stake: "≈ 4 days of upkeep".
 * Rounded to one decimal under 10 days, whole days above. Null when upkeep is unknown or zero.
 */
export function upkeepDays(
  micro: string | bigint,
  upkeepPerDay: string | undefined,
): string | null {
  if (!upkeepPerDay) return null;
  const per = BigInt(upkeepPerDay);
  if (per === 0n) return null;
  const v = BigInt(micro) < 0n ? -BigInt(micro) : BigInt(micro);
  // Tenths of a day, rounded to nearest: (v × 10 + per/2) ÷ per.
  const tenths = (v * 10n + per / 2n) / per;
  if (tenths === 0n) return 'under a tenth of a day of upkeep';
  const text =
    tenths >= 100n ? `${tenths / 10n}` : `${tenths / 10n}.${tenths % 10n}`.replace(/\.0$/, '');
  return `≈ ${text} ${text === '1' ? 'day' : 'days'} of upkeep`;
}

/**
 * A micro amount as it reads on screen through `fmt` (cents, or a few digits under a cent), back in
 * micro-USD, so a statement can add up the figures the player actually sees.
 */
export function shownMicro(micro: string | bigint): bigint {
  const v = BigInt(micro);
  const abs = v < 0n ? -v : v;
  const text = formatUsd(abs).replace(/[$,]/g, '');
  const parsed = BigInt(usd(text));
  return v < 0n ? -parsed : parsed;
}

/**
 * Dollars with every non-zero digit ("$0.0835", "$4.999", "$1.20"), for statements whose lines
 * must add up, where the usual two-decimal display drops fractions of a cent.
 */
export function exactUsd(micro: string | bigint, opts: { sign?: boolean } = {}): string {
  const v = BigInt(micro);
  const abs = v < 0n ? -v : v;
  const [whole = '0', frac = ''] = toDollarInput(abs.toString()).split('.');
  const body = `$${Number(whole).toLocaleString('en-US')}.${frac.padEnd(2, '0')}`;
  if (v < 0n) return `-${body}`;
  return opts.sign && v > 0n ? `+${body}` : body;
}
