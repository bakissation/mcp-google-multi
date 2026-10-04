// B13 / C11: SSRF guard for every server-side fetch (the CIMD client_id doc).
// D4 decision (dependencies-and-bv §2.2): a small AUDITED private-range check,
// no dependency — HTTPS-only, resolve-then-check ALL addresses (anti-rebind),
// no redirects followed, and capped size and time. Blocks 10/8, 172.16/12,
// 192.168/16, 127/8, 169.254/16, 0/8, multicast, ::1, fc00::/7, fe80::/10, and
// v4-mapped forms.

import { lookup } from 'node:dns/promises';
import { isIPv4, isIPv6, BlockList } from 'node:net';

export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfBlockedError';
  }
}

/** True if an IPv4 literal is in a blocked (private/link-local/loopback/etc) range. */
export function isBlockedIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // 10/8 private
  if (a === 127) return true; // 127/8 loopback
  if (a === 169 && b === 254) return true; // 169.254/16 link-local (incl. cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 private
  if (a === 192 && b === 168) return true; // 192.168/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a >= 224) return true; // 224/4 multicast + 240/4 reserved
  return false;
}

// Built-in subnet math (no hand-rolled IPv6 parsing): blocks loopback,
// unspecified, ULA, link-local, multicast, and ALL v4-mapped / v4-compatible /
// NAT64 / 6to4 embeddings (a public host never resolves to those, so blocking
// the whole range closes the embedded-private-target gap without parsing).
const V6_BLOCKED = new BlockList();
V6_BLOCKED.addSubnet('::', 96, 'ipv6'); // ::/96 = ::1, ::, and v4-compatible
V6_BLOCKED.addSubnet('::ffff:0:0', 96, 'ipv6'); // v4-mapped
V6_BLOCKED.addSubnet('64:ff9b::', 96, 'ipv6'); // NAT64
V6_BLOCKED.addSubnet('2002::', 16, 'ipv6'); // 6to4
V6_BLOCKED.addSubnet('fc00::', 7, 'ipv6'); // unique-local
V6_BLOCKED.addSubnet('fe80::', 10, 'ipv6'); // link-local
V6_BLOCKED.addSubnet('ff00::', 8, 'ipv6'); // multicast

/** True if an IPv6 literal is blocked. */
export function isBlockedIPv6(ip: string): boolean {
  const addr = ip.replace(/^\[|\]$/g, '');
  if (!isIPv6(addr)) return true;
  return V6_BLOCKED.check(addr, 'ipv6');
}

export function isBlockedIp(ip: string): boolean {
  if (isIPv4(ip)) return isBlockedIPv4(ip);
  if (isIPv6(ip)) return isBlockedIPv6(ip);
  return true; // unparseable → block
}

export interface SsrfDeps {
  /** Injectable resolver (defaults to dns.lookup all-addresses) for tests. */
  resolveAll?: (host: string) => Promise<string[]>;
}

/** The most lookups started here that may be unsettled at once, abandoned ones included; process-wide, as the libuv threadpool is. */
export const MAX_UNSETTLED_LOOKUPS = 4;
let unsettledLookups = 0;

async function defaultResolveAll(host: string): Promise<string[]> {
  // A bare IP literal needs no DNS; check it directly.
  if (isIPv4(host) || isIPv6(host)) return [host];
  // getaddrinfo keeps its thread until it returns, even once no attempt waits
  // on it, so a new lookup past the cap would only queue behind the hung ones.
  if (unsettledLookups >= MAX_UNSETTLED_LOOKUPS) {
    throw Object.assign(new Error(`DNS lookup for ${host} not started: ${MAX_UNSETTLED_LOOKUPS} earlier lookups have not returned`), { code: 'EAI_AGAIN' });
  }
  unsettledLookups++;
  try {
    const results = await lookup(host, { all: true });
    return results.map((r) => r.address);
  } finally {
    unsettledLookups--;
  }
}

/**
 * Assert a URL is safe to fetch server-side: HTTPS scheme, and every address
 * the host resolves to is public. Throws SsrfBlockedError otherwise, and
 * returns the resolved IPs.
 *
 * NOTE: this checks the host's addresses but does NOT pin them — the caller
 * fetches by hostname, so undici re-resolves at connect time (a check-time vs
 * connect-time TOCTOU / short-TTL rebind window). We deliberately do not pin
 * (CDN IPs rotate). The real anti-SSRF control is the caller-side issuer
 * allowlist (oauth-as validateClient rejects any non-allowlisted host BEFORE
 * fetching, and fetchCimdDocument follows no redirect, so no hop leaves it),
 * so an attacker can't steer the fetch at an arbitrary hostname; this
 * public-range check is defense-in-depth on top of that.
 */
export async function assertPublicHttpsUrl(rawUrl: string, deps: SsrfDeps = {}): Promise<{ url: URL; addresses: string[] }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError(`not a valid URL: ${rawUrl}`);
  }
  if (url.protocol !== 'https:') {
    throw new SsrfBlockedError(`only https is allowed (got ${url.protocol})`);
  }
  const resolveAll = deps.resolveAll ?? defaultResolveAll;
  let addresses: string[];
  try {
    addresses = await resolveAll(url.hostname);
  } catch (e) {
    // A resolver that could not answer this time says nothing about the host,
    // so the fetch may retry it; a name that does not exist stays a block.
    const code = (e as { code?: unknown } | null)?.code;
    if (typeof code === 'string' && TRANSIENT_CODES.has(code)) throw e;
    throw new SsrfBlockedError(`DNS resolution failed for ${url.hostname}: ${(e as Error).message}`);
  }
  if (addresses.length === 0) throw new SsrfBlockedError(`no addresses resolved for ${url.hostname}`);
  for (const ip of addresses) {
    if (isBlockedIp(ip)) {
      throw new SsrfBlockedError(`${url.hostname} resolves to a blocked address (${ip})`);
    }
  }
  return { url, addresses };
}

