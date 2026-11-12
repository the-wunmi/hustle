/**
 * The slice of NEAR AI Cloud (https://cloud-api.near.ai/v1) Hustle uses. Shapes follow the docs read
 * on 2026-11-11: OpenAI-compatible chat completions, `inference-id` response header, `/v1/billing/costs`
 * in nano-USD, `/v1/signature/{id}` and `/v1/attestation/report`.
 */

export interface ModelInfo {
  id: string;
  /** Micro-USD per 1M input tokens. */
  inputPerM: bigint;
  /** Micro-USD per 1M output tokens. */
  outputPerM: bigint;
  /** `metadata.attestationSupported` in `/v1/model/list`: the model runs in a TEE. */
  attestationSupported: boolean;
  /** Text in and text out (not an image, audio or embedding model). */
  chat: boolean;
  /** Supports structured outputs or JSON mode, which agents' typed actions need. */
  jsonOutput: boolean;
  /** `metadata.isReady` is not false. */
  ready: boolean;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  max_tokens?: number;
  temperature?: number;
  response_format?: { type: 'json_schema'; json_schema: { name: string; schema: unknown } };
  /** Reasoning controls, per model family (docs.near.ai/cloud/reasoning-models, 2026-11-12). */
  chat_template_kwargs?: Record<string, boolean>;
  thinking_token_budget?: number;
  reasoning_effort?: 'low' | 'medium' | 'high';
}

export interface ChatResult {
  /** The completion id (`chatcmpl-…`), used to fetch the signature. */
  chatId: string;
  /** From the `inference-id` header, used for billing. */
  inferenceId: string;
  model: string;
  content: string;
  promptTokens: number;
  completionTokens: number;
  /** Of `completionTokens`, how many the model spent reasoning (billed as output). */
  reasoningTokens: number;
  /** Exact bytes sent and received: the signature covers their sha256. */
  requestBody: string;
  responseBody: string;
}

export interface ResponseSignature {
  /**
   * `<model>:<sha256(request)>:<sha256(response)>` for `provider_tee` signatures (the model's enclave
   * key); `<sha256(request)>:<sha256(response)>` for `gateway` ones (verified live 2026-11-12).
   */
  text: string;
  signature: string;
  signing_address: string;
  signing_algo: 'ecdsa';
  signature_kind?: 'provider_tee' | 'gateway';
}

export interface ModelAttestation {
  signing_address: string;
  signing_algo: 'ecdsa';
  request_nonce: string;
  /**
   * 64 bytes hex: signing address left-aligned in 32 bytes, then the 32-byte nonce. Live model
   * attestations omit it (2026-11-12); it is then read from the TDX quote (`reportDataOf`).
   */
  report_data?: string;
  intel_quote: string;
  nvidia_payload: string | null;
}

export interface AttestationReport {
  gateway_attestation: ModelAttestation;
  model_attestations: ModelAttestation[];
}

export interface ApiKey {
  id: string;
  /** The `sk-…` secret. Kept inside the adapter's caller only, never logged or put in prompts. */
  key: string;
}

export interface NearAiCloud {
  readonly mode: 'mock' | 'live';
  listModels(): Promise<ModelInfo[]>;
  /** One key per agent, so the provider enforces a spend limit per agent too. */
  createAgentKey(name: string, spendLimitMicro: bigint): Promise<ApiKey>;
  setSpendLimit(keyId: string, spendLimitMicro: bigint): Promise<void>;
  chat(apiKey: string, request: ChatRequest): Promise<ChatResult>;
  /** Cost in nano-USD per inference id. */
  costs(inferenceIds: string[]): Promise<Record<string, bigint>>;
  signature(chatId: string): Promise<ResponseSignature>;
  attestation(nonce: string, model: string): Promise<AttestationReport>;
}

export class NearAiError extends Error {
  constructor(
    readonly code: 'spend_limit_exceeded' | 'unauthorized' | 'unavailable' | 'bad_response',
    message: string,
    /** Set when the provider handled (and billed) the call before it failed, so its cost is counted. */
    readonly inferenceId?: string,
  ) {
    super(message);
    this.name = 'NearAiError';
  }
}
