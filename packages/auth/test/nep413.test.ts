import { ed25519 } from '@noble/curves/ed25519.js';
import { describe, expect, it } from 'vitest';
import {
  base58Decode,
  base58Encode,
  isTestnetAccount,
  type Nep413Payload,
  nep413Digest,
  verifyNep413,
} from '../src/nep413.ts';

const secret = ed25519.utils.randomSecretKey();
const publicKey = `ed25519:${base58Encode(ed25519.getPublicKey(secret))}`;
const payload: Nep413Payload = {
  message: 'Sign in to Hustle',
  nonce: new Uint8Array(32).fill(7),
  recipient: 'hustle.clanker.show',
};
const sign = (p: Nep413Payload, key = secret) =>
  Buffer.from(ed25519.sign(nep413Digest(p), key)).toString('base64');
const signed = { accountId: 'alice.testnet', publicKey, signature: sign(payload) };

describe('NEP-413 sign-in messages', () => {
  it('accepts the key’s signature over exactly this message, nonce and recipient', () => {
    expect(verifyNep413(signed, payload)).toBe(true);
  });

  it('rejects a signature made for another site', () => {
    expect(verifyNep413(signed, { ...payload, recipient: 'evil.example' })).toBe(false);
  });

  it('rejects a signature over another nonce or message', () => {
    expect(verifyNep413(signed, { ...payload, nonce: new Uint8Array(32).fill(8) })).toBe(false);
    expect(verifyNep413(signed, { ...payload, message: 'Send me your agents' })).toBe(false);
  });

  it('rejects another key’s signature, a malformed one, and non-ed25519 keys', () => {
    const other = ed25519.utils.randomSecretKey();
    expect(verifyNep413({ ...signed, signature: sign(payload, other) }, payload)).toBe(false);
    expect(verifyNep413({ ...signed, signature: 'AAAA' }, payload)).toBe(false);
    expect(verifyNep413({ ...signed, publicKey: 'secp256k1:abc' }, payload)).toBe(false);
    expect(verifyNep413({ ...signed, publicKey: 'ed25519:0OIl' }, payload)).toBe(false);
  });

  it('commits to the callback url when there is one', () => {
    const withCallback = { ...payload, callbackUrl: 'https://hustle.clanker.show/' };
    expect(verifyNep413(signed, withCallback)).toBe(false);
    expect(verifyNep413({ ...signed, signature: sign(withCallback) }, withCallback)).toBe(true);
  });

  it('base58 round-trips, including leading zeros', () => {
    const bytes = new Uint8Array([0, 0, 1, 2, 255]);
    expect(base58Decode(base58Encode(bytes))).toEqual(bytes);
  });

  it('only testnet accounts can sign in', () => {
    expect(isTestnetAccount('alice.testnet')).toBe(true);
    expect(isTestnetAccount('my-game.alice.testnet')).toBe(true);
    expect(isTestnetAccount('a'.repeat(64).replace(/a/g, 'b'))).toBe(true);
    expect(isTestnetAccount('alice.near')).toBe(false);
    expect(isTestnetAccount('testnet')).toBe(false);
    expect(isTestnetAccount('0x52908400098527886e0f7030069857d2e4169ee7')).toBe(false);
    expect(isTestnetAccount('Alice.testnet')).toBe(false);
  });
});
