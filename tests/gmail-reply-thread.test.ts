import { describe, it, expect } from 'vitest';
import { toolHarness, type GoogleRequest } from './_tool-harness.js';

// A reply sent with replyToMessageId must carry the source message's Gmail
// threadId, or it lands in a new thread on the sender's side.
const source = (req: GoogleRequest): unknown | undefined => {
  if (req.method === 'GET' && req.url.includes('/messages/SRC1')) {
    return {
      id: 'SRC1',
      threadId: 'THREAD-7',
      payload: { headers: [
        { name: 'From', value: 'alice@ext.com' },
        { name: 'To', value: 'test@harness.example' },
        { name: 'Subject', value: 'Question' },
        { name: 'Message-ID', value: '<src@ext>' },
      ] },
    };
  }
  return undefined;
};

describe('gmail reply keeps the source thread', () => {
  it('gmail_send puts the source threadId in the send body', async () => {
    const h = toolHarness({ respond: (req) => source(req) ?? { id: 'sent', threadId: 'THREAD-7' } });
    const res = await h.call('gmail_send', { account: 'test', body: 'thanks', replyToMessageId: 'SRC1' });
    expect(res.isError).toBeUndefined();
    const send = h.requests().find((r) => r.method === 'POST' && r.url.includes('/messages/send'));
    expect((send?.data as any)?.threadId).toBe('THREAD-7');
  });

  it('an explicit replyToThreadId wins over the source thread', async () => {
    const h = toolHarness({ respond: (req) => source(req) ?? { id: 'sent', threadId: 'OTHER' } });
    await h.call('gmail_send', { account: 'test', body: 'thanks', replyToMessageId: 'SRC1', replyToThreadId: 'OTHER' });
    const send = h.requests().find((r) => r.method === 'POST' && r.url.includes('/messages/send'));
    expect((send?.data as any)?.threadId).toBe('OTHER');
  });

  it('gmail_create_draft puts the source threadId in the draft message', async () => {
    const h = toolHarness({ respond: (req) => source(req) ?? { id: 'd1', message: { id: 'm1', threadId: 'THREAD-7' } } });
    const res = await h.call('gmail_create_draft', { account: 'test', body: 'thanks', replyToMessageId: 'SRC1' });
    expect(res.isError).toBeUndefined();
    const create = h.requests().find((r) => r.method === 'POST' && r.url.includes('/drafts'));
    expect((create?.data as any)?.message?.threadId).toBe('THREAD-7');
  });

  it('a plain send without a reply source sets no threadId', async () => {
    const h = toolHarness({ respond: () => ({ id: 'sent', threadId: 'T' }) });
    await h.call('gmail_send', { account: 'test', to: 'a@b.com', subject: 's', body: 'b' });
    const send = h.requests().find((r) => r.method === 'POST' && r.url.includes('/messages/send'));
    expect((send?.data as any)?.threadId).toBeUndefined();
  });
});
