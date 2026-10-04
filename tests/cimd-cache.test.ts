import { describe, it, expect } from 'vitest';
import {
  CimdClientCache,
  CIMD_CACHE_MAX,
  CIMD_MAX_IN_FLIGHT,
  CIMD_MAX_STALE_MS,
  CIMD_TTL_MS,
  type CimdDocument,
  type CimdResolution,
} from '../src/cimd-cache.js';
import { CimdHttpError, SsrfBlockedError } from '../src/ssrf-guard.js';

const docFor = (id: string): CimdDocument => ({ client_id: id, redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] });
const validFor = (id: string) => (doc: CimdDocument) => doc.client_id === id && Array.isArray(doc.redirect_uris) && doc.redirect_uris.length > 0;
const transient = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });

interface Held {
  id: string;
  resolve: (doc: CimdDocument) => void;
  reject: (e: unknown) => void;
}

/** A cache over a fake fetch: `answer` decides each fetch, `hold` parks it until the test settles it. */
function harness() {
  let clock = 1_700_000_000_000;
  const fetches: string[] = [];
  const held: Held[] = [];
  const logs: string[] = [];
  const h = {
    fetches,
    held,
    logs,
    answer: (id: string): Promise<CimdDocument> => Promise.resolve(docFor(id)),
    advance: (ms: number) => void (clock += ms),
    hold: () => {
      h.answer = (id) => new Promise((resolve, reject) => held.push({ id, resolve, reject }));
    },
    cache: undefined as unknown as CimdClientCache,
    resolve: (id: string): Promise<CimdResolution> => h.cache.resolve(id, validFor(id)),
    /** Park CIMD_MAX_IN_FLIGHT fetches of other ids so the cap is full. */
    fillCap: () => {
      h.hold();
      const parked = Array.from({ length: CIMD_MAX_IN_FLIGHT }, (_, i) => h.resolve(`https://claude.ai/busy-${i}`));
      expect(held).toHaveLength(CIMD_MAX_IN_FLIGHT);
      return parked;
    },
  };
  h.cache = new CimdClientCache({
    fetch: (id) => {
      fetches.push(id);
      return h.answer(id);
    },
    now: () => clock,
    log: (l) => logs.push(l),
  });
  return h;
}

const A = 'https://claude.ai/client-a';

