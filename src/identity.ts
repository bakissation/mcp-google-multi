import type { AccountSet } from './accounts.js';
import { getAccountSet, getTokenDir, refreshAccountSetIfStale } from './accounts.js';
import { getClient, makeGetClient } from './client.js';
import { createTokenStore, hasToken, readToken, updateToken, writeToken } from './token-store.js';
import { resolvePolicy, type Policy, type Transport } from './write-control.js';

/**
 * The one forward-compat seam (frozen public API): the free core builds
 * exactly one context with subject "owner"; EE later instantiates N contexts
 * from N registries. Nothing here may assume a global current-account.
 * `subject` is a string (not the literal 'owner') so a context can carry a
 * tenant id; the free core still always builds 'owner'.
 */
export interface IdentityContext {
  subject: string;
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
  // Real closures over the single-owner state (the SAME factories EE
  // instantiates per tenant), bound here to the global registry + token dir —
  // behavior-identical to the module-level functions for the free core.
  const tokenStore = createTokenStore(getTokenDir());
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
    getClient: makeGetClient('owner', {
      accounts: getAccountSet,
      readToken: tokenStore.readToken,
      updateToken: tokenStore.updateToken,
      refreshIfStale: refreshAccountSetIfStale,
    }),
    tokenStore,
  };
}
