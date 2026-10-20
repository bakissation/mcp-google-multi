import type { AccountSet } from './accounts.js';
import { getAccountSet, getTokenDir, refreshAccountSetIfStale } from './accounts.js';
import { getClient, makeGetClient } from './client.js';
import { createTokenStore, hasToken, readToken, updateToken, writeToken } from './token-store.js';
import { resolvePolicy, type Policy, type Transport } from './write-control.js';

/**
 * The one forward-compat seam (frozen public API): the free core builds
 * exactly one context with subject "owner"; a multi-tenant host instantiates
 * N contexts from N registries. Nothing here may assume a global current-account.
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

// Only buildIdentityContext mints the owner brand: the subject string alone
// never unlocks owner-only surfaces, so a hand-built context claiming 'owner' stays non-owner.
const ownerContexts = new WeakSet<object>();

export function isOwnerContext(ctx: object | undefined): boolean {
  return ctx !== undefined && ownerContexts.has(ctx);
}

export function buildIdentityContext(
  env: NodeJS.ProcessEnv = process.env,
  opts: { transport?: Transport } = {},
): IdentityContext {
  // The SAME factories a multi-tenant host instantiates per tenant, bound here
  // to the global registry + token dir.
  const tokenStore = createTokenStore(getTokenDir());
  const ctx: IdentityContext = {
    subject: 'owner',
    // Live getter: the seam must always see the current registry, never a
    // snapshot pinned from before a wizard mutation or cross-process reload.
    get accounts() {
      return getAccountSet();
    },
    // The dispatch transport rides into the resolved policy: it never changes
    // isAllowed's verdict or the profile, but over HTTP it does turn an
    // escape-hatch "ask" into a refusal (see Policy.transport in
    // write-control.ts and docs/internals.md).
    policy: resolvePolicy(env, { transport: opts.transport }),
    getClient: makeGetClient('owner', {
      accounts: getAccountSet,
      readToken: tokenStore.readToken,
      updateToken: tokenStore.updateToken,
      refreshIfStale: refreshAccountSetIfStale,
    }),
    tokenStore,
  };
  ownerContexts.add(ctx);
  return ctx;
}
