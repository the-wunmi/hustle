import { createHmac, randomBytes } from 'node:crypto';
import {
  addressFromPublicKey,
  privateKeyFromSeed,
  publicKeyOf,
  sha256Hex,
  signEip191,
} from './crypto.ts';
import {
  type ApiKey,
  type AttestationReport,
  type ChatRequest,
  type ChatResult,
  type ModelInfo,
  type NearAiCloud,
  NearAiError,
  type ResponseSignature,
  type ServicePrice,
} from './types.ts';

/** NEAR AI Cloud's live model list on 2026-11-11 (prices in micro-USD per 1M tokens). */
export const MODEL_SNAPSHOT: readonly ModelInfo[] = [
  {
    id: 'Qwen/Qwen3.8-27B',
    inputPerM: 40_000n,
    outputPerM: 1_350_000n,
    attestationSupported: true,
    chat: true,
    jsonOutput: true,
    ready: true,
  },
  {
    id: 'z-ai/glm-5.3-flash',
    inputPerM: 80_000n,
    outputPerM: 500_000n,
    attestationSupported: true,
    chat: true,
    jsonOutput: true,
    ready: true,
  },
  {
    id: 'Qwen/Qwen3.6-35B-A3B-FP8',
    inputPerM: 170_000n,
    outputPerM: 1_100_000n,
    attestationSupported: true,
    chat: true,
    jsonOutput: true,
    ready: true,
  },
  {
    id: 'deepseek-ai/DeepSeek-V4.1-Flash-1017',
    inputPerM: 300_000n,
    outputPerM: 1_200_000n,
    attestationSupported: true,
    chat: true,
    jsonOutput: true,
    ready: true,
  },
  {
    id: 'moonshotai/kimi-k2.6',
    inputPerM: 810_000n,
    outputPerM: 3_850_000n,
    attestationSupported: true,
    chat: true,
    jsonOutput: true,
    ready: true,
  },
  {
    id: 'moonshotai/kimi-k3',
    inputPerM: 3_300_000n,
    outputPerM: 16_500_000n,
    attestationSupported: true,
    chat: true,
    jsonOutput: true,
    ready: true,
  },
  {
    id: 'anthropic/claude-haiku-5-5',
    inputPerM: 100_000n,
    outputPerM: 500_000n,
    attestationSupported: false,
    chat: true,
    jsonOutput: true,
    ready: true,
  },
  {
    id: 'openai/gpt-6-luna',
    inputPerM: 100_000n,
    outputPerM: 500_000n,
    attestationSupported: false,
    chat: true,
    jsonOutput: true,
    ready: true,
  },
];

/** What the scripted model says. The engine supplies it; the simulator only plays the provider. */
export type Responder = (request: ChatRequest) => {
  content: string;
  promptTokens: number;
  completionTokens: number;
};

/** Bounds the simulator's memory of costs and signatures; older entries are dropped first. */
const MAX_REMEMBERED = 20_000;

function remember<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.set(key, value);
  if (map.size > MAX_REMEMBERED) {
    const first = map.keys().next();
    if (!first.done) map.delete(first.value);
  }
}

/**
 * Plays NEAR AI Cloud in mock mode: same shapes, per-key spend limits, nano-USD costs, and real
 * ECDSA signatures from a simulated enclave key, so the verification code runs for real against it.
 * Nothing here is a real TEE, and the UI labels it simulated.
 */
export class NearAiCloudSimulator implements NearAiCloud {
  readonly mode = 'mock' as const;
  readonly signingAddress: string;
  private readonly privateKey: Uint8Array;
  private readonly costsById = new Map<string, bigint>();
  private readonly signatures = new Map<string, ResponseSignature>();
  private readonly spentByKey = new Map<string, bigint>();
  private readonly limits = new Map<string, bigint>();
  private failures: NearAiError['code'][] = [];
  private seq = 0;

  constructor(
    private readonly secret: string,
    private readonly responder: Responder,
  ) {
    this.privateKey = privateKeyFromSeed(secret);
    this.signingAddress = addressFromPublicKey(publicKeyOf(this.privateKey));
  }

  /** Test control: the next calls fail with these codes, in order. */
  failNext(...codes: NearAiError['code'][]): void {
    this.failures.push(...codes);
  }

  async listModels(): Promise<ModelInfo[]> {
    return [...MODEL_SNAPSHOT];
  }

