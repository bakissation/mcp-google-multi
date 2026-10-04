import { describe, it, expect, vi } from 'vitest';
import {
  isBlockedIPv4,
  isBlockedIPv6,
  isBlockedIp,
  assertPublicHttpsUrl,
  CimdHttpError,
  fetchCimdDocument,
  isTransientFetchError,
  MAX_UNSETTLED_LOOKUPS,
  SsrfBlockedError,
} from '../src/ssrf-guard.js';

// Only the default-resolver tests reach dns.lookup; every other test injects resolveAll.
const dnsLookup = vi.hoisted(() => vi.fn());
vi.mock('node:dns/promises', () => ({ lookup: dnsLookup }));

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

  // CIMD section 5. Only the first URL passes the issuer allowlist, so a
  // followed hop could fetch an attacker's document claiming the client_id.
  it('refuses any redirect, even to the same host, without a second fetch', async () => {
    for (const [status, location] of [[301, 'https://claude.ai/y'], [302, 'https://metadata.internal/'], [303, '/y'], [304, undefined], [307, 'https://claude.ai/y'], [308, 'https://claude.ai/y']] as const) {
      let calls = 0;
      const resolved: string[] = [];
      const err = await fetchCimdDocument('https://claude.ai/x', {
        ssrf: { resolveAll: async (h) => (resolved.push(h), ['93.184.216.34']) },
        fetchImpl: async () => {
          calls++;
          return new Response(null, { status, headers: location ? { location } : {} });
        },
      }).catch((e: unknown) => e);
      expect(err, String(status)).toBeInstanceOf(SsrfBlockedError);
      expect((err as Error).message).toBe('CIMD redirect refused');
      expect(calls).toBe(1);
      expect(resolved).toEqual(['claude.ai']);
    }
  });

  it('releases the body of a refused answer', async () => {
    for (const status of [404, 302]) {
      let kept: AbortSignal | undefined;
      const err = await fetchCimdDocument('https://claude.ai/x', {
        ssrf,
        fetchImpl: async (_u, init) => {
          kept = init!.signal!;
          return new Response(new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) }), { status });
        },
      }).catch((e: unknown) => e);
      expect(err, String(status)).toBeInstanceOf(SsrfBlockedError);
      expect(kept?.aborted, String(status)).toBe(true);
    }
  });

  it('rejects an oversized document', async () => {
    await expect(
      fetchCimdDocument('https://claude.ai/x', { ssrf, maxBytes: 10, fetchImpl: async () => okResp('x'.repeat(100)) }),
    ).rejects.toThrow(/exceeds/);
  });

  it('accepts 5120 bytes and refuses 5121 by default (CIMD section 8.7)', async () => {
    const body = (n: number) => `{"a":"${'x'.repeat(n - 8)}"}`;
    expect(body(5120)).toHaveLength(5120);
    await expect(fetchCimdDocument('https://claude.ai/x', { ssrf, fetchImpl: async () => okResp(body(5120)) })).resolves.toHaveProperty('a');
    await expect(fetchCimdDocument('https://claude.ai/x', { ssrf, fetchImpl: async () => okResp(body(5121)) })).rejects.toThrow('CIMD document exceeds 5120 bytes');
  });

  it('rejects a non-JSON body', async () => {
    await expect(fetchCimdDocument('https://claude.ai/x', { ssrf, fetchImpl: async () => okResp('<html>') })).rejects.toThrow(/not valid JSON/);
  });

  const transient = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ETIMEDOUT' } });

  it('retries a transient connection error then succeeds (flaky IPv6 egress)', async () => {
    let calls = 0;
    const doc = await fetchCimdDocument('https://claude.ai/x', {
      ssrf,
      retries: 2,
      retryBackoffMs: 0,
      sleepImpl: async () => {},
      fetchImpl: async () => {
        calls++;
        if (calls < 3) throw transient();
        return okResp(JSON.stringify({ client_id: 'https://claude.ai/x' }));
      },
    });
    expect(calls).toBe(3);
    expect(doc.client_id).toBe('https://claude.ai/x');
  });

  it('exhausts retries and rethrows the transient error', async () => {
    let calls = 0;
    await expect(
      fetchCimdDocument('https://claude.ai/x', {
        ssrf,
        retries: 2,
        retryBackoffMs: 0,
        sleepImpl: async () => {},
        fetchImpl: async () => {
          calls++;
          throw transient();
        },
      }),
    ).rejects.toThrow(/fetch failed/);
    expect(calls).toBe(3); // 1 + 2 retries
  });

  it('retries a transient error once by default', async () => {
    let calls = 0;
    await expect(
      fetchCimdDocument('https://claude.ai/x', {
        ssrf,
        retryBackoffMs: 0,
        sleepImpl: async () => {},
        fetchImpl: async () => {
          calls++;
          throw transient();
        },
      }),
    ).rejects.toThrow(/fetch failed/);
    expect(calls).toBe(2);
  });

  it('rejects a non-2xx status with CimdHttpError carrying the status, after one fetch', async () => {
    for (const status of [503, 429, 404]) {
      let calls = 0;
      const err = await fetchCimdDocument('https://claude.ai/x', {
        ssrf,
        retryBackoffMs: 0,
        sleepImpl: async () => {},
        fetchImpl: async () => (calls++, okResp('busy', status)),
      }).catch((e: unknown) => e);
      expect(err, String(status)).toBeInstanceOf(CimdHttpError);
      expect(err, String(status)).toBeInstanceOf(SsrfBlockedError);
      expect(err).toMatchObject({ status, message: `CIMD fetch failed: HTTP ${status}` });
      expect(calls, String(status)).toBe(1);
    }
  });

  it('does NOT retry a deterministic HTTP error', async () => {
    let calls = 0;
    await expect(
      fetchCimdDocument('https://claude.ai/x', {
        ssrf,
        retryBackoffMs: 0,
        sleepImpl: async () => {},
        fetchImpl: async () => {
          calls++;
          return okResp('nope', 404);
        },
      }),
    ).rejects.toThrow(SsrfBlockedError);
    expect(calls).toBe(1);
  });

  describe('a DNS failure', () => {
    const dnsError = (code: string) => Object.assign(new Error(`getaddrinfo ${code} claude.ai`), { code });
    const counting = (answer: (n: number) => Promise<string[]>) => {
      const seen = { lookups: 0, fetches: 0 };
      const opts = {
        retryBackoffMs: 0,
        sleepImpl: async () => {},
        ssrf: { resolveAll: () => answer(++seen.lookups) },
        fetchImpl: async () => (seen.fetches++, okResp(JSON.stringify({ client_id: 'https://claude.ai/x' }))),
      };
      return { seen, opts };
    };

    it('that is transient is retried, and the retry can succeed', async () => {
      const { seen, opts } = counting((n) => (n === 1 ? Promise.reject(dnsError('EAI_AGAIN')) : Promise.resolve(['93.184.216.34'])));
      await expect(fetchCimdDocument('https://claude.ai/x', opts)).resolves.toEqual({ client_id: 'https://claude.ai/x' });
      expect(seen).toEqual({ lookups: 2, fetches: 1 });
    });

    it('that stays transient fails as transient, not as a block', async () => {
      const { seen, opts } = counting(() => Promise.reject(dnsError('EAI_AGAIN')));
      const err = await fetchCimdDocument('https://claude.ai/x', opts).catch((e: unknown) => e);
      expect(err).not.toBeInstanceOf(SsrfBlockedError);
      expect(isTransientFetchError(err)).toBe(true);
      expect(seen).toEqual({ lookups: 2, fetches: 0 });
    });

    it('for a name that does not exist is a block, not retried', async () => {
      const { seen, opts } = counting(() => Promise.reject(dnsError('ENOTFOUND')));
      await expect(fetchCimdDocument('https://claude.ai/x', opts)).rejects.toThrow(SsrfBlockedError);
      expect(seen).toEqual({ lookups: 1, fetches: 0 });
    });
  });

  it('does NOT retry an SSRF block (private-IP rebind)', async () => {
    let calls = 0;
    await expect(
      fetchCimdDocument('https://claude.ai/x', {
        ssrf: { resolveAll: async () => ['169.254.169.254'] },
        retryBackoffMs: 0,
        sleepImpl: async () => {},
        fetchImpl: async () => {
          calls++;
          return okResp('{}');
        },
      }),
    ).rejects.toThrow(SsrfBlockedError);
    expect(calls).toBe(0); // blocked before any fetch, and not retried
  });

  describe('one deadline for the whole fetch', () => {
    /** A body that sends a first chunk, then stalls until the fetch is aborted, as undici's does. */
    const stalledBody = (signal: AbortSignal) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode('{"client_id":'));
            signal.addEventListener('abort', () => c.error(signal.reason));
          },
        }),
      );
    async function settleAt(p: Promise<unknown>, ms: number): Promise<unknown> {
      let settled: unknown = 'pending';
      p.then(
        () => (settled = 'resolved'),
        (e: unknown) => (settled = e),
      );
      await vi.advanceTimersByTimeAsync(ms - 1);
      expect(settled).toBe('pending');
      await vi.advanceTimersByTimeAsync(1);
      return settled;
    }

    it('two slow lookups, a reset, the backoff and a stalled body all end at 8 s', async () => {
      vi.useFakeTimers();
      try {
        let lookups = 0;
        let fetches = 0;
        const p = fetchCimdDocument('https://claude.ai/x', {
          ssrf: {
            resolveAll: (h) => {
              lookups++;
              return new Promise((r) => setTimeout(() => r(h === 'claude.ai' ? ['93.184.216.34'] : []), 3000));
            },
          },
          fetchImpl: async (_u, init) => {
            fetches++;
            if (fetches === 1) throw transient();
            return stalledBody(init!.signal!);
          },
        });
        const settled = await settleAt(p, 8000);
        expect((settled as Error).name).toBe('AbortError');
        // the reset at 3 s is retried at 3.2 s; that attempt's timer is what is left of the 8 s
        expect({ lookups, fetches }).toEqual({ lookups: 2, fetches: 2 });
      } finally {
        vi.useRealTimers();
      }
    });

    it('a lookup that never answers is abandoned at the deadline, and the per-attempt cap never outlives it', async () => {
      vi.useFakeTimers();
      try {
        let lookups = 0;
        const p = fetchCimdDocument('https://claude.ai/x', {
          deadlineMs: 1500,
          timeoutMs: 60_000,
          ssrf: {
            resolveAll: () => {
              lookups++;
              return new Promise<string[]>(() => {});
            },
          },
          fetchImpl: async () => okResp('{}'),
        });
        const settled = await settleAt(p, 1500);
        expect((settled as Error).name).toBe('AbortError');
        expect(lookups).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('an attempt that timed out connecting is not retried, so a hung connect-time lookup gets no company', async () => {
      vi.useFakeTimers();
      try {
        let fetches = 0;
        const p = fetchCimdDocument('https://claude.ai/x', {
          ssrf,
          fetchImpl: (_u, init) => {
            fetches++;
            return new Promise<Response>((_r, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason)));
          },
        });
        const settled = await settleAt(p, 5000);
        expect((settled as Error).name).toBe('AbortError');
        await vi.advanceTimersByTimeAsync(10_000);
        expect(fetches).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('an attempt that gave up on its lookup is not retried, so one fetch leaves at most one lookup behind', async () => {
      vi.useFakeTimers();
      try {
        let lookups = 0;
        const p = fetchCimdDocument('https://claude.ai/x', {
          ssrf: {
            resolveAll: () => {
              lookups++;
              return new Promise<string[]>(() => {});
            },
          },
          fetchImpl: async () => okResp('{}'),
        });
        const settled = await settleAt(p, 5000);
        expect((settled as Error).name).toBe('AbortError');
        await vi.advanceTimersByTimeAsync(10_000);
        expect(lookups).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('the default resolver', () => {
    const answered = [{ address: '93.184.216.34', family: 4 }];
    const ok = async () => okResp(JSON.stringify({ client_id: 'https://claude.ai/x' }));

    it('starts no lookup while MAX_UNSETTLED_LOOKUPS earlier ones, abandoned ones included, have not returned', async () => {
      const hung: Array<(a: typeof answered) => void> = [];
      dnsLookup.mockImplementation(() => new Promise((r) => hung.push(r)));
      try {
        const abandoned = await Promise.all(
          Array.from({ length: MAX_UNSETTLED_LOOKUPS }, () => fetchCimdDocument('https://claude.ai/x', { deadlineMs: 20, fetchImpl: ok }).catch((e: unknown) => e)),
        );
        for (const e of abandoned) expect((e as Error).name).toBe('AbortError');
        expect(dnsLookup).toHaveBeenCalledTimes(MAX_UNSETTLED_LOOKUPS);

        const sleep = vi.fn(async () => {});
        const err = await fetchCimdDocument('https://claude.ai/x', { deadlineMs: 50, retryBackoffMs: 0, sleepImpl: sleep, fetchImpl: ok }).catch((e: unknown) => e);
        expect(dnsLookup).toHaveBeenCalledTimes(MAX_UNSETTLED_LOOKUPS);
        // the hung lookups it waits on outlast any backoff, so it is not retried
        expect(sleep).not.toHaveBeenCalled();
        expect(err).not.toBeInstanceOf(SsrfBlockedError);
        expect(isTransientFetchError(err)).toBe(true);

        // A lookup that returns, however late, frees its slot.
        for (const r of hung.splice(0)) r(answered);
        await new Promise((r) => setTimeout(r, 0));
        dnsLookup.mockImplementation(async () => answered);
        await expect(fetchCimdDocument('https://claude.ai/x', { fetchImpl: ok })).resolves.toEqual({ client_id: 'https://claude.ai/x' });
        expect(dnsLookup).toHaveBeenCalledTimes(MAX_UNSETTLED_LOOKUPS + 1);
      } finally {
        for (const r of hung.splice(0)) r(answered);
        dnsLookup.mockReset();
      }
    });
  });
});
