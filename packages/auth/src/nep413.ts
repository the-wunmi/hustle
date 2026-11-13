import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';

/**
 * NEP-413 (sign a message with a NEAR account's key, used by wallets for "sign in with NEAR").
 * The wallet signs sha256(tag || borsh(payload)) with one of the account's ed25519 keys, where the
 * tag is 2^31 + 413 as a little-endian u32 and the payload is
 * { message: string, nonce: [u8; 32], recipient: string, callbackUrl: Option<string> }.
 */
export const NEP413_TAG = 2 ** 31 + 413;

export interface Nep413Payload {
  message: string;
  /** Exactly 32 bytes. */
  nonce: Uint8Array;
  recipient: string;
  callbackUrl?: string | null;
}

/** What a wallet returns from `signMessage`. */
export interface Nep413Signed {
  accountId: string;
  /** `ed25519:<base58>` */
  publicKey: string;
  /** Base64 of the 64-byte signature. */
  signature: string;
}

const utf8 = new TextEncoder();

function u32(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, true);
  return out;
}

function borshString(s: string): Uint8Array[] {
  const bytes = utf8.encode(s);
  return [u32(bytes.length), bytes];
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** The 32 bytes a NEP-413 signature is made over. */
export function nep413Digest(payload: Nep413Payload): Uint8Array {
  if (payload.nonce.length !== 32) throw new Error('NEP-413 nonce must be 32 bytes');
  const callback =
    payload.callbackUrl == null
      ? [new Uint8Array([0])]
      : [new Uint8Array([1]), ...borshString(payload.callbackUrl)];
  return sha256(
    concat([
      u32(NEP413_TAG),
      ...borshString(payload.message),
      payload.nonce,
      ...borshString(payload.recipient),
      ...callback,
    ]),
  );
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58Decode(s: string): Uint8Array {
  let n = 0n;
  for (const ch of s) {
    const v = B58.indexOf(ch);
    if (v < 0) throw new Error('not base58');
    n = n * 58n + BigInt(v);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const ch of s) {
    if (ch !== '1') break;
    bytes.unshift(0);
  }
  return new Uint8Array(bytes);
}

export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

/** The raw 32-byte key of an `ed25519:<base58>` public key, or null for any other kind. */
export function ed25519KeyBytes(publicKey: string): Uint8Array | null {
  if (!publicKey.startsWith('ed25519:')) return null;
  try {
    const bytes = base58Decode(publicKey.slice('ed25519:'.length));
    return bytes.length === 32 ? bytes : null;
  } catch {
    return null;
  }
}

/** Whether `signed.signature` is the key's signature over `payload`. Never throws. */
export function verifyNep413(signed: Nep413Signed, payload: Nep413Payload): boolean {
  const key = ed25519KeyBytes(signed.publicKey);
  if (!key) return false;
  let signature: Uint8Array;
  try {
    signature = Uint8Array.from(Buffer.from(signed.signature, 'base64'));
  } catch {
    return false;
  }
  if (signature.length !== 64) return false;
  try {
    return ed25519.verify(signature, nep413Digest(payload), key);
  } catch {
    return false;
  }
}

/**
 * Accounts that can sign in: named testnet accounts and 64-hex implicit accounts (looked up on
 * testnet). Anything on mainnet (`.near`), and Ethereum-style `0x…` accounts, are refused.
 */
export function isTestnetAccount(accountId: string): boolean {
  if (accountId.length < 2 || accountId.length > 64) return false;
  if (/^[0-9a-f]{64}$/.test(accountId)) return true;
  return /^(([a-z\d]+[-_])*[a-z\d]+\.)+testnet$/.test(accountId);
}
