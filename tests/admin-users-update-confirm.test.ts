import { describe, it, expect } from 'vitest';
import { toolHarness, accountSet, parseResult } from './_tool-harness.js';

const ADMIN = () => accountSet({ test: { email: 'test@harness.example', admin: true } }, { defaultAccount: 'test' });
const ARGS = { account: 'test', userKey: 'victim@harness.example', suspended: true };
const policy = (profile: 'safe-writes' | 'full-writes' | 'read-only', extra: Record<string, unknown> = {}) =>
  ({ profile, readOnly: false, allow: [], deny: [], ...extra }) as never;

describe('admin_users_update goes through the same confirmation as other writes', () => {
  it('asks under safe-writes, shows the user and the change, and runs only after accept', async () => {
    const h = toolHarness({ accounts: ADMIN(), policy: policy('safe-writes'), elicit: 'accept' });
    const res = await h.call('admin_users_update', { ...ARGS, password: 'hunter2hunter2' });
    expect(res.isError).toBeFalsy();
    expect(h.elicitInput).toHaveBeenCalledTimes(1);
    const prompt = (h.elicitInput.mock.calls[0][0] as { message: string }).message;
    expect(prompt).toContain('directory.users.patch');
    expect(prompt).toContain('victim@harness.example');
    expect(prompt).toContain('suspended');
    expect(prompt).not.toContain('hunter2hunter2');
    expect(h.requests().filter((r) => r.method === 'PATCH')).toHaveLength(1);
  });

  it('does not run when the human declines or cancels', async () => {
    for (const elicit of ['decline', 'cancel'] as const) {
      const h = toolHarness({ accounts: ADMIN(), policy: policy('safe-writes'), elicit });
      const res = await h.call('admin_users_update', ARGS);
      expect(res.isError).toBe(true);
      expect(parseResult(res).error).toBe('write_declined');
      expect(h.requests()).toHaveLength(0);
    }
  });

  it('does not run when the client cannot be asked', async () => {
    const h = toolHarness({ accounts: ADMIN(), policy: policy('safe-writes') });
    const res = await h.call('admin_users_update', ARGS);
    expect(res.isError).toBe(true);
    expect(parseResult(res).error).toBe('elicitation_unsupported');
    expect(h.requests()).toHaveLength(0);
  });

  it('runs without asking under full-writes', async () => {
    const h = toolHarness({ accounts: ADMIN(), policy: policy('full-writes') });
    const res = await h.call('admin_users_update', ARGS);
    expect(res.isError).toBeFalsy();
    expect(h.elicitInput).not.toHaveBeenCalled();
    expect(h.requests().filter((r) => r.method === 'PATCH')).toHaveLength(1);
  });

  it('refuses under a read-only policy and under GOOGLE_WRITE_DENY, even if the human would accept', async () => {
    const ro = toolHarness({ accounts: ADMIN(), policy: { profile: 'read-only', readOnly: true, allow: [], deny: [] }, elicit: 'accept' });
    expect((await ro.call('admin_users_update', ARGS)).isError).toBe(true);
    expect(ro.requests()).toHaveLength(0);

    const denied = toolHarness({ accounts: ADMIN(), policy: policy('full-writes', { deny: ['tool:admin_users_update'] }), elicit: 'accept' });
    expect((await denied.call('admin_users_update', ARGS)).isError).toBe(true);
    expect(denied.requests()).toHaveLength(0);
  });

  it('does not ask for a call that would change nothing', async () => {
    const h = toolHarness({ accounts: ADMIN(), policy: policy('safe-writes'), elicit: 'accept' });
    const res = await h.call('admin_users_update', { account: 'test', userKey: 'victim@harness.example' });
    expect(parseResult(res).error).toBe('invalid_params');
    expect(h.elicitInput).not.toHaveBeenCalled();
    expect(h.requests()).toHaveLength(0);
  });

  it('keeps refusing under the default read-only profile, and asks again once explicitly allowed', async () => {
    const ro = toolHarness({ accounts: ADMIN(), policy: policy('read-only'), elicit: 'accept' });
    const res = await ro.call('admin_users_update', ARGS);
    expect(res.isError).toBe(true);
    expect(parseResult(res).error).toBe('write_disabled');
    expect(ro.elicitInput).not.toHaveBeenCalled();
    expect(ro.requests()).toHaveLength(0);

    const allowed = toolHarness({ accounts: ADMIN(), policy: policy('read-only', { allow: ['tool:admin_users_update'] }), elicit: 'accept' });
    expect((await allowed.call('admin_users_update', ARGS)).isError).toBeFalsy();
    expect(allowed.elicitInput).toHaveBeenCalledTimes(1);
  });

  it('an allow entry does not skip the ask under safe-writes', async () => {
    const h = toolHarness({ accounts: ADMIN(), policy: policy('safe-writes', { allow: ['tool:admin_users_update'] }), elicit: 'decline' });
    await h.call('admin_users_update', ARGS);
    expect(h.elicitInput).toHaveBeenCalledTimes(1);
    expect(h.requests()).toHaveLength(0);
  });

  it('refuses on the shared deny names too', async () => {
    for (const deny of ['admin:update', 'tool:admin_users_patch']) {
      const h = toolHarness({ accounts: ADMIN(), policy: policy('full-writes', { deny: [deny] }), elicit: 'accept' });
      expect((await h.call('admin_users_update', ARGS)).isError).toBe(true);
      expect(h.requests()).toHaveLength(0);
    }
  });

  it('never shows a password in the prompt, even one shaped like an email or a URL', async () => {
    for (const password of ['Summer@2024.Co', 'https://pw.example/Xk29']) {
      const h = toolHarness({ accounts: ADMIN(), policy: policy('safe-writes'), elicit: 'decline' });
      await h.call('admin_users_update', { ...ARGS, password });
      const prompt = (h.elicitInput.mock.calls[0][0] as { message: string }).message;
      expect(prompt).not.toContain(password);
      expect(prompt).not.toContain('pw.example');
    }
  });

  it('shows whether a password change is forced, and the target when userKey is an opaque id', async () => {
    const h = toolHarness({ accounts: ADMIN(), policy: policy('safe-writes'), elicit: 'decline' });
    await h.call('admin_users_update', { account: 'test', userKey: '104829301234567890123', changePasswordAtNextLogin: true });
    const prompt = (h.elicitInput.mock.calls[0][0] as { message: string }).message;
    expect(prompt).toContain('"changePasswordAtNextLogin":true');
    const destinations = prompt.split('\n').find((l) => l.startsWith('Destinations')) ?? '';
    expect(destinations).toContain('104829301234567890123');
  });
});
