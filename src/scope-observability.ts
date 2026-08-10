import { ADMIN_SCOPES, BUNDLE_CATALOG } from './scope-catalog.js';
import { BASE_SCOPES, resolveScopesForAccount } from './auth.js';
import { readToken } from './token-store.js';

// The #114 three-state model: what action, if any, reaches a granted state.
export type ScopeState = 'callable' | 'requestable_not_granted' | 'not_requestable';
export type NotRequestableReason = 'add_bundle' | 'account_type' | 'unknown_scope';

export interface ScopeClassification {
  state: ScopeState;
  reason?: NotRequestableReason;
  bundle?: string;
  alsoIn?: string[];
}

// Reverse index scope -> bundles offering it, narrowest bundle first (fewest
// scopes) so the remediation names the smallest grant. BASE_SCOPES map to the
// pseudo-bundle "base" (outside a profile only via includesBase:false).
let reverseIndex: Map<string, string[]> | null = null;

function scopeIndex(): Map<string, string[]> {
  if (reverseIndex) return reverseIndex;
  const idx = new Map<string, string[]>();
  const add = (scope: string, bundle: string) => {
    const list = idx.get(scope) ?? [];
    list.push(bundle);
    idx.set(scope, list);
  };
  for (const [name, entry] of Object.entries(BUNDLE_CATALOG)) {
    for (const scope of entry.scopes) add(scope, name);
  }
  for (const scope of BASE_SCOPES) add(scope, 'base');
  const size = (b: string) => (b === 'base' ? BASE_SCOPES.length : BUNDLE_CATALOG[b].scopes.length);
  for (const list of idx.values()) list.sort((a, b) => size(a) - size(b) || a.localeCompare(b));
  reverseIndex = idx;
  return idx;
}

export function classifyScope(scope: string, granted: ReadonlySet<string>, profile: ReadonlySet<string>): ScopeClassification {
  if (granted.has(scope)) return { state: 'callable' };
  if (profile.has(scope)) return { state: 'requestable_not_granted' };
  const bundles = scopeIndex().get(scope);
  if (bundles && bundles.length > 0) {
    return {
      state: 'not_requestable',
      reason: 'add_bundle',
      bundle: bundles[0],
      ...(bundles.length > 1 ? { alsoIn: bundles.slice(1) } : {}),
    };
  }
  return { state: 'not_requestable', reason: 'unknown_scope' };
}

const STATE_ORDER: Record<ScopeState, number> = {
  callable: 0,
  requestable_not_granted: 1,
  not_requestable: 2,
};

export interface MethodScopeClassification {
  state: ScopeState;
  /** The alternative that achieved the best state — hint and classification
   * always refer to this SAME scope. */
  scope: string;
  classification: ScopeClassification;
}

/**
 * Discovery `method.scopes` is an ANY-OF list: holding any ONE listed scope
 * authorizes the call. The method's state is therefore the BEST state among
 * the alternatives (a catalog-unknown alternative like chat.bot must never
 * mask a requestable one), and the remediation targets the cheapest fix.
 */
export function classifyMethodScopes(
  alternatives: readonly string[],
  granted: ReadonlySet<string>,
  profile: ReadonlySet<string>,
): MethodScopeClassification | null {
  let best: MethodScopeClassification | null = null;
  for (const scope of alternatives) {
    const c = classifyScope(scope, granted, profile);
    if (!best || STATE_ORDER[c.state] < STATE_ORDER[best.classification.state]) {
      best = { state: c.state, scope, classification: c };
    }
    if (best.state === 'callable') break;
  }
  return best;
}

/**
 * gh-CLI-style copy-pasteable remediation. Never promises a delta-only consent
 * screen (Google re-lists everything at re-consent).
 */
export function scopeHint(scope: string, c: ScopeClassification, alias: string): { hint: string; retriable: boolean } {
  switch (c.state) {
    case 'requestable_not_granted':
      return {
        hint:
          `Scope ${scope} is in ${alias}'s profile but not granted (you unchecked it at consent). ` +
          `Re-grant: npx mcp-google-multi auth --account ${alias}`,
        retriable: true,
      };
    case 'not_requestable':
      if (c.reason === 'add_bundle') {
        // "base" is a pseudo-bundle (BASE_SCOPES excluded by includesBase:
        // false), NOT a catalog key — telling users to add it to bundles[]
        // would fail boot with E_UNKNOWN_BUNDLE.
        if (c.bundle === 'base') {
          return {
            hint:
              `Scope ${scope} is a base scope excluded by "includesBase": false in ${alias}'s profile. ` +
              `Set includesBase back to true (or remove it) in config.json, then npx mcp-google-multi auth --account ${alias}`,
            retriable: false,
          };
        }
        return {
          hint:
            `Scope ${scope} needs the "${c.bundle}" bundle, which is not in ${alias}'s profile. ` +
            `Add it: set ${alias}'s profile bundles to include "${c.bundle}" in config.json, then npx mcp-google-multi auth --account ${alias}`,
          retriable: false,
        };
      }
      if (c.reason === 'account_type') {
        return {
          hint: `Scope ${scope} requires a Google Workspace account; ${alias} is a personal account and will 403. Use a Workspace alias. Do not retry.`,
          retriable: false,
        };
      }
      return {
        hint: `Scope ${scope} is not offered by this server (no bundle grants it). Not requestable. Do not retry.`,
        retriable: false,
      };
    default:
      return { hint: '', retriable: true };
  }
}

