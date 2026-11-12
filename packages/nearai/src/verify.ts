import type { VerificationView } from '@hustle/core';
import { recoverEip191, sha256Hex } from './crypto.ts';
import type { AttestationReport, ChatResult, ResponseSignature } from './types.ts';

/**
 * The report data a TDX quote carries (64 bytes): a quote v4 is a 48-byte header and a 584-byte TD
 * report whose last 64 bytes are the report data, so it sits at bytes 568..632 of the quote. Live
 * model attestations (2026-11-12) carry no `report_data` field of their own, only the quote.
 */
export function reportDataOf(att: { report_data?: string; intel_quote?: string }): string {
  if (att.report_data) return att.report_data.toLowerCase();
  return (att.intel_quote ?? '').toLowerCase().slice(1136, 1264);
}

/**
 * Checks one completion against its signature and an attestation report fetched with a fresh nonce,
 * following docs.near.ai/cloud/verification. What this code does not check is listed in
 * `notChecked`, and the UI shows that list: no verification is claimed that did not run.
 */
export function verifyCompletion(
  mode: 'simulated' | 'live',
  call: Pick<ChatResult, 'model' | 'requestBody' | 'responseBody'>,
  signature: ResponseSignature,
  report: AttestationReport,
  nonce: string,
): VerificationView {
  const checks: VerificationView['checks'] = [];
  // Two kinds, both seen live on 2026-11-12: `provider_tee` (the model's own enclave key signs
  // `model:sha256(req):sha256(resp)`) and `gateway` (NEAR AI's gateway enclave signs
  // `sha256(req):sha256(resp)`, for a model that runs outside a TEE).
  const gateway = signature.signature_kind === 'gateway';
  const hashes = `${sha256Hex(call.requestBody)}:${sha256Hex(call.responseBody)}`;
  const expectedText = gateway ? hashes : `${call.model}:${hashes}`;
  checks.push({
    name: 'Signed text matches this request and response',
    ok: signature.text === expectedText,
    detail: gateway ? 'sha256(request):sha256(response)' : 'model:sha256(request):sha256(response)',
  });

  const recovered = recoverEip191(signature.text, signature.signature);
  const signer = (signature.signing_address ?? '').toLowerCase();
  checks.push({
    name: 'Signature recovers to the stated signer',
    ok: recovered !== null && recovered.toLowerCase() === signer,
    detail: recovered ?? 'signature did not recover',
  });

  const attested = gateway
    ? [report.gateway_attestation].filter((a) => a?.signing_address?.toLowerCase() === signer)
    : report.model_attestations.filter((a) => a.signing_address?.toLowerCase() === signer);
  checks.push({
    name: gateway
      ? 'Signer is the gateway key in our pre-fetched report'
      : 'Signer is the one model key in our pre-fetched report',
    ok: attested.length === 1,
    detail: `${attested.length} matching attestation(s)`,
  });

  const att = attested[0];
  const reportData = att ? reportDataOf(att) : '';
  const addr = signer.replace(/^0x/, '');
  checks.push({
    name: 'Report says it was made for our nonce',
    ok: att !== undefined && att.request_nonce === nonce && reportData.slice(64, 128) === nonce,
    detail: `nonce ${nonce.slice(0, 12)}…`,
  });
  checks.push({
    name: 'Report data names the signing key',
    ok: addr.length > 0 && reportData.slice(0, 40) === addr,
    detail: 'report_data[0:20] = signing address',
  });

  return {
    mode,
    passed: checks.every((c) => c.ok),
    checks,
    notChecked: [
      'Intel TDX quote against Intel collateral (needs a DCAP verifier). Until that runs, the report fields above are what the provider says, not proven by hardware',
      'Event log replay against RTMR3 and the app-compose measurement',
      'NVIDIA GPU evidence',
      ...(gateway
        ? [
            "This reply was signed by NEAR AI's gateway enclave: the model itself ran outside a TEE, so only the gateway's handling is attested",
          ]
        : []),
      ...(mode === 'simulated'
        ? ['Everything above came from the in-repo simulator, not a real enclave']
        : []),
    ],
    signer: signature.signing_address,
  };
}
