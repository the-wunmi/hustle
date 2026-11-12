import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AttestationReport, ResponseSignature } from '../src/types.ts';
import { reportDataOf, verifyCompletion } from '../src/verify.ts';

/**
 * Real responses recorded from NEAR AI Cloud on 2026-11-12 (`pnpm --filter @hustle/engine
 * verify:nearai`): one structured call per brain tier, its attestation report (fetched with our
 * nonce first), its signature and its billed cost. The verifier must pass every one of them.
 */
const dir = new URL('./fixtures/live-2026-11-12/', import.meta.url);
const load = <T>(name: string): T => JSON.parse(readFileSync(new URL(`${name}.json`, dir), 'utf8'));

describe('live NEAR AI Cloud responses (2026-11-12)', () => {
  for (const tier of ['budget', 'standard', 'premium']) {
    it(`${tier}: the reply verifies against its signature and the report fetched with our nonce`, () => {
      const chat = load<{ requestBody: string; responseBody: string }>(`${tier}-chat`);
      const report = load<{ body: AttestationReport }>(`${tier}-attestation`).body;
      const signature = load<ResponseSignature>(`${tier}-signature`);
      const model = (JSON.parse(chat.requestBody) as { model: string }).model;
      const nonce = report.gateway_attestation.request_nonce;
      const result = verifyCompletion('live', { model, ...chat }, signature, report, nonce);
      expect(result.checks.filter((c) => !c.ok)).toEqual([]);
      expect(result.passed).toBe(true);
      // A different nonce is caught.
      expect(
        verifyCompletion('live', { model, ...chat }, signature, report, 'f'.repeat(64)).passed,
      ).toBe(false);
    });
  }

  it('a tampered response fails the signature check', () => {
    const chat = load<{ requestBody: string; responseBody: string }>('standard-chat');
    const report = load<{ body: AttestationReport }>('standard-attestation').body;
    const signature = load<ResponseSignature>('standard-signature');
    const result = verifyCompletion(
      'live',
      {
        model: 'Qwen/Qwen3.8-27B',
        requestBody: chat.requestBody,
        responseBody: `${chat.responseBody} `,
      },
      signature,
      report,
      report.gateway_attestation.request_nonce,
    );
    expect(result.passed).toBe(false);
  });

  it('report data is read from the TDX quote when the attestation has no field for it', () => {
    const report = load<{ body: AttestationReport }>('budget-attestation').body;
    const att = report.model_attestations[0];
    expect(att?.report_data).toBeUndefined();
    expect(reportDataOf(att ?? {}).slice(0, 40)).toBe(
      (att?.signing_address ?? '').toLowerCase().replace(/^0x/, ''),
    );
  });

  it('billing returns the exact cost of each call, in nano-USD', () => {
    const costs = load<{
      status: number;
      body: { requests: { requestId: string; costNanoUsd: number }[] };
    }>('standard-costs');
    expect(costs.status).toBe(200);
    expect(costs.body.requests[0]?.costNanoUsd).toBeGreaterThan(0);
  });
});
