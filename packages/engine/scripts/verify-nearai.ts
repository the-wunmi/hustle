// Checks the parts of NEAR AI Cloud the game relies on against the live API, with the key in .env,
// and records what came back as test fixtures (no key is ever written or printed). Spends a few
// cents: one short structured call per brain tier. Run: pnpm --filter @hustle/engine verify:nearai
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  fetchPublicModels,
  freshNonce,
  NearAiCloudClient,
  NearAiError,
  verifyCompletion,
} from '@hustle/nearai';
import { brainsFromModels } from '../src/context.ts';

const base = process.env.NEARAI_BASE_URL ?? 'https://cloud-api.near.ai/v1';
const key = process.env.NEARAI_API_KEY;
if (!key) throw new Error('NEARAI_API_KEY is not set in .env');
const day = new Date().toISOString().slice(0, 10);
const out = fileURLToPath(new URL(`../../nearai/test/fixtures/live-${day}/`, import.meta.url));
mkdirSync(out, { recursive: true });
const save = (name: string, value: unknown) =>
  writeFileSync(`${out}${name}.json`, `${JSON.stringify(value, null, 2)}\n`);

const client = new NearAiCloudClient({ baseUrl: base, apiKey: key });
const brains = brainsFromModels(await fetchPublicModels(base));
const schema = {
  type: 'object',
  properties: { pitch: { type: 'string' }, price_usd: { type: 'number' } },
  required: ['pitch', 'price_usd'],
  additionalProperties: false,
};
const summary: Record<string, unknown> = {};
let totalNano = 0n;

for (const [tier, brain] of Object.entries(brains)) {
  const nonce = freshNonce();
  const q = new URLSearchParams({ nonce, signing_algo: 'ecdsa', model: brain.model });
  const att = await fetch(`${base}/attestation/report?${q}`, {
    headers: { Authorization: `Bearer ${key}`, 'x-no-aliasing': 'true' },
  });
  const attBody = await att.text();
  save(`${tier}-attestation`, { status: att.status, body: safeJson(attBody) });
  const report = att.ok ? (JSON.parse(attBody) as Parameters<typeof verifyCompletion>[3]) : null;
  try {
    const result = await client.chat(key, {
      model: brain.model,
      messages: [
        {
          role: 'system',
          content: 'You are a freelance agent. Answer only with the JSON asked for.',
        },
        {
          role: 'user',
          content:
            'A client wants a one-line summary of a customer email for about $0.40. Write a one-sentence pitch and your price.',
        },
      ],
      max_tokens: 600,
      response_format: { type: 'json_schema', json_schema: { name: 'bid', schema } },
    });
    let json: unknown = null;
    try {
      json = JSON.parse(result.content);
    } catch {
      json = null;
    }
    const honoured =
      json !== null &&
      typeof (json as { pitch?: unknown }).pitch === 'string' &&
      typeof (json as { price_usd?: unknown }).price_usd === 'number';
    // Billing can lag the response by a moment.
    let costs: Record<string, bigint> = {};
    for (let i = 0; i < 5 && costs[result.inferenceId] === undefined; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 2000));
      costs = await client.costs([result.inferenceId]);
    }
    const signature = await client.signature(result.chatId);
    save(`${tier}-chat`, {
      // Exact bytes: the signature covers their sha256.
      requestBody: result.requestBody,
      responseBody: result.responseBody,
      inferenceId: result.inferenceId,
    });
    save(`${tier}-signature`, signature);
    const raw = await fetch(`${base}/billing/costs`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestIds: [result.inferenceId] }),
    });
    save(`${tier}-costs`, { status: raw.status, body: await raw.json().catch(() => null) });
    let verification: { passed: boolean; checks: unknown };
    try {
      verification = report
        ? verifyCompletion('live', result, signature, report, nonce)
        : { passed: false, checks: [`no attestation (HTTP ${att.status})`] };
    } catch (err) {
      verification = { passed: false, checks: [`check threw: ${String(err)}`] };
    }
    const nano = costs[result.inferenceId] ?? null;
    if (nano !== null) totalNano += nano;
    summary[tier] = {
      model: brain.model,
      jsonSchemaHonoured: honoured,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      reasoningTokens: result.reasoningTokens,
      costNanoUsd: nano === null ? null : String(nano),
      expectedNanoUsd: String(
        ((BigInt(result.promptTokens) * brain.inputPerM +
          BigInt(result.completionTokens) * brain.outputPerM) *
          1000n) /
          1_000_000n,
      ),
      verification: { passed: verification.passed, checks: verification.checks },
    };
  } catch (err) {
    summary[tier] = {
      model: brain.model,
      error: err instanceof NearAiError ? `${err.code}: ${err.message}` : String(err),
    };
  }
}
summary.totalCostUsd = Number(totalNano) / 1e9;
save('summary', summary);
console.log(JSON.stringify(summary, null, 2));

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text.slice(0, 500);
  }
}
