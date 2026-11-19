// Optional host-supplied remediation hints: facts only, never pre-rendered
// text, so a host can word a case however its audience needs. See docs/internals.md.
import type { DenyReason, Policy } from './write-control.js';

export type HintCase =
  | { kind: 'reauth'; account: string }
  | { kind: 'legacy_plaintext_token'; account: string }
  | { kind: 'dead_refresh_token'; account: string }
  | { kind: 'token_unreadable'; account: string }
  | { kind: 'scopes_missing'; account: string }
  | { kind: 'scope_not_granted'; account: string; scope: string }
  | { kind: 'scope_needs_bundle'; account: string; scope: string; bundle: string }
  | { kind: 'scope_base_excluded'; account: string; scope: string }
  | { kind: 'scope_account_type'; account: string; scope: string }
  | { kind: 'scope_unknown_scope'; scope: string }
  | { kind: 'scope_unknown'; account: string; serviceText?: string; bundle?: string }
  | { kind: 'write_denied'; tool: { name: string; service: string; cud: string }; reason: DenyReason; policy: Policy }
  | { kind: 'policy_summary'; policy: Policy }
  | { kind: 'outbound_denied'; what: string; blocked: string[]; entries: string[] }
  | { kind: 'no_default_account'; accounts: { alias: string; email: string }[] }
  | { kind: 'no_accounts' }
  | { kind: 'api_not_enabled'; api?: string; service?: string; project?: string; googleMessage: string }
  | { kind: 'apis_disabled'; services: { service: string; api: string }[] }
  | { kind: 'daily_quota' }
  | { kind: 'project_suspended'; account: string }
  | { kind: 'invalid_scope'; account: string }
  | { kind: 'no_oauth_client' }
  | { kind: 'network_error'; code: string }
  | { kind: 'local_path'; code: string; path?: string }
  | { kind: 'host_files'; tool: string; key: string }
  | { kind: 'internal'; account?: string }
  | { kind: 'untrusted_host' }
  | { kind: 'toolset_disabled'; api: string; service: string }
  | {
      kind: 'service_not_enabled';
      tool: string;
      service: string;
      bundle?: string;
      aliases: string[];
      admin: boolean;
      toolsetOff: boolean;
      awaitingRestart: boolean;
    }
  | { kind: 'operator_only'; slug: string };

// A plain array literal, not derived from the union, so a missing member is
// caught by the completeness check below rather than silently compiling.
export const HINT_KINDS = [
  'reauth',
  'legacy_plaintext_token',
  'dead_refresh_token',
  'token_unreadable',
  'scopes_missing',
  'scope_not_granted',
  'scope_needs_bundle',
  'scope_base_excluded',
  'scope_account_type',
  'scope_unknown_scope',
  'scope_unknown',
  'write_denied',
  'policy_summary',
  'outbound_denied',
  'no_default_account',
  'no_accounts',
  'api_not_enabled',
  'apis_disabled',
  'daily_quota',
  'project_suspended',
  'invalid_scope',
  'no_oauth_client',
  'network_error',
  'local_path',
  'host_files',
  'internal',
  'untrusted_host',
  'toolset_disabled',
  'service_not_enabled',
  'operator_only',
] as const satisfies readonly HintCase['kind'][];

// Compile-time completeness check: `satisfies` above only checks every listed
// kind is valid, not that every valid kind is listed; this closes that gap.
type _MissingFromHintKinds = Exclude<HintCase['kind'], (typeof HINT_KINDS)[number]>;
type _AssertHintKindsComplete = _MissingFromHintKinds extends never ? true : ['HINT_KINDS is missing', _MissingFromHintKinds];
const _hintKindsComplete: _AssertHintKindsComplete = true;
void _hintKindsComplete;

/** `message` only for the kinds whose message leaks today (write_denied,
 * no_oauth_client, local_path, internal, toolset_disabled); every other call
 * site ignores it. `retriable` only where it may legitimately differ from
 * the owner's default (scope_not_granted). */
export interface Rendered {
  hint: string;
  message?: string;
  retriable?: boolean;
}

export interface HintProvider {
  render(c: HintCase): Rendered;
}

// Process-global, like the HTTP reauth linker: one process is either the
// single owner or one multi-tenant host, never both.
let installed: HintProvider | null = null;

export function setHintProvider(p: HintProvider | null): void {
  installed = p;
}

// A throwing provider must never take down the call site: it falls back to
// the same literal a missing provider would, never leaking its own error text.
export function hints(): HintProvider | null {
  if (!installed) return null;
  const provider = installed;
  return {
    render(c: HintCase): Rendered {
      try {
        return provider.render(c);
      } catch {
        return undefined as unknown as Rendered;
      }
    },
  };
}
