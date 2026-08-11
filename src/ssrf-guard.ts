// B13 / C11: SSRF guard for every server-side fetch (the CIMD client_id doc).
// D4 decision (dependencies-and-bv §2.2): a small AUDITED private-range check,
// no dependency — HTTPS-only, resolve-then-check ALL addresses (anti-rebind),
// and cap redirects / size / time. Blocks 10/8, 172.16/12, 192.168/16, 127/8,
// 169.254/16, 0/8, multicast, ::1, fc00::/7, fe80::/10, and v4-mapped forms.

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

async function defaultResolveAll(host: string): Promise<string[]> {
  // A bare IP literal needs no DNS; check it directly.
  if (isIPv4(host) || isIPv6(host)) return [host];
  const results = await lookup(host, { all: true });
  return results.map((r) => r.address);
}

/**
 * Assert a URL is safe to fetch server-side: HTTPS scheme, and every address
 * the host resolves to is public (resolve-then-check defeats DNS-rebind to a
 * private IP). Throws SsrfBlockedError otherwise. Returns the resolved IPs so
 * the caller can pin them for the actual connection if desired.
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
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  fetchImpl?: typeof fetch;
  ssrf?: SsrfDeps;
}

/**
 * SSRF-guarded fetch of a CIMD client-metadata document (JSON). Every hop
 * (including redirects) is HTTPS + public-IP checked; response is size- and
 * time-capped. Returns the parsed JSON object.
 */
export async function fetchCimdDocument(rawUrl: string, opts: CimdFetchOptions = {}): Promise<Record<string, unknown>> {
  const maxBytes = opts.maxBytes ?? 64 * 1024;
  const timeoutMs = opts.timeoutMs ?? 5000;
  const maxRedirects = opts.maxRedirects ?? 3;
  const doFetch = opts.fetchImpl ?? fetch;

  let current = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertPublicHttpsUrl(current, opts.ssrf);
    // Timer stays armed across the WHOLE hop, including the body read (#10), so
    // a slow-drip body can't hang past timeoutMs.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(current, { redirect: 'manual', signal: controller.signal, headers: { accept: 'application/json' } });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) throw new SsrfBlockedError('redirect without a Location header');
        current = new URL(loc, current).toString();
        continue;
      }
      if (!res.ok) throw new SsrfBlockedError(`CIMD fetch failed: HTTP ${res.status}`);
      const text = await readCapped(res, maxBytes, controller);
      let doc: unknown;
      try {
        doc = JSON.parse(text);
      } catch {
        throw new SsrfBlockedError('CIMD document is not valid JSON');
      }
      if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
        throw new SsrfBlockedError('CIMD document is not a JSON object');
      }
      return doc as Record<string, unknown>;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new SsrfBlockedError(`too many redirects (> ${maxRedirects})`);
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
