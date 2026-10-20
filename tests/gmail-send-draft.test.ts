import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { toolHarness, parseResult, type GoogleRequest } from './_tool-harness.js';

// H2: a draft gmail_create_draft checked at creation time can have its raw
// content replaced afterward via google_api_call (gmail.users.drafts.update),
// which the allowlist cannot inspect (raw base64 RFC 822). gmail_send_draft
// must not trust that history: it re-checks the draft's ACTUAL To/Cc/Bcc
// right before send. Two independent layers, each tested on its own:
//  1. ROUND 6: drafts.update no longer has its own content rule (the escape
//     hatch does not reason about body content any more); with the outbound
//     allowlist active, full-writes falls into the ask bucket instead of its
//     usual auto-allow (see escapeHatchVerdict), so the mutation still cannot
//     happen without a human to ask. ROUND 7 (HIGH 2): if the raw content is
//     not even decodable to a real MIME message (as below), the escape hatch
//     refuses outright before ever reaching the ask step, rather than ask a
//     human to confirm a prompt that cannot show the real destination.
//  2. gmail_send_draft fetches the draft and checks its real headers before
//     sending, so even if a draft's content became unlisted some other way,
//     send still refuses.
const ALLOWLIST_ENV = 'a@corp.com,@corp.com';

describe('H2: gmail_send_draft re-checks recipients while the outbound allowlist is active', () => {
  const prior = process.env.GOOGLE_OUTBOUND_ALLOWLIST;
  beforeEach(() => {
    process.env.GOOGLE_OUTBOUND_ALLOWLIST = ALLOWLIST_ENV;
  });
  afterEach(() => {
    if (prior === undefined) delete process.env.GOOGLE_OUTBOUND_ALLOWLIST;
    else process.env.GOOGLE_OUTBOUND_ALLOWLIST = prior;
  });

  it('step 1: gmail_create_draft succeeds with an allowed recipient', async () => {
    const h = toolHarness({ respond: () => ({ id: 'd1', message: { id: 'm1', threadId: 't1' } }) });
    const res = await h.call('gmail_create_draft', { account: 'test', to: 'a@corp.com', subject: 'hi', body: 'hello' });
    expect(res.isError).toBeUndefined();
    expect(parseResult(res).draftId).toBe('d1');
  });

  it('step 2: google_api_call refuses gmail.users.drafts.update outright (the raw content does not decode to a real MIME message)', async () => {
    const h = toolHarness({ respond: () => ({}) });
    const res = await h.call('google_api_call', {
      account: 'test',
      api: 'gmail',
      methodId: 'gmail.users.drafts.update',
      pathParams: { userId: 'me', id: 'd1' },
      body: { message: { raw: 'ZXZpbC1yYXctbWltZQ==' } }, // decodes to "evil-raw-mime", no real header block
    });
    expect(res.isError).toBe(true);
    const payload = parseResult(res);
    expect(payload.error).toBe('write_unsummarizable');
    expect(h.request).not.toHaveBeenCalled();
  });

  it('step 3: gmail_send_draft refuses when the draft actually carries an unlisted recipient', async () => {
    const h = toolHarness({
      respond: (req: GoogleRequest) => {
        if (req.method === 'GET' && req.url.includes('/drafts/')) {
          return { id: 'd1', message: { payload: { headers: [{ name: 'To', value: 'evil@evil.example' }] } } };
        }
        return { id: 'sent-1', threadId: 't1' };
      },
    });
    const res = await h.call('gmail_send_draft', { account: 'test', draftId: 'd1' });
    expect(res.isError).toBe(true);
    expect(parseResult(res).error).toBe('recipient_not_allowed');
    // fetched the draft to check it, but never called drafts.send
    expect(h.requests().some((r) => r.url.includes('/drafts/send'))).toBe(false);
  });

  it('gmail_send_draft still sends when the draft carries only allowed recipients', async () => {
    const h = toolHarness({
      respond: (req: GoogleRequest) => {
        if (req.method === 'GET' && req.url.includes('/drafts/')) {
          return { id: 'd1', message: { payload: { headers: [{ name: 'To', value: 'a@corp.com' }, { name: 'Cc', value: 'other@corp.com' }] } } };
        }
        return { id: 'sent-1', threadId: 't1' };
      },
    });
    const res = await h.call('gmail_send_draft', { account: 'test', draftId: 'd1' });
    expect(res.isError).toBeUndefined();
    expect(h.requests().some((r) => r.url.includes('/drafts/send'))).toBe(true);
  });

  it('gmail_send_draft refuses on a Bcc-only unlisted recipient too', async () => {
    const h = toolHarness({
      respond: (req: GoogleRequest) => {
        if (req.method === 'GET' && req.url.includes('/drafts/')) {
          return { id: 'd1', message: { payload: { headers: [{ name: 'To', value: 'a@corp.com' }, { name: 'Bcc', value: 'evil@evil.example' }] } } };
        }
        return { id: 'sent-1', threadId: 't1' };
      },
    });
    const res = await h.call('gmail_send_draft', { account: 'test', draftId: 'd1' });
    expect(res.isError).toBe(true);
    expect(h.requests().some((r) => r.url.includes('/drafts/send'))).toBe(false);
  });

  // LOW (item 8): RFC 5322 permits a header to repeat; a raw message
  // substituted in via gmail.users.drafts.update (the allowlist cannot
  // inspect that raw content, so it refuses the call outright, but this
  // re-check must still catch the result of any OTHER way the draft's
  // content changed) could carry a SECOND To line instead of a comma-
  // joined one. getHeader's .find only ever sees the first.
  it('gmail_send_draft refuses on an unlisted recipient hiding in a SECOND, repeated To header', async () => {
    const h = toolHarness({
      respond: (req: GoogleRequest) => {
        if (req.method === 'GET' && req.url.includes('/drafts/')) {
          return {
            id: 'd1',
            message: {
              payload: {
                headers: [
                  { name: 'To', value: 'a@corp.com' },
                  { name: 'To', value: 'evil@evil.example' },
                ],
              },
            },
          };
        }
        return { id: 'sent-1', threadId: 't1' };
      },
    });
    const res = await h.call('gmail_send_draft', { account: 'test', draftId: 'd1' });
    expect(res.isError).toBe(true);
    expect(parseResult(res).error).toBe('recipient_not_allowed');
    expect(h.requests().some((r) => r.url.includes('/drafts/send'))).toBe(false);
  });
});

describe('gmail_send_draft when the outbound allowlist is off (default)', () => {
  it('sends without fetching the draft first (no-op guard, no extra API call)', async () => {
    const h = toolHarness({ respond: () => ({ id: 'sent-1', threadId: 't1' }) });
    const res = await h.call('gmail_send_draft', { account: 'test', draftId: 'd1' });
    expect(res.isError).toBeUndefined();
    expect(h.requests()).toHaveLength(1); // only drafts.send, no drafts.get
    expect(h.requests()[0].url).toContain('/drafts/send');
  });
});
