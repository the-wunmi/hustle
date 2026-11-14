import type { VerificationView } from '@hustle/core';
import { z } from 'zod';
import type { AttestationReport, ModelInfo } from './types.ts';
import { intelQuoteCheck, reportDataOf } from './verify.ts';

/**
 * NEAR AI Cloud endpoints that need no API key. Shapes checked against live responses on 2026-11-11:
 * `GET /v1/model/list` → `{ models: [{ modelId, inputCostPerToken: { amount, scale }, outputCostPerToken,
 * metadata: { attestationSupported, isReady, architecture, supportedFeatures } }], total }`, and
 * `GET /v1/attestation/report?nonce=&signing_algo=ecdsa` → `{ gateway_attestation: { signing_address,
 * request_nonce, report_data, intel_quote, event_log, … } }`.
 */

/** Longest a public call may take before the game falls back to its snapshot. */
const PUBLIC_TIMEOUT_MS = 6_000;

const Price = z.object({ amount: z.number().int().nonnegative(), scale: z.number().int() });
const ModelList = z.object({
  models: z.array(
    z.object({
      modelId: z.string(),
      inputCostPerToken: Price,
      outputCostPerToken: Price,
      metadata: z
        .object({
          attestationSupported: z.boolean().optional(),
          isReady: z.boolean().optional(),
          architecture: z
            .object({
              inputModalities: z.array(z.string()).optional(),
              outputModalities: z.array(z.string()).optional(),
            })
            .optional(),
          supportedFeatures: z.array(z.string()).optional(),
        })
        .partial()
        .optional(),
    }),
  ),
});

/** `amount × 10^-scale` USD per token as micro-USD per 1M tokens, in integers. */
export function perMillion(price: { amount: number; scale: number }): bigint {
  const amount = BigInt(price.amount);
  const exp = 12 - price.scale;
  return exp >= 0 ? amount * 10n ** BigInt(exp) : amount / 10n ** BigInt(-exp);
}

export function parseModelList(json: unknown): ModelInfo[] {
  const parsed = ModelList.safeParse(json);
  if (!parsed.success) throw new Error('Unexpected NEAR AI Cloud model list shape');
  return parsed.data.models.map((m) => {
    const md = m.metadata ?? {};
    const features = md.supportedFeatures ?? [];
    return {
      id: m.modelId,
      inputPerM: perMillion(m.inputCostPerToken),
      outputPerM: perMillion(m.outputCostPerToken),
      attestationSupported: md.attestationSupported === true,
      // Agents need text in, text out, and JSON they can be held to.
      chat:
        (md.architecture?.inputModalities ?? ['text']).includes('text') &&
        (md.architecture?.outputModalities ?? []).includes('text'),
      jsonOutput: features.includes('structured_outputs') || features.includes('json_mode'),
      ready: md.isReady !== false,
    };
  });
}

/** The live model list, which NEAR AI Cloud serves without a key. */
export async function fetchPublicModels(baseUrl: string): Promise<ModelInfo[]> {
  const res = await fetch(`${baseUrl}/model/list?limit=200`, {
    signal: AbortSignal.timeout(PUBLIC_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`model list returned ${res.status}`);
  return parseModelList(await res.json());
}

/** A gateway attestation bound to our nonce, which NEAR AI Cloud serves without a key. */
export async function fetchPublicAttestation(
  baseUrl: string,
  nonce: string,
): Promise<AttestationReport> {
  const q = new URLSearchParams({ nonce, signing_algo: 'ecdsa' });
  const res = await fetch(`${baseUrl}/attestation/report?${q}`, {
    signal: AbortSignal.timeout(PUBLIC_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`attestation returned ${res.status}`);
  const body = (await res.json()) as Partial<AttestationReport>;
  if (!body.gateway_attestation) throw new Error('attestation has no gateway report');
  return {
    gateway_attestation: body.gateway_attestation,
    model_attestations: body.model_attestations ?? [],
  };
}

/**
 * The checks we can run on a report alone: it answers our fresh nonce and its report data names the
 * key it says it signs with. These are the report's own claims; they become hardware-backed only once
 * the Intel TDX quote is verified, which this code does not do and says so.
 */
export function checkReportBinding(
  mode: 'simulated' | 'live',
  report: AttestationReport,
  nonce: string,
): VerificationView {
  const att = report.gateway_attestation;
  const data = reportDataOf(att);
  const addr = att.signing_address.toLowerCase().replace(/^0x/, '');
  const checks = [
    {
      name: 'Report answers our fresh nonce',
      ok: att.request_nonce === nonce,
      detail: `nonce ${nonce.slice(0, 12)}…`,
    },
    {
      name: 'Report data ends with our nonce',
      ok: data.slice(64, 128) === nonce,
      detail: 'report_data[32:64]',
    },
    {
      name: 'Report data names the signing key',
      ok: data.slice(0, 40) === addr,
      detail: att.signing_address,
    },
    mode === 'live'
      ? intelQuoteCheck(att.intel_quote, data)
      : {
          name: 'Report carries an Intel TDX quote',
          ok: att.intel_quote.length > 100,
          detail: `${att.intel_quote.length} hex chars`,
        },
  ];
  return {
    mode,
    passed: checks.every((c) => c.ok),
    checks,
    notChecked: [
      mode === 'live'
        ? "TCB status and revocation against Intel's PCS collateral"
        : 'The TDX quote itself against Intel collateral (needs a DCAP verifier). Until then the fields above are what the gateway says, not proven by hardware',
      'Event log replay against RTMR3 and the app-compose measurement',
      'Model (GPU) attestations',
    ],
    signer: att.signing_address,
  };
}
