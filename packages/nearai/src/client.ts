import { randomBytes } from 'node:crypto';
import { parseModelList } from './public.ts';
import {
  type ApiKey,
  type AttestationReport,
  type ChatRequest,
  type ChatResult,
  type ModelInfo,
  type NearAiCloud,
  NearAiError,
  type ResponseSignature,
} from './types.ts';

export interface NearAiCloudConfig {
  baseUrl: string;
  /** The org key (`sk-…`) used for chat when per-agent keys can't be created. */
  apiKey: string;
  /** Session token and workspace for creating per-agent keys; optional. */
  sessionToken?: string;
  workspaceId?: string;
}

/** Longest a provider call may take before the call is treated as unavailable. */
const TIMEOUT_MS = 60_000;

/**
 * The real NEAR AI Cloud. The model list and attestation shapes were checked against live responses on
 * 2026-11-11, and chat, signatures and `/v1/billing/costs` on 2026-11-12. Per-agent key creation and
 * spend limits need a session token and are still UNVERIFIED (see CLAUDE.md).
 */
export class NearAiCloudClient implements NearAiCloud {
  readonly mode = 'live' as const;

  constructor(private readonly cfg: NearAiCloudConfig) {}

  private async request(
    path: string,
    init: RequestInit & { token?: string } = {},
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${init.token ?? this.cfg.apiKey}`);
    if (init.body) headers.set('Content-Type', 'application/json');
    let res: Response;
    try {
      res = await fetch(`${this.cfg.baseUrl}${path}`, {
        ...init,
        headers,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new NearAiError('unavailable', `NEAR AI Cloud unreachable: ${String(err)}`);
    }
    if (res.status === 401 || res.status === 403)
      throw new NearAiError('unauthorized', 'Rejected key');
    if (res.status === 402 || res.status === 429) {
      throw new NearAiError('spend_limit_exceeded', `NEAR AI Cloud returned ${res.status}`);
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      throw new NearAiError('unavailable', `NEAR AI Cloud returned ${res.status}: ${detail}`);
    }
    return res;
  }

  async listModels(): Promise<ModelInfo[]> {
    // Shape verified against the live endpoint on 2026-11-11 (see public.ts).
    const res = await this.request('/model/list?limit=200');
    return parseModelList(await res.json());
  }

  async createAgentKey(name: string, spendLimitMicro: bigint): Promise<ApiKey> {
    if (!this.cfg.sessionToken || !this.cfg.workspaceId) {
      // Without a session token, every agent shares the org key; the wallet contract still caps spend.
      return { id: 'org-key', key: this.cfg.apiKey };
    }
    const res = await this.request(`/workspaces/${this.cfg.workspaceId}/api-keys`, {
      method: 'POST',
      token: this.cfg.sessionToken,
      body: JSON.stringify({ name }),
    });
    const body = (await res.json()) as { id?: string; key?: string; api_key?: string };
    const key = body.key ?? body.api_key;
    if (!body.id || !key) throw new NearAiError('bad_response', 'Key creation returned no key');
    await this.setSpendLimit(body.id, spendLimitMicro);
    return { id: body.id, key };
  }

  async setSpendLimit(keyId: string, spendLimitMicro: bigint): Promise<void> {
    if (!this.cfg.sessionToken || !this.cfg.workspaceId || keyId === 'org-key') return;
    await this.request(`/workspaces/${this.cfg.workspaceId}/api-keys/${keyId}/spend-limit`, {
      method: 'PATCH',
      token: this.cfg.sessionToken,
      // Dollars as a decimal string, built without floats.
      body: JSON.stringify({
        spend_limit: `${spendLimitMicro / 1_000_000n}.${(spendLimitMicro % 1_000_000n).toString().padStart(6, '0')}`,
      }),
    });
  }

  async chat(apiKey: string, request: ChatRequest): Promise<ChatResult> {
    const requestBody = JSON.stringify({ ...reasoningOff(request.model), ...request });
    const res = await this.request('/chat/completions', {
      method: 'POST',
      token: apiKey,
      body: requestBody,
    });
    const responseBody = await res.text();
    const body = JSON.parse(responseBody) as {
      id: string;
      model: string;
      choices: { message: { content: string | null }; finish_reason?: string }[];
      usage: {
        prompt_tokens: number;
        completion_tokens: number;
        completion_tokens_details?: { reasoning_tokens?: number } | null;
        reasoning_tokens?: number;
      };
    };
    const inferenceId = res.headers.get('inference-id') ?? body.id;
    const content = body.choices[0]?.message.content;
    // A reasoning model that ran out of tokens while thinking answers with `content: null` (verified
    // 2026-11-12). That is a failed call, never a deliverable; the provider still billed it.
    if (typeof content !== 'string' || content.trim() === '')
      throw new NearAiError(
        'bad_response',
        `No completion content (finish_reason ${body.choices[0]?.finish_reason ?? 'unknown'})`,
        inferenceId,
      );
    return {
      chatId: body.id,
      inferenceId,
      model: request.model,
      content,
      promptTokens: body.usage.prompt_tokens,
      completionTokens: body.usage.completion_tokens,
      reasoningTokens:
        body.usage.completion_tokens_details?.reasoning_tokens ?? body.usage.reasoning_tokens ?? 0,
      requestBody,
      responseBody,
    };
  }

  async costs(inferenceIds: string[]): Promise<Record<string, bigint>> {
    const res = await this.request('/billing/costs', {
      method: 'POST',
      body: JSON.stringify({ requestIds: inferenceIds }),
    });
    // Verified live 2026-11-12: `{ requestIds }` in, `{ requests: [{ requestId, costNanoUsd }] }` out.
    const body = (await res.json()) as {
      requests?: { requestId: string; costNanoUsd: number | string }[];
    };
    const out: Record<string, bigint> = {};
    for (const c of body.requests ?? []) out[c.requestId] = BigInt(c.costNanoUsd);
    return out;
  }

  async signature(chatId: string): Promise<ResponseSignature> {
    const res = await this.request(`/signature/${encodeURIComponent(chatId)}?signing_algo=ecdsa`);
    return (await res.json()) as ResponseSignature;
  }

  async attestation(nonce: string, model: string): Promise<AttestationReport> {
    const q = new URLSearchParams({ nonce, signing_algo: 'ecdsa', model, provider: 'near' });
    const res = await this.request(`/attestation/report?${q}`, {
      headers: { 'x-no-aliasing': 'true' },
    });
    return (await res.json()) as AttestationReport;
  }
}

export const freshNonce = (): string => randomBytes(32).toString('hex');

/**
 * Turns reasoning off (or to its minimum) for the model families that reason by default, so an
 * agent's output tokens go to the answer: per docs.near.ai/cloud/reasoning-models (read 2026-11-12).
 * Kimi takes `thinking`, Qwen and GLM-5.1 take `enable_thinking`, GLM-5.3 Flash can't turn it off
 * (it then writes its reasoning into `content`) so its reasoning is capped instead, and GPT-OSS
 * always reasons, at the lowest effort here.
 */
export function reasoningOff(model: string): Partial<ChatRequest> {
  const id = model.toLowerCase();
  if (id.includes('kimi')) return { chat_template_kwargs: { thinking: false } };
  if (id.includes('glm-5.3'))
    return { thinking_token_budget: REASONING_BUDGET, reasoning_effort: 'low' };
  if (id.includes('gpt-oss')) return { reasoning_effort: 'low' };
  if (id.includes('qwen') || id.includes('glm'))
    return { chat_template_kwargs: { enable_thinking: false } };
  return {};
}

/** Most reasoning tokens a model that can't stop reasoning may spend before it answers. */
export const REASONING_BUDGET = 256;
