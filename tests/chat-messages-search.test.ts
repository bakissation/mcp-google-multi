import { describe, it, expect } from 'vitest';
import { toolHarness as baseHarness, parseResult, accountSet, type GoogleRequest, type HarnessOptions } from './_tool-harness.js';

const msg = (id: string, text: string, createTime = '2026-11-01T10:00:00Z') => ({
  name: `spaces/AAA/messages/${id}`,
  text,
  createTime,
  sender: { name: 'users/1', displayName: 'Ada Example' },
});

// Chat tools exist only on an account whose scope profile includes the chat bundle.
const toolHarness = (opts: HarnessOptions = {}) =>
  baseHarness({
    accounts: accountSet(
      { test: { email: 'test@harness.example', scopeProfile: 'chat' } },
      { defaultAccount: 'test', scopeProfiles: { chat: { bundles: ['chat'] } } },
    ),
    ...opts,
  });

const isMessages = (req: GoogleRequest) => req.url.includes('/messages');

describe('chat_messages_search', () => {
  it('scans the given space newest first and returns case-insensitive matches', async () => {
    const h = toolHarness({
      respond: (req) => {
        expect(isMessages(req)).toBe(true);
        return { messages: [msg('1', 'Lunch at noon'), msg('2', 'The Budget review is moved'), msg('3', 'budget numbers attached')] };
      },
    });
    const res = await h.call('chat_messages_search', { account: 'test', query: 'BUDGET', space: 'spaces/AAA', since: '2026-10-01T00:00:00Z' });
    expect(res.isError).toBeFalsy();
    const out = parseResult(res);
    expect(out.matches.map((m: { message: string }) => m.message)).toEqual(['spaces/AAA/messages/2', 'spaces/AAA/messages/3']);
    expect(out.matches[0]).toMatchObject({ space: 'spaces/AAA', sender: 'Ada Example' });
    expect(out.truncated).toBe(false);
    expect(out.scanned).toEqual({ spaces: 1, messages: 3, since: '2026-10-01T00:00:00.000Z' });

    const req = h.requests()[0];
    expect(req.url).toContain('spaces/AAA/messages');
    expect(req.params).toMatchObject({
      filter: 'createTime > "2026-10-01T00:00:00.000Z"',
      orderBy: 'createTime DESC',
    });
  });

  it('defaults to the last 30 days', async () => {
    const h = toolHarness({ respond: () => ({ messages: [] }) });
    const out = parseResult(await h.call('chat_messages_search', { account: 'test', query: 'x', space: 'spaces/AAA' }));
    const age = Date.now() - Date.parse(out.scanned.since);
    expect(age).toBeGreaterThan(29.9 * 86_400_000);
    expect(age).toBeLessThan(30.1 * 86_400_000);
    expect(out.matches).toEqual([]);
  });

  it('searches across spaces when none is given and labels each match with its space', async () => {
    const h = toolHarness({
      respond: (req) => {
        if (!isMessages(req)) {
          return { spaces: [{ name: 'spaces/AAA', displayName: 'Team' }, { name: 'spaces/BBB', displayName: 'Ops' }] };
        }
        return req.url.includes('spaces/BBB')
          ? { messages: [{ ...msg('9', 'invoice sent'), name: 'spaces/BBB/messages/9' }] }
          : { messages: [msg('1', 'hello')] };
      },
    });
    const out = parseResult(await h.call('chat_messages_search', { account: 'test', query: 'invoice' }));
    expect(out.matches).toHaveLength(1);
    expect(out.matches[0]).toMatchObject({ space: 'spaces/BBB', spaceName: 'Ops' });
    expect(out.scanned.spaces).toBe(2);
  });

  it('says so when the per-space cap stopped the scan', async () => {
    const h = toolHarness({
      respond: () => ({ messages: Array.from({ length: 2 }, (_, i) => msg(String(i), 'nothing here')), nextPageToken: 'more' }),
    });
    const out = parseResult(await h.call('chat_messages_search', { account: 'test', query: 'zzz', space: 'spaces/AAA', maxMessagesPerSpace: 2 }));
    expect(out.matches).toEqual([]);
    expect(out.truncated).toBe(true);
    expect(out.hint).toContain('maxMessagesPerSpace');
    expect(h.requests()).toHaveLength(1);
  });

  it('follows pages until the cap', async () => {
    let page = 0;
    const h = toolHarness({
      respond: () => {
        page++;
        return page === 1
          ? { messages: [msg('1', 'a')], nextPageToken: 'p2' }
          : { messages: [msg('2', 'needle here')] };
      },
    });
    const out = parseResult(await h.call('chat_messages_search', { account: 'test', query: 'needle', space: 'spaces/AAA' }));
    expect(out.matches).toHaveLength(1);
    expect(out.scanned.messages).toBe(2);
    expect(h.requests()[1].params.pageToken).toBe('p2');
  });

  it('stops at the match limit and says there may be more', async () => {
    const h = toolHarness({ respond: () => ({ messages: [msg('1', 'hit'), msg('2', 'hit'), msg('3', 'hit')] }) });
    const out = parseResult(await h.call('chat_messages_search', { account: 'test', query: 'hit', space: 'spaces/AAA', limit: 2 }));
    expect(out.matches).toHaveLength(2);
    expect(out.truncated).toBe(true);
    expect(out.hint).toContain('limit');
  });

  it('reports a space it cannot read and keeps going', async () => {
    const h = toolHarness({
      respond: (req) => {
        if (!isMessages(req)) return { spaces: [{ name: 'spaces/AAA' }, { name: 'spaces/BBB' }] };
        if (req.url.includes('spaces/AAA')) throw Object.assign(new Error('Not a member'), { code: 403 });
        return { messages: [{ ...msg('9', 'found it'), name: 'spaces/BBB/messages/9' }] };
      },
    });
    const out = parseResult(await h.call('chat_messages_search', { account: 'test', query: 'found' }));
    expect(out.matches).toHaveLength(1);
    expect(out.skipped).toHaveLength(1);
    expect(out.skipped[0].space).toBe('spaces/AAA');
    expect(out.truncated).toBe(true);
  });

  it('points at the chat bundle when the scope is missing', async () => {
    const h = toolHarness({
      respond: () => {
        throw Object.assign(new Error('Insufficient Permission'), { code: 403, errors: [{ reason: 'insufficientPermissions' }] });
      },
    });
    const res = await h.call('chat_messages_search', { account: 'test', query: 'x' });
    expect(res.isError).toBe(true);
    expect(parseResult(res).error).toBe('insufficient_scope');
  });

  it('rejects bad input before calling Google', async () => {
    const cases: Record<string, unknown>[] = [
      { account: 'test', query: '   ' },
      { account: 'test', query: 'x', space: 'AAA' },
      { account: 'test', query: 'x', since: 'yesterday' },
    ];
    for (const c of cases) {
      const h = toolHarness({ respond: () => ({}) });
      const res = await h.call('chat_messages_search', c);
      expect(res.isError, JSON.stringify(c)).toBe(true);
      expect(h.request).not.toHaveBeenCalled();
    }
  });
});
