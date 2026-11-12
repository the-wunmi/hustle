import { createHash } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';

const utf8 = (s: string) => new TextEncoder().encode(s);
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

export const sha256Hex = (s: string): string => createHash('sha256').update(s).digest('hex');

/** EIP-191 personal_sign hash, which NEAR AI Cloud's ecdsa signatures use. */
function eip191Hash(message: string): Uint8Array {
  const body = utf8(message);
  const prefix = utf8(`\x19Ethereum Signed Message:\n${body.length}`);
  const all = new Uint8Array(prefix.length + body.length);
  all.set(prefix);
  all.set(body, prefix.length);
  return keccak_256(all);
}

/** Ethereum address (0x + last 20 bytes of keccak(uncompressed pubkey without prefix)). */
export function addressFromPublicKey(publicKey: Uint8Array): string {
  const point = secp256k1.Point.fromBytes(publicKey);
  const uncompressed = point.toBytes(false).slice(1);
  return `0x${hex(keccak_256(uncompressed).slice(-20))}`;
}

/** Signs like `personal_sign`: returns 0x r‖s‖v with v = 27 + recovery. */
export function signEip191(privateKey: Uint8Array, message: string): string {
  const sig = secp256k1.sign(eip191Hash(message), privateKey, {
    prehash: false,
    format: 'recovered',
  });
  // noble puts the recovery byte first; Ethereum puts it last, as 27 or 28.
  const out = new Uint8Array(65);
  out.set(sig.slice(1), 0);
  out[64] = (sig[0] ?? 0) + 27;
  return `0x${hex(out)}`;
}

/** The address that signed `message`, or null if the signature is malformed. */
export function recoverEip191(message: string, signature: string): string | null {
  try {
    const raw = Buffer.from(signature.replace(/^0x/, ''), 'hex');
    if (raw.length !== 65) return null;
    const v = raw[64] ?? 0;
    const recovery = v >= 27 ? v - 27 : v;
    if (recovery > 1) return null;
    const noble = new Uint8Array(65);
    noble[0] = recovery;
    noble.set(raw.subarray(0, 64), 1);
    const pub = secp256k1.recoverPublicKey(noble, eip191Hash(message), { prehash: false });
    return addressFromPublicKey(pub);
  } catch {
    return null;
  }
}

export function privateKeyFromSeed(seed: string): Uint8Array {
  // Hash until the bytes are a valid scalar; one round almost always is.
  let candidate = createHash('sha256').update(`hustle-sim-enclave:${seed}`).digest();
  while (!secp256k1.utils.isValidSecretKey(candidate)) {
    candidate = createHash('sha256').update(candidate).digest();
  }
  return new Uint8Array(candidate);
}

export function publicKeyOf(privateKey: Uint8Array): Uint8Array {
  return secp256k1.getPublicKey(privateKey, true);
}
