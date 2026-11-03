import { describe, it, expect } from 'vitest';
import { candidatesFromHeaders, resolveContacts } from '../src/tools/contacts.js';
import { toolHarness, parseResult, type GoogleRequest } from './_tool-harness.js';

describe('candidatesFromHeaders', () => {
  it('collects display-name matches from From, To and Cc, grouped by address', () => {
    const out = candidatesFromHeaders(
      [
        { from: 'Dana Whitfield <dana@acme.example>', to: 'me@example.com' },
        { to: 'Sam <sam@example.org>, "Dana Whitfield" <dana@acme.example>' },
        { cc: 'Someone Else <else@example.net>' },
      ],
      'Dana',
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ displayName: 'Dana Whitfield', source: 'gmail', seen: 2 });
    expect(out[0].emails[0].value).toBe('dana@acme.example');
  });

  it('counts an address once per message even when it appears in several headers', () => {
    const out = candidatesFromHeaders(
      [{ from: 'Dana <dana@acme.example>', to: 'Dana <dana@acme.example>', cc: 'Dana <dana@acme.example>' }],
      'dana',
    );
    expect(out[0].seen).toBe(1);
  });

  it('needs every query token to prefix a name token, folding accents and case', () => {
    const rows = [{ from: 'Zoë Martin <zoe@example.com>, Zoe Smith <zs@example.com>' }];
    expect(candidatesFromHeaders(rows, 'zoe mar').map((c) => c.emails[0].value)).toEqual(['zoe@example.com']);
    expect(candidatesFromHeaders(rows, 'Zoe')).toHaveLength(2);
    expect(candidatesFromHeaders(rows, 'Martin Zoe').map((c) => c.emails[0].value)).toEqual(['zoe@example.com']);
  });

  it('drops own addresses and entries without a display name', () => {
    const out = candidatesFromHeaders(
      [{ from: 'Dana Me <me@example.com>', to: 'dana@acme.example, Dana B <dana.b@acme.example>' }],
      'Dana',
      new Set(['me@example.com']),
    );
    expect(out.map((c) => c.emails[0].value)).toEqual(['dana.b@acme.example']);
  });

  it('keeps the most common spelling of the name for an address', () => {
    const out = candidatesFromHeaders(
      [
        { from: 'D. Whitfield <dana@acme.example>' },
        { from: 'Dana Whitfield <dana@acme.example>' },
        { from: 'Dana Whitfield <dana@acme.example>' },
      ],
      'Whitfield',
    );
    expect(out[0].displayName).toBe('Dana Whitfield');
  });

  it('feeds resolveContacts: one match resolves, two stay ambiguous ordered by volume', () => {
    const one = resolveContacts(candidatesFromHeaders([{ from: 'Dana W <dana@acme.example>' }], 'Dana'), 'Dana', 5);
    expect(one.resolved).toMatchObject({ email: 'dana@acme.example', source: 'gmail' });

    const rows = [
      { from: 'Dana A <a@acme.example>' },
      { from: 'Dana B <b@acme.example>' },
      { from: 'Dana B <b@acme.example>' },
    ];
    const two = resolveContacts(candidatesFromHeaders(rows, 'Dana'), 'Dana', 5);
    expect(two.ambiguous).toBe(true);
    expect(two.candidates?.map((c) => c.email)).toEqual(['b@acme.example', 'a@acme.example']);
  });
});