export interface AccountScopeSets {
  granted: Set<string>;
  profile: Set<string>;
}

/** Best-effort per-account sets; null when the token/profile is unreadable
 * (decrypt error, missing token) — callers fall back to generic hints. */
export function accountScopeSets(
  alias: string,
  deps: { readTokenFn?: typeof readToken; profileFn?: typeof resolveScopesForAccount } = {},
): AccountScopeSets | null {
  try {
    const token = (deps.readTokenFn ?? readToken)(alias);
    const granted = new Set(typeof token?.scope === 'string' ? token.scope.split(' ').filter(Boolean) : []);
    const profile = new Set((deps.profileFn ?? resolveScopesForAccount)(alias));
    return { granted, profile };
  } catch {
    return null;
  }
}

/**
 * Runtime enrichment for a scope 403 on a method whose required scopes are
 * known (escape hatch: runtime Discovery; generated tools: baked). The
 * account_type refinement lives here: a 403 on an admin scope that IS in the
 * profile means Google refuses it for this account type (personal Gmail),
 * so re-auth would loop — report the dead end instead.
 */
export function scopeHintForMethod(
  required: readonly string[],
  alias: string,
  deps: Parameters<typeof accountScopeSets>[1] = {},
): { hint: string; retriable: boolean } | null {
  const sets = accountScopeSets(alias, deps);
  if (!sets || required.length === 0) return null;
  const best = classifyMethodScopes(required, sets.granted, sets.profile);
  if (!best || best.state === 'callable') return null; // 403 despite grants: not a scope-classification problem
  const base = scopeHint(best.scope, best.classification, alias);
  // Hedged, never fabricated: an in-profile admin scope that 403s is EITHER a
  // Workspace account needing re-auth OR a personal account that can never be
  // granted admin — the inputs cannot distinguish, so say both.
  if (best.state === 'requestable_not_granted' && ADMIN_SCOPES.includes(best.scope)) {
    return {
      hint:
        `${base.hint} Note: personal (non-Workspace) accounts can never grant admin scopes — if ${alias} is a personal Gmail account, use a Workspace alias instead.`,
      retriable: true,
    };
  }
  return base;
}

export interface ScopesReport {
  configured: number;
  granted: number;
  callable: string[];
  requestable: string[];
  notRequestable: {
    addBundle: { scope: string; bundle: string }[];
    /** Runtime-signal bucket: static classification cannot prove account
     * type; doctor (B9) fills it from observed persistent admin 403s. */
    accountType: string[];
    unknown: string[];
  };
  missing: string[];
}

/**
 * The account_list / doctor block. Universe = profile ∪ granted ∪ the scopes
 * required by REGISTERED tools ("registered but not requestable" is the
 * original #114 ask).
 */
export function buildScopesReport(
  granted: ReadonlySet<string>,
  profile: ReadonlySet<string>,
  registeredScopes: Iterable<string> = [],
): ScopesReport {
  const callable: string[] = [];
  const requestable: string[] = [];
  const addBundle: { scope: string; bundle: string }[] = [];
  const accountType: string[] = [];
  const unknown: string[] = [];

  const universe = new Set<string>([...profile, ...granted, ...registeredScopes]);
  for (const scope of [...universe].sort()) {
    const c = classifyScope(scope, granted, profile);
    // Spec-exact: callable = granted ∩ profile (a granted scope the profile
    // dropped is not reported as callable capacity).
    if (c.state === 'callable') {
      if (profile.has(scope)) callable.push(scope);
      continue;
    }
    if (c.state === 'requestable_not_granted') requestable.push(scope);
    else if (c.reason === 'add_bundle') addBundle.push({ scope, bundle: c.bundle! });
    else if (c.reason === 'account_type') accountType.push(scope);
    else unknown.push(scope);
  }

  return {
    configured: profile.size,
    granted: granted.size,
    callable,
    requestable,
    notRequestable: { addBundle, accountType, unknown },
    missing: [...requestable, ...addBundle.map((e) => e.scope), ...accountType, ...unknown],
  };
}

export function clearScopeIndexForTest(): void {
  reverseIndex = null;
}