export interface CimdFetchOptions {
  /** Default 5120: CIMD section 8.7 recommends at most 5 KB. */
  maxBytes?: number;
  /** One attempt's cap, never past what is left of deadlineMs (default 5000). */
  timeoutMs?: number;
  /** One budget for every attempt, DNS lookups and backoff included (default 8000). */
  deadlineMs?: number;
  /** Transient-network-error retries (default 1, so at most 2 attempts). */
  retries?: number;
  /** Base backoff between retries in ms; grows linearly per attempt (default 200). */
  retryBackoffMs?: number;
  fetchImpl?: typeof fetch;
  /** Injectable sleep for tests (default real setTimeout). */
  sleepImpl?: (ms: number) => Promise<void>;
  ssrf?: SsrfDeps;
}

// Connection-level failures that a retry can legitimately recover from. A dead
// IPv6 route (broken egress with Happy-Eyeballs falling through), a reset, or a
// DNS blip are transient; an SSRF block, a bad HTTP status, or malformed JSON
// are deterministic and must NOT be retried.
const TRANSIENT_CODES = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

export function isTransientFetchError(e: unknown): boolean {
  if (e instanceof SsrfBlockedError) return false; // deterministic security/shape reject
  const name = (e as { name?: string } | null)?.name;
  if (name === 'AbortError' || name === 'TimeoutError') return true; // our per-attempt timeout: dead/slow peer
  const cause = (e as { cause?: { code?: string } } | null)?.cause;
  const code = cause?.code ?? (e as { code?: string } | null)?.code;
  if (code && TRANSIENT_CODES.has(code)) return true;
  // undici surfaces connection failures as TypeError('fetch failed') with the
  // real reason in .cause; retry even when the cause carries no useful code.
  if (e instanceof TypeError && /fetch failed/i.test(e.message)) return true;
  return false;
}

// dns.lookup cannot be cancelled, so an attempt stops waiting on it instead.
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    void work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/**
 * SSRF-guarded fetch of a CIMD client-metadata document (JSON): HTTPS and
 * public-IP checked, no redirect followed, size-capped, and every attempt
 * inside one deadline. Returns the parsed JSON object.
 */
export async function fetchCimdDocument(rawUrl: string, opts: CimdFetchOptions = {}): Promise<Record<string, unknown>> {
  const maxBytes = opts.maxBytes ?? 5120;
  const timeoutMs = opts.timeoutMs ?? 5000;
  const deadline = Date.now() + (opts.deadlineMs ?? 8000);
  const retries = opts.retries ?? 1;
  const backoffMs = opts.retryBackoffMs ?? 200;
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleepImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  // Retry transient connection failures IN PLACE. Each attempt re-runs the
  // resolve-then-check so a retry can never skip the anti-rebind guard, and
  // the timer is per-attempt (armed across the lookup and the body read, #10).
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(0, Math.min(timeoutMs, deadline - Date.now())));
    let lookupPending = true;
    try {
      const checked = assertPublicHttpsUrl(rawUrl, opts.ssrf).finally(() => {
        lookupPending = false;
      });
      await untilAborted(checked, controller.signal);
      const res = await doFetch(rawUrl, { redirect: 'manual', signal: controller.signal, headers: { accept: 'application/json' } });
      // CIMD section 5: a redirect is never followed. Only this URL passed the
      // issuer allowlist, and a document behind a redirect could claim its client_id.
      if (res.status >= 300 && res.status < 400) throw new SsrfBlockedError('CIMD redirect refused');
      if (!res.ok) throw new SsrfBlockedError(`CIMD fetch failed: HTTP ${res.status}`);
      const text = await readCapped(res, maxBytes, controller);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new SsrfBlockedError('CIMD document is not valid JSON');
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new SsrfBlockedError('CIMD document is not a JSON object');
      }
      return parsed as Record<string, unknown>;
    } catch (e) {
      // A refused status throws with the body unread, and only an abort hands
      // that connection back; the controller is this attempt's alone.
      controller.abort();
      const wait = backoffMs * (attempt + 1);
      // A retry would start a second lookup beside the one this attempt gave up on.
      if (!lookupPending && attempt < retries && isTransientFetchError(e) && deadline - Date.now() > wait) {
        await sleep(wait);
        continue;
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Read a response body, aborting the moment it exceeds maxBytes (never buffers
 * an oversized body). Falls back to a capped arrayBuffer when there is no
 * readable stream (e.g. a test Response). */
async function readCapped(res: Response, maxBytes: number, controller: AbortController): Promise<string> {
  const reader = res.body?.getReader?.();
  if (!reader) {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > maxBytes) throw new SsrfBlockedError(`CIMD document exceeds ${maxBytes} bytes`);
    return new TextDecoder().decode(buf);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      controller.abort();
      throw new SsrfBlockedError(`CIMD document exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(all);
}