describe('CimdClientCache', () => {
  it('K1 serves a fresh entry with no fetch', async () => {
    const h = harness();
    expect(await h.resolve(A)).toEqual({ doc: docFor(A), fresh: true });
    h.advance(CIMD_TTL_MS - 1);
    expect(await h.resolve(A)).toEqual({ doc: docFor(A), fresh: false });
    expect(h.fetches).toEqual([A]);
  });

  it('K2 refetches once the TTL has passed and a permit is free', async () => {
    const h = harness();
    await h.resolve(A);
    h.advance(CIMD_TTL_MS);
    expect(await h.resolve(A)).toEqual({ doc: docFor(A), fresh: true });
    expect(h.fetches).toEqual([A, A]);
  });

  it('K3 concurrent requests for one client_id share one fetch and hold no permit of their own', async () => {
    const h = harness();
    h.hold();
    const five = Array.from({ length: 5 }, () => h.resolve(A));
    const others = Array.from({ length: CIMD_MAX_IN_FLIGHT - 1 }, (_, i) => h.resolve(`https://claude.ai/other-${i}`));
    expect(h.fetches).toHaveLength(CIMD_MAX_IN_FLIGHT);
    expect(await h.resolve('https://claude.ai/one-too-many')).toEqual({ busy: true });
    for (const p of h.held) p.resolve(docFor(p.id));
    const answers = await Promise.all(five);
    expect(answers[0]).toEqual({ doc: docFor(A), fresh: true });
    for (const a of answers.slice(1)) expect(a).toEqual({ doc: docFor(A), fresh: false });
    await Promise.all(others);
    expect(h.fetches.filter((f) => f === A)).toHaveLength(1);
  });

  it('K4 caps the fetches running at once; a settled one frees its permit', async () => {
    const h = harness();
    h.hold();
    const ids = Array.from({ length: CIMD_MAX_IN_FLIGHT + 1 }, (_, i) => `https://claude.ai/id-${i}`);
    const running = ids.slice(0, -1).map((id) => h.resolve(id));
    expect(await h.resolve(ids[CIMD_MAX_IN_FLIGHT])).toEqual({ busy: true });
    expect(h.fetches).toEqual(ids.slice(0, -1));
    h.held[0].resolve(docFor(ids[0]));
    await running[0];
    const next = h.resolve('https://claude.ai/next');
    expect(h.fetches).toHaveLength(CIMD_MAX_IN_FLIGHT + 1);
    for (const p of h.held.slice(1)) p.resolve(docFor(p.id));
    await Promise.all([...running, next]);
  });

  it('K5 while the cap is full, an expired but validated entry is served with no fetch', async () => {
    const h = harness();
    await h.resolve(A);
    h.advance(CIMD_TTL_MS + 1);
    h.fillCap();
    expect(await h.resolve(A)).toEqual({ doc: docFor(A), fresh: false });
    expect(h.fetches.filter((f) => f === A)).toHaveLength(1);
  });

  it('K6 while the cap is full, an entry past the stale limit is not served, and is dropped', async () => {
    const h = harness();
    await h.resolve(A);
    h.advance(CIMD_MAX_STALE_MS);
    h.fillCap();
    expect(h.cache.size).toBe(1);
    expect(await h.resolve(A)).toEqual({ busy: true });
    expect(h.cache.size).toBe(0);
  });

  it('K7 a refetch failure that says the document went bad drops the entry; one that says nothing about it keeps it and serves it stale', async () => {
    const stale: CimdResolution = { doc: docFor(A), fresh: false };
    const blocked: CimdResolution = { error: 'E_CIMD_SSRF_BLOCKED' };
    const invalid: CimdResolution = { error: 'E_CIMD_INVALID' };
    const rejects = (e: unknown) => () => Promise.reject(e);
    const cases: Array<[string, () => Promise<CimdDocument>, CimdResolution]> = [
      ['404', rejects(new CimdHttpError(404)), blocked],
      ['410', rejects(new CimdHttpError(410)), blocked],
      ['403', rejects(new CimdHttpError(403)), blocked],
      ['redirect', rejects(new SsrfBlockedError('CIMD redirect refused')), blocked],
      ['oversized', rejects(new SsrfBlockedError('CIMD document exceeds 5120 bytes')), blocked],
      ['ENOTFOUND', rejects(new SsrfBlockedError('DNS resolution failed for claude.ai: getaddrinfo ENOTFOUND claude.ai')), blocked],
      ['mismatch', () => Promise.resolve({ client_id: 'https://claude.ai/someone-else', redirect_uris: ['https://x.example/cb'] }), invalid],
      ['no redirect_uris', () => Promise.resolve({ client_id: A, redirect_uris: [] }), invalid],
      ['503', rejects(new CimdHttpError(503)), stale],
      ['500', rejects(new CimdHttpError(500)), stale],
      ['429', rejects(new CimdHttpError(429)), stale],
      ['408', rejects(new CimdHttpError(408)), stale],
      ['reset', rejects(transient()), stale],
      ['EAI_AGAIN', rejects(Object.assign(new Error('getaddrinfo EAI_AGAIN claude.ai'), { code: 'EAI_AGAIN' })), stale],
      ['timeout', rejects(new DOMException('This operation was aborted', 'AbortError')), stale],
    ];
    for (const [label, failure, first] of cases) {
      const h = harness();
      await h.resolve(A);
      h.advance(CIMD_TTL_MS);
      h.answer = failure;
      expect(await h.resolve(A), label).toEqual(first);
      h.fillCap();
      expect(await h.resolve(A), label).toEqual(first === stale ? stale : { busy: true });
    }
  });

  it('K8 an invalid document is never stored', async () => {
    const h = harness();
    h.answer = () => Promise.resolve({ client_id: 'https://claude.ai/someone-else', redirect_uris: ['https://x.example/cb'] });
    expect(await h.resolve(A)).toEqual({ error: 'E_CIMD_INVALID' });
    expect(h.cache.size).toBe(0);
    expect(await h.resolve(A)).toEqual({ error: 'E_CIMD_INVALID' });
    expect(h.fetches).toEqual([A, A]);
  });

  it('K9 keeps at most CIMD_CACHE_MAX entries, evicting the oldest first', async () => {
    const h = harness();
    const ids = Array.from({ length: CIMD_CACHE_MAX + 1 }, (_, i) => `https://claude.ai/c-${i}`);
    for (const id of ids) await h.resolve(id);
    expect(h.cache.size).toBe(CIMD_CACHE_MAX);
    expect(await h.resolve(ids[CIMD_CACHE_MAX])).toEqual({ doc: docFor(ids[CIMD_CACHE_MAX]), fresh: false });
    expect(await h.resolve(ids[0])).toEqual({ doc: docFor(ids[0]), fresh: true });
    expect(h.cache.size).toBe(CIMD_CACHE_MAX);
    expect(h.fetches).toHaveLength(CIMD_CACHE_MAX + 2);
  });

  it('K10 a failing shared fetch logs once, answers every waiter, and leaves no unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      const h = harness();
      h.hold();
      const waiters = Array.from({ length: 5 }, () => h.resolve(A));
      expect(h.held).toHaveLength(1);
      h.held[0].reject(new Error('connect ECONNREFUSED\nCIMD busy: forged'));
      for (const a of await Promise.all(waiters)) expect(a).toEqual({ error: 'E_CIMD_INVALID' });
      await new Promise((r) => setTimeout(r, 20));
      expect(h.logs).toEqual([`CIMD fetch failed for ${A}: connect ECONNREFUSED\\u000aCIMD busy: forged`]);
      expect(unhandled).toEqual([]);
      h.answer = (id) => Promise.resolve(docFor(id));
      expect(await h.resolve(A)).toEqual({ doc: docFor(A), fresh: true });
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('K11 the busy line is logged at most once a minute and counts what it held back', async () => {
    const h = harness();
    h.fillCap();
    for (let i = 0; i < 100; i++) expect(await h.resolve(`https://claude.ai/flood-${i}`)).toEqual({ busy: true });
    expect(h.logs).toEqual(['CIMD busy: in-flight cap reached']);
    h.advance(60_000);
    await h.resolve('https://claude.ai/flood-next');
    expect(h.logs).toEqual(['CIMD busy: in-flight cap reached', 'CIMD busy: in-flight cap reached (n=99 suppressed)']);
    h.advance(59_999);
    await h.resolve('https://claude.ai/flood-late');
    expect(h.logs).toHaveLength(2);
    h.advance(1);
    await h.resolve('https://claude.ai/flood-last');
    expect(h.logs[2]).toBe('CIMD busy: in-flight cap reached (n=1 suppressed)');
  });

  it('K12 every request waiting on a refetch gets the stored document when the issuer cannot answer, and the error when it says the document is gone', async () => {
    const waitOnRefetch = async (failure: unknown, stored: boolean) => {
      const h = harness();
      if (stored) {
        await h.resolve(A);
        h.advance(CIMD_TTL_MS);
      }
      h.hold();
      const five = Array.from({ length: 5 }, () => h.resolve(A));
      expect(h.held).toHaveLength(1);
      h.held[0].reject(failure);
      return { answers: await Promise.all(five), size: h.cache.size };
    };
    for (const failure of [new CimdHttpError(503), new CimdHttpError(429), transient()]) {
      expect(await waitOnRefetch(failure, true)).toEqual({ answers: Array(5).fill({ doc: docFor(A), fresh: false }), size: 1 });
    }
    for (const failure of [new CimdHttpError(404), new CimdHttpError(410)]) {
      expect(await waitOnRefetch(failure, true)).toEqual({ answers: Array(5).fill({ error: 'E_CIMD_SSRF_BLOCKED' }), size: 0 });
    }
    expect(await waitOnRefetch(transient(), false)).toEqual({ answers: Array(5).fill({ error: 'E_CIMD_INVALID' }), size: 0 });
    expect(await waitOnRefetch(new CimdHttpError(503), false)).toEqual({ answers: Array(5).fill({ error: 'E_CIMD_SSRF_BLOCKED' }), size: 0 });
  });

  it('K13 a stale answer keeps the document\'s age: the next request asks the issuer again, and one past the stale limit is not served', async () => {
    const h = harness();
    await h.resolve(A);
    h.advance(CIMD_TTL_MS);
    h.answer = () => Promise.reject(new CimdHttpError(503));
    expect(await h.resolve(A)).toEqual({ doc: docFor(A), fresh: false });
    h.answer = (id) => Promise.resolve(docFor(id));
    expect(await h.resolve(A)).toEqual({ doc: docFor(A), fresh: true });
    expect(h.fetches).toEqual([A, A, A]);

    h.advance(CIMD_MAX_STALE_MS - 1);
    h.hold();
    const late = h.resolve(A);
    h.advance(1);
    h.held[0].reject(new CimdHttpError(503));
    expect(await late).toEqual({ error: 'E_CIMD_SSRF_BLOCKED' });
  });
});
