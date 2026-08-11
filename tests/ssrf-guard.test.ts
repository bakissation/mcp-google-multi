import { describe, it, expect } from 'vitest';
import {
  isBlockedIPv4,
  isBlockedIPv6,
  isBlockedIp,
  assertPublicHttpsUrl,
  fetchCimdDocument,
  SsrfBlockedError,
} from '../src/ssrf-guard.js';

describe('private-range detection (C11)', () => {
  it('blocks IPv4 private / loopback / link-local / metadata / multicast', () => {
    for (const ip of ['0.0.0.0', '10.1.2.3', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1', '224.0.0.1', '240.0.0.1']) {
      expect(isBlockedIPv4(ip)).toBe(true);
    }
  });
  it('allows public IPv4', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.0.1', '172.32.0.1']) {
      expect(isBlockedIPv4(ip)).toBe(false);
    }
  });
  it('blocks IPv6 loopback / ULA / link-local / v4-mapped / NAT64 / 6to4 / multicast (incl. hex forms, #9)', () => {
    for (const ip of ['::1', '::', 'fc00::1', 'fd12::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:169.254.169.254', '::ffff:7f00:1', '64:ff9b::7f00:1', '2002:a9fe::1', 'ff02::1']) {
      expect(isBlockedIPv6(ip)).toBe(true);
    }
  });
  it('allows public IPv6', () => {
    expect(isBlockedIPv6('2606:4700:4700::1111')).toBe(false);
    expect(isBlockedIp('2001:4860:4860::8888')).toBe(false);
  });
  it('blocks unparseable', () => {
    expect(isBlockedIp('not-an-ip')).toBe(true);
  });
});

describe('assertPublicHttpsUrl', () => {
  const pub = async () => ['93.184.216.34'];
  it('accepts an https URL resolving to a public IP', async () => {
    await expect(assertPublicHttpsUrl('https://example.com/x', { resolveAll: pub })).resolves.toMatchObject({ addresses: ['93.184.216.34'] });
  });
  it('rejects non-https', async () => {
    await expect(assertPublicHttpsUrl('http://example.com', { resolveAll: pub })).rejects.toBeInstanceOf(SsrfBlockedError);
  });
  it('rejects a host resolving to a private IP (SSRF / cloud metadata)', async () => {
    await expect(assertPublicHttpsUrl('https://evil.example', { resolveAll: async () => ['169.254.169.254'] })).rejects.toThrow(SsrfBlockedError);
  });
  it('rejects if ANY resolved address is private (anti-rebind)', async () => {
    await expect(assertPublicHttpsUrl('https://mixed.example', { resolveAll: async () => ['93.184.216.34', '10.0.0.5'] })).rejects.toThrow(SsrfBlockedError);
  });
});

describe('fetchCimdDocument', () => {
  const ssrf = { resolveAll: async () => ['93.184.216.34'] };
  const okResp = (body: string, status = 200, headers: Record<string, string> = {}) =>
    new Response(body, { status, headers });

  it('returns the parsed JSON document', async () => {
    const doc = await fetchCimdDocument('https://claude.ai/x', {
      ssrf,
      fetchImpl: async () => okResp(JSON.stringify({ client_id: 'https://claude.ai/x' })),
    });
    expect(doc.client_id).toBe('https://claude.ai/x');
  });

  it('blocks a redirect to a private address', async () => {
    let call = 0;
    await expect(
      fetchCimdDocument('https://claude.ai/x', {
        ssrf: { resolveAll: async (h) => (h === 'claude.ai' ? ['93.184.216.34'] : ['169.254.169.254']) },
        fetchImpl: async () => {
          call++;
          return call === 1 ? okResp('', 302, { location: 'https://metadata.internal/' }) : okResp('{}');
        },
      }),
    ).rejects.toThrow(SsrfBlockedError);
  });

  it('rejects an oversized document', async () => {
    await expect(
      fetchCimdDocument('https://claude.ai/x', { ssrf, maxBytes: 10, fetchImpl: async () => okResp('x'.repeat(100)) }),
    ).rejects.toThrow(/exceeds/);
  });

  it('rejects a non-JSON body', async () => {
    await expect(fetchCimdDocument('https://claude.ai/x', { ssrf, fetchImpl: async () => okResp('<html>') })).rejects.toThrow(/not valid JSON/);
  });
});
