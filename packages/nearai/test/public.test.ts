import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkReportBinding, parseModelList, perMillion } from '../src/public.ts';
import type { AttestationReport } from '../src/types.ts';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

/** Trimmed copies of real NEAR AI Cloud responses fetched on 2026-11-11, no key needed. */
describe('NEAR AI Cloud public endpoints (recorded live responses)', () => {
  it('reads prices exactly: amount × 10^-scale USD per token', () => {
    expect(perMillion({ amount: 300, scale: 9 })).toBe(300_000n); // $0.30 per 1M tokens
    expect(perMillion({ amount: 16500, scale: 9 })).toBe(16_500_000n);
  });

  it('parses the live model list and tells chat models from image and embedding ones', () => {
    const models = parseModelList(fixture('model-list-2026-11-11.json'));
    const glm = models.find((m) => m.id === 'z-ai/glm-5.3-flash');
    expect(glm).toMatchObject({
      inputPerM: 80_000n,
      outputPerM: 500_000n,
      attestationSupported: true,
      chat: true,
      jsonOutput: true,
    });
    expect(models.find((m) => m.id.startsWith('black-forest-labs'))?.chat).toBe(false);
    expect(models.find((m) => m.id.includes('Embedding'))?.chat).toBe(false);
    expect(models.find((m) => m.id === 'anthropic/claude-haiku-5-5')?.attestationSupported).toBe(
      false,
    );
  });

  it('a real gateway report binds the nonce it was fetched with', () => {
    const report = fixture('gateway-attestation-2026-11-11.json') as AttestationReport;
    const nonce = report.gateway_attestation.request_nonce;
    const v = checkReportBinding('live', { ...report, model_attestations: [] }, nonce);
    expect(v.passed).toBe(true);
    expect(
      checkReportBinding('live', { ...report, model_attestations: [] }, 'f'.repeat(64)).passed,
    ).toBe(false);
  });
});
