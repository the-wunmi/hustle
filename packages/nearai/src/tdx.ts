/**
 * Intel TDX quote (version 4, ECDSA P-256) verification that runs in the browser: the PCK
 * certificate chain up to a pinned Intel SGX Root CA key, the quoting enclave's report, the
 * attestation key it vouches for, and the quote signature over the TD report. TCB status and
 * revocation need Intel's PCS collateral; `collateral.ts` checks those.
 *
 * Layout: Intel TDX DCAP Quoting Library API, "TD Quote Format" (A.3, quote v4).
 */

import { p256 } from '@noble/curves/nist.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils.js';

const sha256Hex = (b: Uint8Array): string => bytesToHex(sha256(b));
const fromBase64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/**
 * Intel SGX Root CA public key (uncompressed P-256). From the certificate Intel publishes at
 * https://certificates.trustedservices.intel.com/Intel_SGX_Provisioning_Certification_RootCA.cer
 * (CN=Intel SGX Root CA, valid 2018-05-21 to 2049-12-31, SHA-256 fingerprint
 * 44a0196b2b99f889b8e149e95b807a350e7424964399e885a7cbb8ccfab674d3), fetched 2026-11-14.
 */
export const INTEL_SGX_ROOT_CA_PUBLIC_KEY =
  '040ba9c4c0c0c86193a3fe23d6b02cda10a8bbd4e88e48b4458561a36e705525f567918e2edc88e40d860bd0cc4ee26aacc988e505a953558c453f6b0904ae7394';

const HEADER_LEN = 48;
const TD_REPORT_LEN = 584;
/** The quote signature covers the header and the TD report body. */
const SIGNED_LEN = HEADER_LEN + TD_REPORT_LEN;
const QE_REPORT_LEN = 384;
const QUOTE_VERSION = 4;
const ATT_KEY_ECDSA_P256 = 2;
const TEE_TYPE_TDX = 0x81;
const CERT_QE_REPORT = 6;
const CERT_PCK_CHAIN_PEM = 5;

export interface TdxMeasurements {
  mrtd: string;
  rtmr0: string;
  rtmr1: string;
  rtmr2: string;
  rtmr3: string;
}

export interface TdReport extends TdxMeasurements {
  teeTcbSvn: string;
  mrSeam: string;
  mrSignerSeam: string;
  seamAttributes: string;
  tdAttributes: string;
  xfam: string;
  mrConfigId: string;
  mrOwner: string;
  mrOwnerConfig: string;
  reportData: string;
}

/** The quoting enclave's SGX report: the parts a verifier reads. */
export interface QeReport {
  raw: Uint8Array;
  mrEnclave: string;
  mrSigner: string;
  isvProdId: number;
  isvSvn: number;
  reportData: string;
}

export interface TdxQuote {
  version: number;
  qeVendorId: string;
  body: TdReport;
  /** Header ‖ TD report body: the bytes the attestation key signed. */
  signedBytes: Uint8Array;
  /** r ‖ s, 32 bytes each. */
  signature: Uint8Array;
  /** x ‖ y of the attestation key, 32 bytes each. */
  attestationKey: Uint8Array;
  qeReport: QeReport;
  qeReportSignature: Uint8Array;
  qeAuthData: Uint8Array;
  pckChainPem: string;
}

// Quote integers are little-endian; DataView throws on a read past the end.
const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const u16 = (b: Uint8Array, at: number) => view(b).getUint16(at, true);
const u32 = (b: Uint8Array, at: number) => view(b).getUint32(at, true);
const hexAt = (b: Uint8Array, at: number, len: number) => bytesToHex(b.subarray(at, at + len));

function take(b: Uint8Array, at: number, len: number, what: string): Uint8Array {
  if (at + len > b.length) throw new Error(`Quote truncated in ${what}`);
  return b.subarray(at, at + len);
}

function parseTdReport(b: Uint8Array): TdReport {
  const f = (at: number, len: number) => hexAt(b, at, len);
  return {
    teeTcbSvn: f(0, 16),
    mrSeam: f(16, 48),
    mrSignerSeam: f(64, 48),
    seamAttributes: f(112, 8),
    tdAttributes: f(120, 8),
    xfam: f(128, 8),
    mrtd: f(136, 48),
    mrConfigId: f(184, 48),
    mrOwner: f(232, 48),
    mrOwnerConfig: f(280, 48),
    rtmr0: f(328, 48),
    rtmr1: f(376, 48),
    rtmr2: f(424, 48),
    rtmr3: f(472, 48),
    reportData: f(520, 64),
  };
}