// A People API with no hits, and a mailbox described by header rows.
function mailbox(opts: { rows?: Array<Record<string, string>>; gmailFails?: boolean; contacts?: unknown[] } = {}) {
  const rows = opts.rows ?? [];
  return (req: GoogleRequest): unknown => {
    if (req.url.includes('people:searchContacts')) {
      return { results: (opts.contacts ?? []).map((person) => ({ person })) };
    }
    if (req.url.includes('otherContacts:search')) return {};
    if (req.url.includes('/gmail/')) {
      if (opts.gmailFails) {
        throw Object.assign(new Error('Request had insufficient authentication scopes.'), {
          code: 403,
          response: { status: 403, data: { error: { code: 403, message: 'Insufficient Permission' } } },
        });
      }
      if (req.url.endsWith('/profile')) return { emailAddress: 'me@example.com' };
      if (req.url.includes('/messages/')) {
        const i = Number(decodeURIComponent(req.url.split('/messages/')[1].split('?')[0]).replace('m', ''));
        const row = rows[i] ?? {};
        return {
          id: `m${i}`,
          payload: { headers: Object.entries(row).map(([name, value]) => ({ name, value })) },
        };
      }
      return { messages: rows.map((_, i) => ({ id: `m${i}` })) };
    }
    return {};
  };
}

const gmailCalls = (h: ReturnType<typeof toolHarness>) => h.requests().filter((r) => r.url.includes('/gmail/'));

describe('contacts_resolve mail header fallback', () => {
  it('resolves a name that is only in mail headers and says so', async () => {
    const h = toolHarness({
      respond: mailbox({ rows: [{ From: 'Dana Whitfield <dana@acme.example>', To: 'Me <me@example.com>' }] }),
    });
    const out = parseResult(await h.call('contacts_resolve', { account: 'test', name: 'Dana' }));
    expect(out.resolved).toMatchObject({ name: 'Dana Whitfield', email: 'dana@acme.example', source: 'gmail' });
    expect(out.hint).toMatch(/mail headers/);
    const list = gmailCalls(h).find((r) => !r.url.includes('/messages/') && !r.url.endsWith('/profile'))!;
    expect(String(list.params?.q)).toBe('from:"Dana" OR to:"Dana" OR cc:"Dana"');
  });

  it('is not used when a contact already matches', async () => {
    const h = toolHarness({
      respond: mailbox({
        contacts: [{ resourceName: 'people/c1', names: [{ displayName: 'Dana Saved' }], emailAddresses: [{ value: 'saved@acme.example' }] }],
        rows: [{ From: 'Dana Whitfield <dana@acme.example>' }],
      }),
    });
    const out = parseResult(await h.call('contacts_resolve', { account: 'test', name: 'Dana' }));
    expect(out.resolved).toMatchObject({ email: 'saved@acme.example', source: 'contacts' });
    expect(out.hint).toBeUndefined();
    expect(gmailCalls(h)).toHaveLength(0);
  });

  it('includeMailHeaders=false keeps the lookup to contacts only', async () => {
    const h = toolHarness({ respond: mailbox({ rows: [{ From: 'Dana Whitfield <dana@acme.example>' }] }) });
    const out = parseResult(await h.call('contacts_resolve', { account: 'test', name: 'Dana', includeMailHeaders: false }));
    expect(out).toEqual({ query: 'Dana', resolved: null });
    expect(gmailCalls(h)).toHaveLength(0);
  });

  it('degrades to resolved:null when Gmail is not available', async () => {
    const h = toolHarness({ respond: mailbox({ gmailFails: true }) });
    const res = await h.call('contacts_resolve', { account: 'test', name: 'Dana' });
    expect(res.isError).toBeFalsy();
    expect(parseResult(res)).toEqual({ query: 'Dana', resolved: null });
  });

  it('returns an ambiguous list when mail shows several people with that name', async () => {
    const h = toolHarness({
      respond: mailbox({ rows: [{ From: 'Dana A <a@acme.example>' }, { To: 'Dana B <b@acme.example>' }] }),
    });
    const out = parseResult(await h.call('contacts_resolve', { account: 'test', name: 'Dana' }));
    expect(out.ambiguous).toBe(true);
    expect(out.candidates).toHaveLength(2);
    expect(out.hint).toMatch(/mail headers/);
  });

  it('resolves null when no header carries the name', async () => {
    const h = toolHarness({ respond: mailbox({ rows: [{ From: 'Someone <x@example.com>' }] }) });
    expect(parseResult(await h.call('contacts_resolve', { account: 'test', name: 'Dana' })))
      .toEqual({ query: 'Dana', resolved: null });
  });
});
