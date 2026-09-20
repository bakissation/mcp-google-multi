import { describe, it, expect } from 'vitest';
import http from 'node:http';
import type { OAuth2Client } from 'googleapis-common';
import {
  openLoopbackConsent,
  ConsentDeniedError,
  ConsentTimeoutError,
} from '../src/oauth-consent.js';

// The exchange is stubbed: unit tests never talk to Google. Only the loopback
// listener and its state machine are under test.
function stubClient(tokens: Record<string, unknown> = { access_token: 'tok' }): OAuth2Client {
  return { getToken: async () => ({ tokens }) } as unknown as OAuth2Client;
}

function get(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    }).on('error', reject);
  });
}

describe('openLoopbackConsent (ephemeral port)', () => {
  it('binds an ephemeral loopback port and exposes it in the redirect', async () => {
    const loop = await openLoopbackConsent();
    expect(loop.redirect).toMatch(/^http:\/\/localhost:\d+\/oauth2callback$/);
    loop.close();
  });

  it('two concurrent consents get distinct ports (the fixed-port collision class)', async () => {
    const a = await openLoopbackConsent();
    const b = await openLoopbackConsent();
    expect(a.redirect).not.toBe(b.redirect);
    a.close();
    b.close();
  });

  it('exchanges the code on a state-matched redirect', async () => {
    const loop = await openLoopbackConsent();
    const consent = loop.finish(stubClient({ access_token: 'tok', scope: 's' }), 'state-1');
    const status = await get(`${loop.redirect}?state=state-1&code=abc`);
    expect(status).toBe(200);
    await expect(consent).resolves.toEqual({ access_token: 'tok', scope: 's' });
  });

  it('rejects a state mismatch without exchanging', async () => {
    const loop = await openLoopbackConsent();
    // Attach the rejection handler BEFORE the redirect fires, or the reject
    // lands as an unhandled rejection while the test awaits the HTTP call.
    const rejection = expect(loop.finish(stubClient(), 'expected')).rejects.toThrow(/E_OAUTH_STATE_MISMATCH/);
    const status = await get(`${loop.redirect}?state=wrong&code=abc`);
    expect(status).toBe(400);
    await rejection;
  });

  it('rejects a denial redirect with E_CONSENT_DENIED', async () => {
    const loop = await openLoopbackConsent();
    const rejection = expect(loop.finish(stubClient(), 'state-1')).rejects.toBeInstanceOf(ConsentDeniedError);
    const status = await get(`${loop.redirect}?error=access_denied`);
    expect(status).toBe(400);
    await rejection;
  });

  it('times out an unanswered consent', async () => {
    const loop = await openLoopbackConsent({ timeoutMs: 25 });
    const consent = loop.finish(stubClient(), 'state-1');
    await expect(consent).rejects.toBeInstanceOf(ConsentTimeoutError);
  });

  it('close() abandons quietly: listener down, finish never settles', async () => {
    const loop = await openLoopbackConsent();
    const consent = loop.finish(stubClient(), 'state-1');
    let settled = false;
    consent.then(() => { settled = true; }, () => { settled = true; });
    loop.close();
    await expect(get(`${loop.redirect}?state=state-1&code=abc`)).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
  });
});