function parseQeReport(raw: Uint8Array): QeReport {
  return {
    raw,
    mrEnclave: hexAt(raw, 64, 32),
    mrSigner: hexAt(raw, 128, 32),
    isvProdId: u16(raw, 256),
    isvSvn: u16(raw, 258),
    reportData: hexAt(raw, 320, 64),
  };
}

/** Parses a TDX quote v4 with certification data type 6 (QE report) wrapping a type 5 PEM chain. */
export function parseTdxQuote(q: Uint8Array): TdxQuote {
  const header = take(q, 0, HEADER_LEN, 'the header');
  const version = u16(header, 0);
  if (version !== QUOTE_VERSION) throw new Error(`Quote version ${version}, expected 4`);
  if (u16(header, 2) !== ATT_KEY_ECDSA_P256) throw new Error('Attestation key is not ECDSA P-256');
  if (u32(header, 4) !== TEE_TYPE_TDX) throw new Error('Quote is not from a TDX TEE');
  const body = take(q, HEADER_LEN, TD_REPORT_LEN, 'the TD report');
  const sigLen = u32(take(q, SIGNED_LEN, 4, 'the signature length'), 0);
  const sig = take(q, SIGNED_LEN + 4, sigLen, 'the signature data');
  // Anything after the signature data is covered by no signature, so only zero padding is allowed
  // (some providers' quotes carry some); the pinned quote hash covers it either way.
  if (q.subarray(SIGNED_LEN + 4 + sigLen).some((x) => x !== 0))
    throw new Error('Unexpected bytes after the signature data');

  const certType = u16(take(sig, 128, 6, 'the certification data'), 0);
  if (certType !== CERT_QE_REPORT)
    throw new Error(`Certification data type ${certType}, expected 6`);
  const cert = take(sig, 134, u32(sig, 130), 'the certification data');
  const authLen = u16(take(cert, QE_REPORT_LEN + 64, 2, 'the QE auth data'), 0);
  const authAt = QE_REPORT_LEN + 66;
  const inner = authAt + authLen;
  const innerType = u16(take(cert, inner, 6, 'the PCK chain'), 0);
  if (innerType !== CERT_PCK_CHAIN_PEM)
    throw new Error(`Inner certification data type ${innerType}, expected 5`);
  const pem = take(cert, inner + 6, u32(cert, inner + 2), 'the PCK chain');
  return {
    version,
    qeVendorId: hexAt(header, 12, 16),
    body: parseTdReport(body),
    signedBytes: q.subarray(0, SIGNED_LEN),
    signature: sig.subarray(0, 64),
    attestationKey: sig.subarray(64, 128),
    qeReport: parseQeReport(cert.subarray(0, QE_REPORT_LEN)),
    qeReportSignature: cert.subarray(QE_REPORT_LEN, QE_REPORT_LEN + 64),
    qeAuthData: cert.subarray(authAt, inner),
    // The chain is NUL-terminated in the quote.
    pckChainPem: new TextDecoder().decode(pem).replace(/\0+$/, ''),
  };
}

// ── DER and X.509, only what a P-256 certificate chain needs ──────────────────────────────────────

export interface Tlv {
  tag: number;
  /** The whole element, header included. */
  raw: Uint8Array;
  value: Uint8Array;
}

export function readTlv(b: Uint8Array, at: number): Tlv {
  const tag = b[at];
  let len = b[at + 1];
  if (tag === undefined || len === undefined || (tag & 0x1f) === 0x1f) throw new Error('Bad DER');
  let head = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    // Indefinite lengths are not DER; certificates here are a few KB.
    if (n < 1 || n > 3) throw new Error('Bad DER length');
    len = 0;
    for (let i = 0; i < n; i++) len = (len << 8) | (b[at + 2 + i] ?? 0);
    head += n;
  }
  if (at + head + len > b.length) throw new Error('DER element runs past its parent');
  return {
    tag,
    raw: b.subarray(at, at + head + len),
    value: b.subarray(at + head, at + head + len),
  };
}

