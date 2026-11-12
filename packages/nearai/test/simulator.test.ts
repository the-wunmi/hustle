import { describe, expect, it } from 'vitest';
import {
  freshNonce,
  NearAiCloudSimulator,
  NearAiError,
  signEip191,
  verifyCompletion,
} from '../src/index.ts';

const responder = () => ({ content: '{"ok":true}', promptTokens: 1000, completionTokens: 500 });
const req = { model: 'z-ai/glm-5.3-flash', messages: [{ role: 'user' as const, content: 'hi' }] };

describe('NEAR AI Cloud simulator', () => {
  it('meters each call in nano-USD from the model price list', async () => {
    const sim = new NearAiCloudSimulator('s', responder);
    const key = await sim.createAgentKey('nova', 1_000_000n);
    const res = await sim.chat(key.key, req);
    const costs = await sim.costs([res.inferenceId]);
    // 1000 tokens at $0.08/M plus 500 at $0.50/M is $0.00033: 330 000 nano-USD.
    expect(costs[res.inferenceId]).toBe(330_000n);
  });

  it('a completion verifies against its signature and a fresh attestation', async () => {
    const sim = new NearAiCloudSimulator('s', responder);
    const key = await sim.createAgentKey('nova', 1_000_000n);
    const res = await sim.chat(key.key, req);
    const nonce = freshNonce();
    const v = verifyCompletion(
      'simulated',
      res,
      await sim.signature(res.chatId),
      await sim.attestation(nonce, req.model),
      nonce,
    );
    expect(v.passed).toBe(true);
    expect(v.notChecked.some((n) => n.includes('simulator'))).toBe(true);
  });

  it('a forged response fails verification', async () => {
    const sim = new NearAiCloudSimulator('s', responder);
    const key = await sim.createAgentKey('nova', 1_000_000n);
    const res = await sim.chat(key.key, req);
    const nonce = freshNonce();
    const forged = { ...res, responseBody: res.responseBody.replace('ok', 'no') };
    const v = verifyCompletion(
      'simulated',
      forged,
      await sim.signature(res.chatId),
      await sim.attestation(nonce, req.model),
      nonce,
    );
    expect(v.passed).toBe(false);
  });

  it('a signature from a key that was not attested fails verification', async () => {
    const sim = new NearAiCloudSimulator('s', responder);
    const key = await sim.createAgentKey('nova', 1_000_000n);
    const res = await sim.chat(key.key, req);
    const sig = await sim.signature(res.chatId);
    const otherKey = new Uint8Array(32).fill(7);
    const forgedSig = { ...sig, signature: signEip191(otherKey, sig.text) };
    const nonce = freshNonce();
    const v = verifyCompletion(
      'simulated',
      res,
      forgedSig,
      await sim.attestation(nonce, req.model),
      nonce,
    );
    expect(v.passed).toBe(false);
  });

  it('a stale attestation bound to another nonce fails verification', async () => {
    const sim = new NearAiCloudSimulator('s', responder);
    const key = await sim.createAgentKey('nova', 1_000_000n);
    const res = await sim.chat(key.key, req);
    const v = verifyCompletion(
      'simulated',
      res,
      await sim.signature(res.chatId),
      await sim.attestation(freshNonce(), req.model),
      freshNonce(),
    );
    expect(v.passed).toBe(false);
  });

  it('refuses calls once an agent key reaches its spend limit', async () => {
    const sim = new NearAiCloudSimulator('s', responder);
    const key = await sim.createAgentKey('nova', 1n);
    await sim.chat(key.key, req);
    await expect(sim.chat(key.key, req)).rejects.toMatchObject({ code: 'spend_limit_exceeded' });
  });

  it('rejects a key it did not issue', async () => {
    const sim = new NearAiCloudSimulator('s', responder);
    await expect(sim.chat('sk-sim-key_x.0000', req)).rejects.toBeInstanceOf(NearAiError);
  });
});