  private keyMac(keyId: string): string {
    return createHmac('sha256', this.secret).update(`key:${keyId}`).digest('hex').slice(0, 32);
  }

  async createAgentKey(name: string, spendLimitMicro: bigint): Promise<ApiKey> {
    const id = `key_${name.replace(/[^a-z0-9]/gi, '').slice(0, 24)}_${randomBytes(4).toString('hex')}`;
    this.limits.set(id, spendLimitMicro);
    return { id, key: `sk-sim-${id}.${this.keyMac(id)}` };
  }

  async setSpendLimit(keyId: string, spendLimitMicro: bigint): Promise<void> {
    this.limits.set(keyId, spendLimitMicro);
  }

  private keyIdOf(apiKey: string): string {
    const match = /^sk-sim-(key_[A-Za-z0-9_]+)\.([0-9a-f]{32})$/.exec(apiKey);
    if (!match?.[1] || match[2] !== this.keyMac(match[1])) {
      throw new NearAiError('unauthorized', 'Invalid API key');
    }
    return match[1];
  }

  async chat(apiKey: string, request: ChatRequest): Promise<ChatResult> {
    const keyId = this.keyIdOf(apiKey);
    const failure = this.failures.shift();
    if (failure) throw new NearAiError(failure, `Simulated ${failure}`);
    const model = MODEL_SNAPSHOT.find((m) => m.id === request.model);
    if (!model) throw new NearAiError('bad_response', `Unknown model ${request.model}`);

    const spent = this.spentByKey.get(keyId) ?? 0n;
    const limit = this.limits.get(keyId);
    if (limit !== undefined && spent >= limit) {
      throw new NearAiError('spend_limit_exceeded', 'API key spend limit reached');
    }

    const answer = this.responder(request);
    const n = ++this.seq;
    const chatId = `chatcmpl-sim-${Date.now().toString(36)}${n.toString(36)}`;
    const inferenceId = `inf-sim-${randomBytes(8).toString('hex')}`;
    const requestBody = JSON.stringify(request);
    const responseBody = JSON.stringify({
      id: chatId,
      object: 'chat.completion',
      model: request.model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: answer.content },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: answer.promptTokens,
        completion_tokens: answer.completionTokens,
        total_tokens: answer.promptTokens + answer.completionTokens,
      },
    });
    const nano =
      (BigInt(answer.promptTokens) * model.inputPerM +
        BigInt(answer.completionTokens) * model.outputPerM +
        999n) /
      1000n;
    remember(this.costsById, inferenceId, nano);
    this.spentByKey.set(keyId, spent + (nano + 999n) / 1000n);
    const text = `${request.model}:${sha256Hex(requestBody)}:${sha256Hex(responseBody)}`;
    remember(this.signatures, chatId, {
      text,
      signature: signEip191(this.privateKey, text),
      signing_address: this.signingAddress,
      signing_algo: 'ecdsa',
    });
    return {
      chatId,
      inferenceId,
      model: request.model,
      content: answer.content,
      promptTokens: answer.promptTokens,
      completionTokens: answer.completionTokens,
      reasoningTokens: 0,
      requestBody,
      responseBody,
    };
  }

  async costs(inferenceIds: string[]): Promise<Record<string, bigint>> {
    const out: Record<string, bigint> = {};
    for (const id of inferenceIds) {
      const cost = this.costsById.get(id);
      if (cost !== undefined) out[id] = cost;
    }
    return out;
  }

  async signature(chatId: string): Promise<ResponseSignature> {
    const sig = this.signatures.get(chatId);
    if (!sig) throw new NearAiError('bad_response', 'Signature not found');
    return sig;
  }

  /** The simulator runs no provider tools, so it lists no services. */
  async services(): Promise<ServicePrice[]> {
    return [];
  }

  async attestation(nonce: string, model: string): Promise<AttestationReport> {
    if (!/^[0-9a-f]{64}$/.test(nonce))
      throw new NearAiError('bad_response', 'Nonce must be 64 hex');
    const addr = this.signingAddress.replace(/^0x/, '').padEnd(64, '0');
    const att = {
      signing_address: this.signingAddress,
      signing_algo: 'ecdsa' as const,
      request_nonce: nonce,
      report_data: `${addr}${nonce}`,
      intel_quote: `SIMULATED-TDX-QUOTE:${model}`,
      nvidia_payload: null,
    };
    return { gateway_attestation: att, model_attestations: [att] };
  }
}