export function children(parent: Uint8Array): Tlv[] {
  const out: Tlv[] = [];
  for (let at = 0; at < parent.length; ) {
    const t = readTlv(parent, at);
    out.push(t);
    at += t.raw.length;
  }
  return out;
}

export const SEQUENCE = 0x30;
const OID = {
  ecdsaWithSha256: '2a8648ce3d040302',
  ecPublicKey: '2a8648ce3d0201',
  prime256v1: '2a8648ce3d030107',
  commonName: '550403',
  basicConstraints: '551d13',
};

export function need(t: Tlv | undefined, tag: number, what: string): Tlv {
  if (!t || t.tag !== tag) throw new Error(`Certificate ${what} missing`);
  return t;
}

export function derTime(t: Tlv): Date {
  const s = new TextDecoder().decode(t.value);
  const m =
    t.tag === 0x17
      ? /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(s)
      : /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(s);
  if (!m) throw new Error('Certificate time not understood');
  const n = m.slice(1).map(Number) as [number, number, number, number, number, number];
  // RFC 5280: a two-digit UTCTime year below 50 is 20YY.
  const year = t.tag === 0x17 ? (n[0] < 50 ? 2000 + n[0] : 1900 + n[0]) : n[0];
  return new Date(Date.UTC(year, n[1] - 1, n[2], n[3], n[4], n[5]));
}

function commonName(name: Tlv): string | null {
  for (const rdn of children(name.value))
    for (const atv of children(rdn.value)) {
      const [oid, value] = children(atv.value);
      if (oid && value && bytesToHex(oid.value) === OID.commonName)
        return new TextDecoder().decode(value.value);
    }
  return null;
}

function isCa(extensions: Tlv | undefined): boolean {
  if (!extensions) return false;
  for (const ext of children(need(children(extensions.value)[0], SEQUENCE, 'extensions').value)) {
    const parts = children(ext.value);
    if (!parts[0] || bytesToHex(parts[0].value) !== OID.basicConstraints) continue;
    const octets = parts[parts.length - 1];
    if (!octets) return false;
    const first = children(need(readTlv(octets.value, 0), SEQUENCE, 'basic constraints').value)[0];
    return first?.tag === 0x01 && first.value[0] === 0xff;
  }
  return false;
}

export interface Certificate {
  /** The signed part, as the issuer signed it. */
  tbs: Uint8Array;
  issuer: Uint8Array;
  subject: Uint8Array;
  subjectCn: string | null;
  notBefore: Date;
  notAfter: Date;
  /** Uncompressed P-256 point. */
  publicKey: Uint8Array;
  /** DER ECDSA signature by the issuer over `tbs`. */
  signature: Uint8Array;
  isCa: boolean;
  /** Serial number, hex, without leading zero bytes. */
  serial: string;
  /** Each extension's OID (DER content, hex) and its OCTET STRING content. */
  extensions: { oid: string; value: Uint8Array }[];
}

/** An INTEGER's content as hex without leading zero bytes, so serials compare as numbers. */
export const integerHex = (t: Tlv) => bytesToHex(t.value).replace(/^(00)+(?=.)/, '');

function extensionList(extensions: Tlv | undefined): Certificate['extensions'] {
  if (!extensions) return [];
  return children(need(children(extensions.value)[0], SEQUENCE, 'extensions').value).map((ext) => {
    const parts = children(ext.value);
    const oid = parts[0];
    const octets = parts[parts.length - 1];
    if (!oid || !octets || octets.tag !== 0x04) throw new Error('Certificate extension malformed');
    return { oid: bytesToHex(oid.value), value: octets.value };
  });
}

