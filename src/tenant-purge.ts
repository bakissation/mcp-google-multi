// S1.21: tenant offboarding primitives. Core owns the reusable token-purge
// legs (generically useful, tenant-id-agnostic); the tenant_delete
// ORCHESTRATION (what to purge, in what order, from which admin surface)
// lives with the tenancy module that calls these.

import fs from 'node:fs';
import path from 'node:path';
import { tenantConfigFilePath, tenantTokenDir } from './config-file.js';
import { createTokenStore } from './token-store.js';
import type { TokenData } from './types.js';

/** Best-effort Google-side revocation (RFC 7009 endpoint). Returns whether
 * Google acknowledged; NEVER throws — a network failure must not block the
 * local purge (the local copy is the thing we control). */
export async function revokeGoogleToken(
  tokenData: { refresh_token?: string; access_token?: string },
  fetchFn: typeof fetch = fetch,
): Promise<boolean> {
  const token = tokenData.refresh_token ?? tokenData.access_token;
  if (!token) return false;
  try {
    const res = await fetchFn('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export interface TenantTokenPurge {
  /** Aliases whose .enc files were removed. */
  removed: string[];
  /** How many tokens Google acknowledged revoking (best-effort). */
  revoked: number;
}

/** Remove every `.enc` under the tenant's token dir, optionally revoking each
 * at Google first. Decrypt failures still purge the file — an unreadable
 * token is exactly the thing to delete. Only THIS tenant's dir is touched. */
export async function purgeTenantTokens(
  tenantId: string,
  opts: { env?: NodeJS.ProcessEnv; revoke?: (t: TokenData) => Promise<boolean>; resolveKey?: () => string } = {},
): Promise<TenantTokenPurge> {
  const dir = tenantTokenDir(tenantId, opts.env);
  const store = createTokenStore(dir, { tenantId, resolveKey: opts.resolveKey });
  const removed: string[] = [];
  let revoked = 0;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return { removed, revoked }; // no token dir = nothing to purge
  }
  for (const name of names) {
    if (!name.endsWith('.enc')) continue;
    const alias = name.slice(0, -'.enc'.length);
    if (opts.revoke) {
      try {
        const token = store.readToken(alias);
        if (token && (await opts.revoke(token))) revoked += 1;
      } catch {
        // undecryptable or invalid-alias filename: still remove the file
      }
    }
    fs.rmSync(path.join(dir, name), { force: true });
    removed.push(alias);
  }
  return { removed, revoked };
}

/** Remove the whole tenants/<id> directory (config + tokens). The id is
 * validated by the path helper, so a traversal-shaped id throws before any
 * filesystem access. */
export function removeTenantDir(tenantId: string, env?: NodeJS.ProcessEnv): void {
  fs.rmSync(path.dirname(tenantConfigFilePath(tenantId, env)), { recursive: true, force: true });
}
