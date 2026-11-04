import { describe, it, expect } from 'vitest';
import { resolveReply, deriveReplySubject } from '../src/tools/gmail.js';

// Fake Gmail client exposing only what resolveReply touches. It memoizes the own-address set
// per account, so every test below uses a unique account string to avoid cross-test cache bleed.
function fakeGmail(opts: { headers?: Array<{ name: string; value: string }>; sendAs?: string[]; throwGet?: boolean; sendAsThrows?: boolean; threadId?: string }) {
  return {
    users: {
      messages: {
        get: async () => {
          if (opts.throwGet) throw new Error('404');
          return { data: { threadId: opts.threadId, payload: { headers: opts.headers ?? [] } } };
        },
      },
      settings: {
        sendAs: {
          list: async () => {
            if (opts.sendAsThrows) throw new Error('insufficient_scope');
            return { data: { sendAs: (opts.sendAs ?? []).map((e) => ({ sendAsEmail: e })) } };
          },
        },
      },
    },
  };
}

const H = (h: Record<string, string>) => Object.entries(h).map(([name, value]) => ({ name, value }));

describe('deriveReplySubject', () => {
  it('prefixes Re: when absent', () => expect(deriveReplySubject('Question')).toBe('Re: Question'));
  it('does not double-prefix (case-insensitive)', () => {
    expect(deriveReplySubject('Re: Sync')).toBe('Re: Sync');
    expect(deriveReplySubject('re: sync')).toBe('re: sync');
    expect(deriveReplySubject('  RE: x')).toBe('RE: x');
  });
});

describe('resolveReply (auto-fill)', () => {
  it('derives to=From, subject=Re:, threading headers; no cc without replyAll', async () => {
    const g = fakeGmail({
      headers: H({ From: 'Alice <alice@ext.com>', To: 'me@acct.com', Subject: 'Question', 'Message-ID': '<abc@ext>' }),
    });
    const r = await resolveReply(g, 'acct-basic', 'me@acct.com', 'MID1', false);
    expect(r.sourceFound).toBe(true);
    expect(r.to).toBe('Alice <alice@ext.com>');
    expect(r.subject).toBe('Re: Question');
    expect(r.cc).toBeUndefined();
    expect(r.inReplyTo).toBe('<abc@ext>');
    expect(r.references).toBe('<abc@ext>');
  });

  it('replyAll: cc = source To+Cc minus own (primary + send-as alias) minus to', async () => {
    const g = fakeGmail({
      headers: H({
        From: 'alice@ext.com',
        To: 'me@acct.com, bob@ext.com',
        Cc: 'carol@ext.com, alias@acct.com',
        Subject: 'Sync',
        'Message-ID': '<m@ext>',
      }),
      sendAs: ['alias@acct.com'],
    });
    const r = await resolveReply(g, 'acct-replyall', 'me@acct.com', 'MID2', true);
    expect(r.to).toBe('alice@ext.com');
    const cc = r.cc ?? '';
    expect(cc).toContain('bob@ext.com');
    expect(cc).toContain('carol@ext.com');
    expect(cc).not.toContain('me@acct.com');
    expect(cc).not.toContain('alias@acct.com');
    expect(cc).not.toContain('alice@ext.com');
  });

  it('replying to your own sent mail: to falls back to source To', async () => {
    const g = fakeGmail({
      headers: H({ From: 'me@acct.com', To: 'client@ext.com', Subject: 'Proposal', 'Message-ID': '<s@acct>' }),
    });
    const r = await resolveReply(g, 'acct-self', 'me@acct.com', 'MID3', false);
    expect(r.to).toBe('client@ext.com');
    expect(r.subject).toBe('Re: Proposal');
  });

  it('send-as lookup failure degrades to primary only (still excludes primary)', async () => {
    const g = fakeGmail({
      headers: H({ From: 'alice@ext.com', To: 'me@acct.com, bob@ext.com', Subject: 'X', 'Message-ID': '<x@ext>' }),
      sendAsThrows: true,
    });
    const r = await resolveReply(g, 'acct-sendasfail', 'me@acct.com', 'MID4', true);
    expect(r.cc ?? '').toContain('bob@ext.com');
    expect(r.cc ?? '').not.toContain('me@acct.com');
  });

  it('source fetch failure → sourceFound:false, threading degrades to the id, no derived recipients', async () => {
    const g = fakeGmail({ throwGet: true });
    const r = await resolveReply(g, 'acct-404', 'me@acct.com', 'MID404', false);
    expect(r.sourceFound).toBe(false);
    expect(r.inReplyTo).toBe('MID404');
    expect(r.references).toBe('MID404');
    expect(r.to).toBeUndefined();
    expect(r.subject).toBeUndefined();
  });

  it('two mailboxes sharing an alias name never share an own-address set', async () => {
    const headers = H({ From: 'alice@ext.com', To: 'first@one.example, second@two.example', Subject: 'S' });
    const one = fakeGmail({ headers, sendAs: ['first@one.example'] });
    const two = fakeGmail({ headers, sendAs: ['second@two.example'] });
    const r1 = await resolveReply(one, 'acct-shared', 'first@one.example', 'M1', true);
    const r2 = await resolveReply(two, 'acct-shared', 'second@two.example', 'M2', true);
    expect(r1.cc).toBe('second@two.example');
    expect(r2.cc).toBe('first@one.example');
  });
});


describe('resolveReply (thread)', () => {
  it('returns the source thread id so the reply stays in the thread', async () => {
    const g = fakeGmail({ threadId: 'T-42', headers: H({ From: 'a@ext.com', Subject: 'x', 'Message-ID': '<m@ext>' }) });
    const r = await resolveReply(g, 'acct-thread', 'me@acct.com', 'MID9', false);
    expect(r.threadId).toBe('T-42');
  });

  it('has no thread id when the source cannot be fetched', async () => {
    const g = fakeGmail({ throwGet: true });
    const r = await resolveReply(g, 'acct-thread-miss', 'me@acct.com', 'MID10', false);
    expect(r.sourceFound).toBe(false);
    expect(r.threadId).toBeUndefined();
  });
});