/** Reads an X.509 certificate with a P-256 key signed with ECDSA-SHA256; anything else throws. */
export function parseCertificate(der: Uint8Array): Certificate {
  const [tbs, alg, sig] = children(need(readTlv(der, 0), SEQUENCE, 'body').value);
  const tbsT = need(tbs, SEQUENCE, 'TBS');
  const algOid = children(need(alg, SEQUENCE, 'signature algorithm').value)[0];
  if (!algOid || bytesToHex(algOid.value) !== OID.ecdsaWithSha256)
    throw new Error('Certificate is not signed with ECDSA-SHA256');
  const sigBits = need(sig, 0x03, 'signature');
  const f = children(tbsT.value);
  // Version [0] is present in v3 certificates; the fields shift by one without it.
  const o = f[0]?.tag === 0xa0 ? 1 : 0;
  const issuer = need(f[o + 2], SEQUENCE, 'issuer');
  const [from, to] = children(need(f[o + 3], SEQUENCE, 'validity').value);
  const subject = need(f[o + 4], SEQUENCE, 'subject');
  const [spkiAlg, spkiKey] = children(need(f[o + 5], SEQUENCE, 'public key').value);
  const [keyOid, curveOid] = children(need(spkiAlg, SEQUENCE, 'key algorithm').value);
  if (
    !keyOid ||
    !curveOid ||
    bytesToHex(keyOid.value) !== OID.ecPublicKey ||
    bytesToHex(curveOid.value) !== OID.prime256v1
  )
    throw new Error('Certificate key is not P-256');
  const key = need(spkiKey, 0x03, 'public key').value;
  if (!from || !to) throw new Error('Certificate validity missing');
  const extensions = f.find((x) => x.tag === 0xa3);
  return {
    tbs: tbsT.raw,
    issuer: issuer.raw,
    subject: subject.raw,
    subjectCn: commonName(subject),
    notBefore: derTime(from),
    notAfter: derTime(to),
    // BIT STRING: one byte of unused-bit count, then the point.
    publicKey: key.subarray(1),
    signature: sigBits.value.subarray(1),
    isCa: isCa(extensions),
    serial: integerHex(need(f[o], 0x02, 'serial number')),
    extensions: extensionList(extensions),
  };
}

/** The DER certificates in a PEM bundle, in order. */
export function pemCertificates(pem: string): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (const m of pem.matchAll(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g))
    out.push(fromBase64((m[1] ?? '').replace(/\s+/g, '')));
  return out;
}

// Intel signs with high S values too, so the low-S rule (a Bitcoin/Ethereum convention) is off.
export const ecdsaDer = (sig: Uint8Array, msg: Uint8Array, key: Uint8Array) => {
  try {
    return p256.verify(sig, msg, key, { format: 'der', lowS: false });
  } catch {
    return false;
  }
};
/** `sig` is r ‖ s; `key` an uncompressed point. */
export const ecdsaRaw = (sig: Uint8Array, msg: Uint8Array, key: Uint8Array) => {
  try {
    return p256.verify(sig, msg, key, { lowS: false });
  } catch {
    return false;
  }
};

export const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

const PCK_CA_NAMES = ['Intel SGX PCK Platform CA', 'Intel SGX PCK Processor CA'];

/**
 * Checks the PCK chain (leaf → Intel SGX PCK Platform/Processor CA → Intel SGX Root CA): each
 * certificate signed by the next, names linked, CAs marked as CAs, the root's key the pinned one and
 * every certificate in date at `now`. Returns the leaf's key, or why the chain fails.
 */
export function verifyPckChain(
  rootKey: Uint8Array,
  now: Date,
  pem: string,
): { ok: true; leafKey: Uint8Array } | { ok: false; reason: string } {
  const ders = pemCertificates(pem);
  if (ders.length !== 3) return { ok: false, reason: `${ders.length} certificates, expected 3` };
  const [leaf, ca, root] = ders.map(parseCertificate) as [Certificate, Certificate, Certificate];
  const fail = (reason: string) => ({ ok: false as const, reason });
  if (!sameBytes(root.publicKey, rootKey)) return fail('Root certificate is not Intel’s SGX root');
  if (!ecdsaDer(root.signature, root.tbs, rootKey)) return fail('Root signature does not verify');
  if (!sameBytes(ca.issuer, root.subject) || !ecdsaDer(ca.signature, ca.tbs, rootKey))
    return fail('Intermediate CA is not signed by Intel’s SGX root');
  if (!ca.isCa || !PCK_CA_NAMES.includes(ca.subjectCn ?? ''))
    return fail(`Intermediate is not an Intel PCK CA (${ca.subjectCn})`);
  if (!sameBytes(leaf.issuer, ca.subject) || !ecdsaDer(leaf.signature, leaf.tbs, ca.publicKey))
    return fail('PCK certificate is not signed by the intermediate CA');
  if (leaf.subjectCn !== 'Intel SGX PCK Certificate' || leaf.isCa)
    return fail(`Leaf is not a PCK certificate (${leaf.subjectCn})`);
  for (const c of [leaf, ca, root])
    if (now < c.notBefore || now > c.notAfter)
      return fail(
        `${c.subjectCn} is valid ${c.notBefore.toISOString().slice(0, 10)} to ${c.notAfter.toISOString().slice(0, 10)}`,
      );
  return { ok: true, leafKey: leaf.publicKey };
}

