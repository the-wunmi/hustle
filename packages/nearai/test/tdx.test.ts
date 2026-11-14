import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { verifyIntelQuote } from '../src/tdx.ts';
import { intelQuoteCheck, reportDataOf } from '../src/verify.ts';

/** A live NEAR AI Cloud model attestation (Qwen/Qwen3.8-27B), fetched 2026-11-14 with our nonce. */
const live = JSON.parse(
  readFileSync(new URL('./fixtures/model-attestation.json', import.meta.url), 'utf8'),
) as { intel_quote: string; signing_address: string; request_nonce: string };
/** The day it was fetched: Intel's certificates are checked for being in date then. */
const FETCHED = new Date('2026-11-14T19:00:00Z');

describe("Intel's signatures on a NEAR AI TDX quote", () => {
  it('verify on a live quote, and its report data names the signing key and our nonce', () => {
    const result = verifyIntelQuote(live.intel_quote, { now: FETCHED });
    expect(result.checks.filter((c) => !c.ok)).toEqual([]);
    expect(result.ok).toBe(true);
    const data = reportDataOf(live);
    expect(result.reportData).toBe(data);
    expect(data.slice(0, 40)).toBe(live.signing_address.toLowerCase().replace(/^0x/, ''));
    expect(data.slice(64, 128)).toBe(live.request_nonce);
  });

  it('fail when one byte of the signed TD report is changed', () => {
    // Byte 600 sits in the TD report body, which the quote signature covers.
    const at = 600 * 2;
    const flipped = (Number.parseInt(live.intel_quote.slice(at, at + 2), 16) ^ 1)
      .toString(16)
      .padStart(2, '0');
    const tampered = live.intel_quote.slice(0, at) + flipped + live.intel_quote.slice(at + 2);
    const result = verifyIntelQuote(tampered, { now: FETCHED });
    expect(result.ok).toBe(false);
    expect(result.checks.find((c) => c.id === 'quote_signature')?.ok).toBe(false);
  });

  it('fail on a malformed quote, and the product check reports why', () => {
    expect(verifyIntelQuote('00'.repeat(700)).ok).toBe(false);
    const check = intelQuoteCheck('00'.repeat(700), 'x');
    expect(check.ok).toBe(false);
    expect(check.detail).toMatch(/Malformed/);
  });
});
