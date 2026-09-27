import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { revokeGoogleToken, purgeTenantTokens, removeTenantDir } from '../src/tenant-purge.js';
import { createTokenStore } from '../src/token-store.js';
import { ensureTenantDirs, tenantsDir } from '../src/config-file.js';
import { RefreshStore } from '../src/mcp-token.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

afterEach(() => {
  fs.rmSync(tenantsDir(), { recursive: true, force: true });
});

function seedTenant(tenantId: string, aliases: string[]): void {
  const { tokenDir } = ensureTenantDirs(tenantId);
  const store = createTokenStore(tokenDir, { tenantId, resolveKey: () => 'purge-test-key' });
  for (const a of aliases) store.writeToken(a, { refresh_token: `rt-${tenantId}-${a}` });
}

describe('revokeGoogleToken (best-effort, never throws)', () => {
  it('POSTs the refresh token and reports acknowledgement', async () => {
    const calls: string[] = [];
    const ok = await revokeGoogleToken({ refresh_token: 'rt-1' }, (async (url: string, init: RequestInit) => {
      calls.push(`${url} ${String(init.body)}`);
      return { ok: true } as Response;
    }) as typeof fetch);
    expect(ok).toBe(true);
    expect(calls[0]).toContain('oauth2.googleapis.com/revoke');
    expect(calls[0]).toContain('token=rt-1');
  });

  it('a network failure or missing token is false, never a throw', async () => {
    expect(
      await revokeGoogleToken({ refresh_token: 'rt' }, (async () => {
        throw new Error('offline');
      }) as unknown as typeof fetch),
    ).toBe(false);
    expect(await revokeGoogleToken({})).toBe(false);
  });
});

describe('purgeTenantTokens (S1.21: only the target tenant)', () => {
  it('removes exactly the target tenant\'s .enc files, revoking each first', async () => {
    seedTenant('tenant-a', ['work', 'personal']);
    seedTenant('tenant-b', ['work']);
    const revokedTokens: string[] = [];
    const res = await purgeTenantTokens('tenant-a', {
      resolveKey: () => 'purge-test-key',
      revoke: async (t) => {
        revokedTokens.push(String(t.refresh_token));
        return true;
      },
    });
    expect(res.removed.sort()).toEqual(['personal', 'work']);
    expect(res.revoked).toBe(2);
    expect(revokedTokens.sort()).toEqual(['rt-tenant-a-personal', 'rt-tenant-a-work']);
    // tenant-a's files are gone; tenant-b is untouched
    expect(fs.readdirSync(path.join(tenantsDir(), 'tenant-a', 'tokens'))).toEqual([]);
    expect(fs.readdirSync(path.join(tenantsDir(), 'tenant-b', 'tokens'))).toEqual(['work.enc']);
  });

  it('an undecryptable file is still purged (revoke skipped)', async () => {
    seedTenant('tenant-a', ['work']);
    const dir = path.join(tenantsDir(), 'tenant-a', 'tokens');
    fs.writeFileSync(path.join(dir, 'broken.enc'), 'not-json');
    const res = await purgeTenantTokens('tenant-a', { revoke: async () => true });
    expect(res.removed.sort()).toEqual(['broken', 'work']);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('a missing tenant dir is a clean no-op', async () => {
    expect(await purgeTenantTokens('tenant-zz')).toEqual({ removed: [], revoked: 0 });
  });
});

describe('removeTenantDir', () => {
  it('removes config + tokens for the id and validates it first', () => {
    seedTenant('tenant-a', ['work']);
    removeTenantDir('tenant-a');
    expect(fs.existsSync(path.join(tenantsDir(), 'tenant-a'))).toBe(false);
    expect(() => removeTenantDir('../evil')).toThrow(/E_TENANT_ID_INVALID/);
  });
});

describe('RefreshStore.purgeTenant (S1.21)', () => {
  it('drops only sub-matching active records; other subs keep rotating', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'gm-purge-'));
    try {
      const s = new RefreshStore(path.join(dir, 'mcp-tokens.enc'), 'mk');
      const a1 = s.issue(1000, 'tenant-a');
      const a2 = s.issue(1000, 'tenant-a');
      const b1 = s.issue(1000, 'tenant-b');
      expect(s.purgeTenant('tenant-a')).toBe(2);
      expect(s.rotate(a1, 2000)).toBeNull();
      expect(s.rotate(a2, 2000)).toBeNull();
      const rb = s.rotate(b1, 2000);
      expect(rb!.sub).toBe('tenant-b');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('RefreshStore.rotate accept (checked before the token is spent)', () => {
  let dir: string;
  afterEach(() => dir && fs.rmSync(dir, { recursive: true, force: true }));
  const storeAt = () => {
    dir = mkdtempSync(path.join(tmpdir(), 'gm-accept-'));
    const file = path.join(dir, 'mcp-tokens.enc');
    return { s: new RefreshStore(file, 'mk'), file };
  };

  it('accept false drops every active record of that sub, returns null, and other subjects keep rotating', () => {
    const { s } = storeAt();
    const a1 = s.issue(1000, 'tenant-a');
    const a2 = s.issue(1000, 'tenant-a');
    const b1 = s.issue(1000, 'tenant-b');
    const seen: string[] = [];
    expect(
      s.rotate(a1, 2000, (sub) => {
        seen.push(sub);
        return false;
      }),
    ).toBeNull();
    expect(seen).toEqual(['tenant-a']);
    expect(s.rotate(a1, 3000, () => true)).toBeNull();
    expect(s.rotate(a2, 3000, () => true)).toBeNull();
    expect(s.purgeTenant('tenant-a')).toBe(0);
    const rb = s.rotate(b1, 3000, (sub) => sub === 'tenant-b');
    expect(rb!.sub).toBe('tenant-b');
  });

  it('a throwing accept mutates nothing: the store bytes are unchanged and the same token rotates once accept recovers', () => {
    const { s, file } = storeAt();
    const a1 = s.issue(1000, 'tenant-a');
    const before = fs.readFileSync(file);
    expect(() =>
      s.rotate(a1, 2000, () => {
        throw new Error('registry unreadable');
      }),
    ).toThrow('registry unreadable');
    expect(fs.readFileSync(file).equals(before)).toBe(true);
    const r = s.rotate(a1, 3000, () => true);
    expect(r!.sub).toBe('tenant-a');
    expect(r!.token).not.toBe(a1);
  });

  it('a reuse of a rotated-away token never consults accept and still revokes the family', () => {
    const { s } = storeAt();
    const a1 = s.issue(1000, 'tenant-a');
    const a2 = s.rotate(a1, 2000)!;
    let calls = 0;
    const accept = () => {
      calls += 1;
      return true;
    };
    expect(s.rotate(a1, 3000, accept)).toBeNull();
    expect(calls).toBe(0);
    expect(s.rotate(a2.token, 4000, accept)).toBeNull();
    expect(s.rotate('never-issued', 4000, accept)).toBeNull();
    expect(calls).toBe(0);
  });
});