// ── The checks ──────────────────────────────────────────────────────────────────────────────────

export type TdxCheckId =
  | 'quote_hash'
  | 'measurements'
  | 'production_td'
  | 'quoting_enclave'
  | 'pck_chain'
  | 'qe_report_signature'
  | 'attestation_key'
  | 'quote_signature';

export interface TdxCheck {
  id: TdxCheckId;
  label: string;
  ok: boolean;
  detail?: string;
}

export const TDX_CHECK_LABELS: Record<TdxCheckId, string> = {
  quote_hash: 'Quote hash matches the pinned one',
  measurements: 'Measurements match the pinned ones',
  production_td: 'The TD runs in production mode, not debug mode (whose memory the host can read)',
  quoting_enclave: 'The quote comes from Intel’s TDX quoting enclave',
  pck_chain: 'Intel’s certificate chain for this machine leads to Intel’s SGX root, all in date',
  qe_report_signature: 'Intel’s quoting enclave report is signed by this machine’s certificate',
  attestation_key: 'That report vouches for the key that signed the quote',
  quote_signature: 'Quote signed by an Intel TDX key (chain to Intel’s root)',
};

/** What a verifier pinned for an enclave key: the quote it expects and its measurements. */
export interface TdxPinned {
  measurements: TdxMeasurements;
  /** sha256 of the raw quote bytes, hex. */
  quoteHash: string;
}

export interface TdxVerification {
  ok: boolean;
  checks: TdxCheck[];
  quote: TdxQuote | null;
}

const MEASUREMENTS = ['mrtd', 'rtmr0', 'rtmr1', 'rtmr2', 'rtmr3'] as const;

/**
 * Intel's TDX quoting enclave (TD_QE), as Intel's PCS publishes its identity
 * (https://api.trustedservices.intel.com/tdx/certification/v4/qe/identity): the key that signed
 * its build, and its product id. Live quotes from TDX hosts carry exactly these.
 */
export const INTEL_TD_QE_MRSIGNER =
  'dc9e2a7c6f948f17474e34a7fc43ed030f7c1563f1babddf6340c82e0e54a8c5';
export const INTEL_TD_QE_ISV_PROD_ID = 2;

/**
 * Verifies raw TDX quote bytes against what was pinned for the key: the bytes hash to the
 * pinned quote hash, their measurements are the pinned ones, and Intel's signatures hold from the
 * pinned root down to the quote. Never throws; a malformed quote fails every check but the hash.
 */
