import { describe, it, expect, vi } from 'vitest';
import { fakeServer, parseResult as parse, type GoogleRequest } from './_tool-harness.js';
import { buildRegistry } from '../src/compose.js';
import { buildIdentityContext } from '../src/identity.js';
import { isNoGoogleAccountShareError } from '../src/tools/drive.js';

// Sharing with an address that has no Google account needs the invitation
// email; with notifications off Google's 400 says so only in passing.
const NO_ACCOUNT = 'Bad Request. User message: "Since there is no Google account associated with this email address, you must set sendNotificationEmail to true."';

function failingHarness(status: number, message: string) {
  const request = vi.fn(async (_req: GoogleRequest) => {
    throw Object.assign(new Error(message), { code: status, response: { status, data: { error: { code: status, message } } } });
  });
  const ctx = buildIdentityContext({} as NodeJS.ProcessEnv) as any;
  ctx.getClient = async () => ({ request });
  ctx.policy = { profile: 'full-writes', readOnly: false, allow: [], deny: [] };
  const { server, handlers } = fakeServer();
  buildRegistry(server as never, ctx, 'eager');
  return { handlers };
}

describe('drive_share to an address without a Google account', () => {
  const base = { account: 'test', fileId: 'F1', type: 'user', role: 'reader', emailAddress: 'nobody@example.com' };

  it('says to turn notifications on when they were turned off', async () => {
    const h = failingHarness(400, NO_ACCOUNT);
    const env = parse(await h.handlers.drive_share({ ...base, sendNotification: false }));
    expect(env.error).toBe('bad_request');
    expect(env.hint).toContain('sendNotification:true');
    expect(env.hint).toContain('nobody@example.com');
  });

  it('keeps the generic 400 hint when notifications were already on', async () => {
    const h = failingHarness(400, NO_ACCOUNT);
    const env = parse(await h.handlers.drive_share(base));
    expect(env.error).toBe('bad_request');
    expect(env.hint).not.toContain('sendNotification:true');
  });

  it('does not claim it for an unrelated 400', async () => {
    const h = failingHarness(400, 'Invalid value for role.');
    const env = parse(await h.handlers.drive_share({ ...base, sendNotification: false }));
    expect(env.hint).not.toContain('sendNotification:true');
  });

  it('detector only matches a 400 with the notification wording', () => {
    expect(isNoGoogleAccountShareError({ code: 400, message: NO_ACCOUNT })).toBe(true);
    expect(isNoGoogleAccountShareError({ code: 403, message: NO_ACCOUNT })).toBe(false);
    expect(isNoGoogleAccountShareError({ code: 400, message: 'Invalid value' })).toBe(false);
  });
});
