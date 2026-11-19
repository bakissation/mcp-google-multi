import { describe, it, expect, afterEach } from 'vitest';
import { HINT_KINDS, setHintProvider, hints, type HintProvider } from '../src/hint-provider.js';

afterEach(() => setHintProvider(null));

describe('HINT_KINDS', () => {
  // The completeness check (every HintCase member present) is a compile-time assertion in
  // src/hint-provider.ts; tsconfig only includes src/, so a check living here would never typecheck.
  it('has no duplicates and matches the exact expected set of kinds', () => {
    expect(HINT_KINDS.length).toBe(new Set(HINT_KINDS).size);
    expect([...HINT_KINDS].sort()).toEqual([
      'api_not_enabled',
      'apis_disabled',
      'daily_quota',
      'dead_refresh_token',
      'host_files',
      'internal',
      'invalid_scope',
      'legacy_plaintext_token',
      'local_path',
      'network_error',
      'no_accounts',
      'no_default_account',
      'no_oauth_client',
      'operator_only',
      'outbound_denied',
      'policy_summary',
      'project_suspended',
      'reauth',
      'scope_account_type',
      'scope_base_excluded',
      'scope_needs_bundle',
      'scope_not_granted',
      'scope_unknown',
      'scope_unknown_scope',
      'scopes_missing',
      'service_not_enabled',
      'token_unreadable',
      'toolset_disabled',
      'untrusted_host',
      'write_denied',
    ]);
  });
});

describe('setHintProvider / hints', () => {
  it("starts null: every call site keeps today's literal", () => {
    expect(hints()).toBeNull();
  });

  it("routes render() through the installed provider, and null restores today's text", () => {
    const stub: HintProvider = { render: (c) => ({ hint: `kind:${c.kind}` }) };
    setHintProvider(stub);
    expect(hints()?.render({ kind: 'no_accounts' })).toEqual({ hint: 'kind:no_accounts' });
    setHintProvider(null);
    expect(hints()).toBeNull();
  });

  it('a throwing provider never propagates: render falls back to the no-provider shape (red by mutation: drop the catch)', () => {
    const thrown: HintProvider = {
      render: () => {
        throw new Error('provider blew up');
      },
    };
    setHintProvider(thrown);
    const rendered = hints()?.render({ kind: 'no_accounts' });
    expect(rendered?.hint).toBeUndefined();
    // the call site's `rendered?.hint ?? <default>` sees the same undefined
    // it would see with no provider installed at all
    expect(rendered?.hint ?? 'default').toBe('default');
  });
});