export function verifyTdxQuote(
  pinned: TdxPinned,
  quoteBytes: Uint8Array,
  opts: { now?: Date; rootKeyHex?: string } = {},
): TdxVerification {
  const now = opts.now ?? new Date();
  const rootKey = hexToBytes(opts.rootKeyHex ?? INTEL_SGX_ROOT_CA_PUBLIC_KEY);
  const result = (id: TdxCheckId, ok: boolean, detail?: string): TdxCheck => ({
    id,
    label: TDX_CHECK_LABELS[id],
    ok,
    ...(detail ? { detail } : {}),
  });
  const hash = sha256Hex(quoteBytes);
  const checks: TdxCheck[] = [
    result(
      'quote_hash',
      hash === pinned.quoteHash.toLowerCase(),
      hash === pinned.quoteHash.toLowerCase() ? undefined : `sha256 ${hash}`,
    ),
  ];
  let quote: TdxQuote | null = null;
  try {
    quote = parseTdxQuote(quoteBytes);
  } catch (e) {
    const reason = `Malformed quote: ${e instanceof Error ? e.message : String(e)}`;
    for (const id of Object.keys(TDX_CHECK_LABELS).slice(1) as TdxCheckId[])
      checks.push(result(id, false, reason));
    return { ok: false, checks, quote: null };
  }
  const q = quote;
  const differ = MEASUREMENTS.filter((k) => q.body[k] !== pinned.measurements[k].toLowerCase());
  checks.push(
    result(
      'measurements',
      differ.length === 0,
      differ.length ? `${differ.join(', ')} differ` : undefined,
    ),
  );
  // TDATTRIBUTES is little-endian; bit 0 is DEBUG.
  const debug = (Number.parseInt(q.body.tdAttributes.slice(0, 2), 16) & 1) === 1;
  checks.push(result('production_td', !debug, debug ? 'DEBUG is set' : undefined));
  const qe =
    q.qeReport.mrSigner === INTEL_TD_QE_MRSIGNER &&
    q.qeReport.isvProdId === INTEL_TD_QE_ISV_PROD_ID;
  checks.push(
    result(
      'quoting_enclave',
      qe,
      qe ? undefined : `MRSIGNER ${q.qeReport.mrSigner}, product ${q.qeReport.isvProdId}`,
    ),
  );

  let chain: ReturnType<typeof verifyPckChain>;
  try {
    chain = verifyPckChain(rootKey, now, q.pckChainPem);
  } catch (e) {
    chain = { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
  checks.push(result('pck_chain', chain.ok, chain.ok ? undefined : chain.reason));
  checks.push(
    result(
      'qe_report_signature',
      chain.ok && ecdsaRaw(q.qeReportSignature, q.qeReport.raw, chain.leafKey),
      chain.ok ? undefined : 'No trusted PCK key to check it with',
    ),
  );
  // The QE commits to the attestation key: REPORTDATA = sha256(key ‖ QE auth data) ‖ 32 zero bytes.
  const binding = sha256Hex(concatBytes(q.attestationKey, q.qeAuthData)) + '00'.repeat(32);
  checks.push(result('attestation_key', q.qeReport.reportData === binding));
  checks.push(
    result(
      'quote_signature',
      ecdsaRaw(q.signature, q.signedBytes, concatBytes(new Uint8Array([4]), q.attestationKey)),
    ),
  );
  return { ok: checks.every((c) => c.ok), checks, quote: q };
}

/** The checks that come from Intel alone, with nothing pinned beforehand. */
const INTEL_CHECKS: TdxCheckId[] = [
  'production_td',
  'quoting_enclave',
  'pck_chain',
  'qe_report_signature',
  'attestation_key',
  'quote_signature',
];

/**
 * Verifies a TDX quote with nothing pinned: Intel's certificate chain for the machine up to the
 * pinned Intel SGX root, the quoting enclave and its report, and the quote signature over the TD
 * report (whose report data the caller then checks). TCB status and revocation are not checked: they
 * need Intel's PCS collateral.
 */
export function verifyIntelQuote(
  quoteHex: string,
  opts: { now?: Date } = {},
): { ok: boolean; checks: TdxCheck[]; reportData: string | null } {
  let bytes: Uint8Array;
  try {
    bytes = hexToBytes(quoteHex.replace(/^0x/, ''));
  } catch {
    const detail = 'Malformed quote: not hex';
    return {
      ok: false,
      checks: INTEL_CHECKS.map((id) => ({ id, label: TDX_CHECK_LABELS[id], ok: false, detail })),
      reportData: null,
    };
  }
  let measurements: TdxMeasurements;
  try {
    measurements = parseTdxQuote(bytes).body;
  } catch {
    measurements = { mrtd: '', rtmr0: '', rtmr1: '', rtmr2: '', rtmr3: '' };
  }
  const result = verifyTdxQuote({ quoteHash: sha256Hex(bytes), measurements }, bytes, opts);
  const checks = result.checks.filter((c) => INTEL_CHECKS.includes(c.id));
  return {
    ok: checks.length === INTEL_CHECKS.length && checks.every((c) => c.ok),
    checks,
    reportData: result.quote?.body.reportData ?? null,
  };
}
