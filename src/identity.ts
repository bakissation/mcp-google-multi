import type { AccountSet } from './accounts.js';
import { getAccountSet } from './accounts.js';
import { getClient } from './client.js';
import { hasToken, readToken, updateToken, writeToken } from './token-store.js';
import { resolvePolicy, type Policy, type Transport } from './write-control.js';

/**
 * The one forward-compat seam (frozen public API): the free core builds
 * exactly one context with subject "owner"; EE later instantiates N contexts
 * from N registries. Nothing here may assume a global current-account.
 */
export interface IdentityContext {
  subject: 'owner';
  accounts: AccountSet;
  policy: Policy;
  getClient: typeof getClient;
  tokenStore: {
    readToken: typeof readToken;
    writeToken: typeof writeToken;
    updateToken: typeof updateToken;
    hasToken: typeof hasToken;
  };
}

export function buildIdentityContext(
  env: NodeJS.ProcessEnv = process.env,
  opts: { transport?: Transport } = {},
): IdentityContext {
  return {
    subject: 'owner',
    // Live getter: the seam must always see the current registry, never a
    // snapshot pinned from before a wizard mutation or cross-process reload.
    get accounts() {
      return getAccountSet();
    },
    // The dispatch transport rides into the resolved policy as a reserved seam
    // (cc-write-control B14); it does not change any write-control verdict.
    policy: resolvePolicy(env, { transport: opts.transport }),
    getClient,
    tokenStore: { readToken, writeToken, updateToken, hasToken },
  };
}
