import { describe, it, expect } from 'vitest';
import { readBatch } from '../src/tools/gmail.js';

const b64 = (s: string) => Buffer.from(s, 'utf-8').toString('base64url');

// A plain-text message payload parseMessage understands.
function plainMsg(id: string, subject: string, body: string) {
  return {
    id,
    threadId: `t-${id}`,
    payload: {
      headers: [{ name: 'Subject', value: subject }, { name: 'From', value: `${id}@x.com` }],
      mimeType: 'text/plain',
      body: { data: b64(body) },
    },
  };
}

const httpError = (code: number) => Object.assign(new Error(`HTTP ${code}`), { code });

// Fake Gmail: messages.get resolves/rejects per an id→behavior map.
function fakeGmail(byId: Record<string, { data?: any; throw?: any }>) {
  return {
    users: {
      messages: {
        get: async ({ id }: { id: string }) => {
          const b = byId[id];
          if (!b) throw httpError(404);
          if (b.throw) throw b.throw;
          return { data: b.data };
        },
      },
    },
  };
}

describe('readBatch (A9 gmail_read_batch core)', () => {
  it('reads N ids in order, appends a counts summary', async () => {
    const g = fakeGmail({
      a: { data: plainMsg('a', 'SA', 'body a') },
      b: { data: plainMsg('b', 'SB', 'body b') },
      c: { data: plainMsg('c', 'SC', 'body c') },
    });
    const out = await readBatch(g, 'acct', ['a', 'b', 'c'], false, false);
    expect(out).toHaveLength(4); // 3 messages + summary
    expect(out.slice(0, 3).map((e) => e.id)).toEqual(['a', 'b', 'c']);
    expect(out[0].subject).toBe('SA');
    expect(out[0].body).toBe('body a');
    expect(out[3]).toEqual({ counts: { ok: 3, failed: 0 } });
  });

  it('caps each body at 50k (per-message BODY_CAP_CHARS)', async () => {
    const big = 'a'.repeat(60_000);
    const g = fakeGmail({ x: { data: plainMsg('x', 'S', big) } });
    const out = await readBatch(g, 'acct', ['x'], false, false);
    expect(out[0].body.length).toBeLessThanOrEqual(50_000);
    expect(out[0].bodyTruncated).toBe(true);
    expect(out[0].bodyTotalChars).toBe(60_000);
  });

  it('full=true removes the per-message cap', async () => {
    const big = 'a'.repeat(60_000);
    const g = fakeGmail({ x: { data: plainMsg('x', 'S', big) } });
    const out = await readBatch(g, 'acct', ['x'], true, false);
    expect(out[0].body.length).toBe(60_000);
    expect(out[0].bodyTruncated).toBeUndefined();
  });

  it('a single failed id becomes a per-item error; the batch still succeeds', async () => {
    const g = fakeGmail({
      ok1: { data: plainMsg('ok1', 'S1', 'one') },
      bad: { throw: httpError(404) },
      ok2: { data: plainMsg('ok2', 'S2', 'two') },
    });
    const out = await readBatch(g, 'acct', ['ok1', 'bad', 'ok2'], false, false);
    expect(out[0].subject).toBe('S1');
    expect(out[1]).toMatchObject({ id: 'bad', error: { error: 'not_found', retriable: false } });
    expect(out[1].error).not.toHaveProperty('account'); // account stripped from per-item envelope
    expect(out[2].subject).toBe('S2');
    expect(out[3]).toEqual({ counts: { ok: 2, failed: 1 } });
  });

  it('marks 429 per-item as retriable, batch stays ok', async () => {
    const g = fakeGmail({
      a: { data: plainMsg('a', 'S', 'x') },
      b: { throw: httpError(429) },
    });
    const out = await readBatch(g, 'acct', ['a', 'b'], false, false);
    expect(out[1].error).toMatchObject({ error: 'rate_limited', retriable: true });
    expect(out[2]).toEqual({ counts: { ok: 1, failed: 1 } });
  });

  it('aggregate guard caps later bodies and flags truncated in the summary', async () => {
    const body = 'a'.repeat(45_000); // each < 50k per-message cap; 3 sum > 100k aggregate
    const g = fakeGmail({
      a: { data: plainMsg('a', 'S', body) },
      b: { data: plainMsg('b', 'S', body) },
      c: { data: plainMsg('c', 'S', body) },
    });
    const out = await readBatch(g, 'acct', ['a', 'b', 'c'], false, false);
    expect(out[0].bodyTruncated).toBeUndefined(); // first fits
    const summary = out[3];
    expect(summary.truncated).toBe(true);
    // the last entry is capped by the aggregate budget
    expect(out[2].bodyTruncated).toBe(true);
    const totalChars = out.slice(0, 3).reduce((n, e) => n + (e.body?.length ?? 0), 0);
    expect(totalChars).toBeLessThanOrEqual(100_000);
  });

  it('account-wide auth failure rejects the whole call (not per-item)', async () => {
    const g = fakeGmail({ x: { throw: httpError(401) } });
    await expect(readBatch(g, 'acct', ['x'], false, false)).rejects.toBeTruthy();
  });

  it('empty ids is a validation error', async () => {
    const g = fakeGmail({});
    await expect(readBatch(g, 'acct', [], false, false)).rejects.toMatchObject({ slug: 'validation_error' });
  });

  it('>100 ids is a validation error', async () => {
    const g = fakeGmail({});
    const many = Array.from({ length: 101 }, (_, i) => `id${i}`);
    await expect(readBatch(g, 'acct', many, false, false)).rejects.toMatchObject({ slug: 'validation_error' });
  });
});
