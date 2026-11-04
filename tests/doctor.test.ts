import { describe, it, expect, afterEach } from 'vitest';
import {
  runDiagnostics, overallVerdict, exitCodeFor, apiEnableLink,
  renderReport, renderDoctorText,
  type DiagnosticsDeps, type AccountHealth, type ApiProbeResult, type HttpProbeResult,
} from '../src/doctor.js';
import { setHintProvider, type HintCase } from '../src/hint-provider.js';

function emptyScopes() {
  return { configured: 0, granted: 0, callable: [] as string[], requestable: [] as string[], notRequestable: { addBundle: [], accountType: [], unknown: [] }, missing: [] as string[] };
}

function health(alias: string, over: Partial<AccountHealth> = {}): AccountHealth {
  return {
    alias, email: `${alias}@example.com`, admin: false, source: 'config',
    token: { status: 'ok', expiryDate: '2030-01-01T00:00:00Z' },
    scopes: emptyScopes(),
    ...over,
  } as AccountHealth;
}

function deps(over: Partial<DiagnosticsDeps> = {}): DiagnosticsDeps {
  return {
    nodeVersion: '22.19.0',
    env: {},
    cwd: '/nonexistent-cwd',
    accountSet: () => ({ aliases: ['work'], configs: {}, defaultAccount: undefined } as any),
    accountHealth: (a) => health(a),
    masterKeyProvenance: () => 'file',
    anyTokensExist: () => true,
    fileExists: () => false,
    ...over,
  };
}

describe('maskEmails via renderReport (linear scan)', () => {
  it('masks every address shape the old regex masked', async () => {
    const r = await runDiagnostics(deps({ accountHealth: (a) => health(a, { email: 'someone.long+tag@sub.example.co' }) }));
    const out = renderReport(r, '0.0.0');
    expect(out).toContain('s***@sub.example.co');
    expect(out).not.toContain('someone.long+tag@');
  });

  it('leaves @-runs without a local part or domain alone, and survives a long local-charset run instantly', async () => {
    const r = await runDiagnostics(deps({ accountHealth: (a) => health(a, { email: `${'%'.repeat(20000)}@x.example` }) }));
    const started = performance.now();
    const out = renderReport(r, '0.0.0');
    expect(performance.now() - started).toBeLessThan(1000); // the old regex went polynomial here
    expect(out).toContain('%***@x.example');
  });
});

describe('default account note', () => {
  const config = (r: Awaited<ReturnType<typeof runDiagnostics>>) => r.sections.find((x) => x.title === 'Config')!;

  it('notes a missing default when several accounts are configured, without failing the check', async () => {
    const r = await runDiagnostics(deps({ accountSet: () => ({ aliases: ['a', 'b'], configs: {}, defaultAccount: undefined } as any) }));
    const c = config(r);
    expect(c.lines.some((l) => l.startsWith('No default account'))).toBe(true);
    expect(c.hint).toContain('GOOGLE_DEFAULT_ACCOUNT');
    expect(c.verdict).toBe('ok');
  });

  it('stays quiet with one account or with a default set', async () => {
    const one = await runDiagnostics(deps());
    expect(config(one).lines.some((l) => l.startsWith('No default account'))).toBe(false);
    const set = await runDiagnostics(deps({ accountSet: () => ({ aliases: ['a', 'b'], configs: {}, defaultAccount: 'a' } as any) }));
    expect(config(set).lines.some((l) => l.startsWith('No default account'))).toBe(false);
  });

  it('is not shown in the tenant-scoped report', async () => {
    const t = await runDiagnostics(deps({ accountSet: () => ({ aliases: ['a', 'b'], configs: {}, defaultAccount: undefined } as any) }), { scope: 'tenant' });
    expect(config(t).lines.some((l) => l.startsWith('No default account'))).toBe(false);
  });
});

describe('tenant-scoped diagnose', () => {
  const httpEnv = { MCP_TRANSPORT: 'http', MCP_PUBLIC_URL: 'https://mcp.example.com', MCP_OWNER_EMAILS: 'operator-private@x.example' };

  it('operator default includes sections 3 and 7 (byte-identical to today)', async () => {
    const r = await runDiagnostics(deps({ env: httpEnv }));
    const ids = r.sections.map((s) => s.id);
    expect(ids).toContain(3);
    expect(ids).toContain(7);
  });

  it('tenant scope omits sections 3 and 7 and never contains any MCP_OWNER_EMAILS value', async () => {
    const r = await runDiagnostics(deps({ env: httpEnv }), { scope: 'tenant' });
    const ids = r.sections.map((s) => s.id);
    expect(ids).not.toContain(3);
    expect(ids).not.toContain(7);
    // literal string-search regression guard: the operator's allowlist email
    // must be unfindable anywhere in a tenant-scoped report
    expect(JSON.stringify(r)).not.toContain('operator-private');
  });
});

describe('tenant-scope sections 1, 2 and 6 residue', () => {
  afterEach(() => setHintProvider(null));

  function echo() {
    const seen: HintCase[] = [];
    setHintProvider({
      render: (c) => {
        seen.push(c);
        return { hint: `kind:${c.kind}` };
      },
    });
    return seen;
  }

  it('§1: tenant scope on an old Node carries no version string; operator scope is unchanged (red by mutation: trim in operator scope too)', async () => {
    const tenant = await runDiagnostics(deps({ nodeVersion: '20.11.0' }), { scope: 'tenant' });
    const tenantSection = tenant.sections.find((x) => x.id === 1)!;
    expect(tenantSection.lines).toEqual(['Runtime below the supported version']);
    expect(tenantSection.lines.join(' ')).not.toContain('20.11.0');

    const operator = await runDiagnostics(deps({ nodeVersion: '20.11.0' }));
    const operatorSection = operator.sections.find((x) => x.id === 1)!;
    expect(operatorSection.lines.join(' ')).toContain('20.11.0');
  });

  it('§1: tenant-scope fail hint with no provider names the slug, never the CLI', async () => {
    const r = await runDiagnostics(deps({ nodeVersion: '20.11.0' }), { scope: 'tenant' });
    const s = r.sections.find((x) => x.id === 1)!;
    expect(s.hint).toBe('Tell the server operator the code E_NODE_TOO_OLD.');
  });

  it('§1: a provider renders operator_only with the slug', async () => {
    const seen = echo();
    const r = await runDiagnostics(deps({ nodeVersion: '20.11.0' }), { scope: 'tenant' });
    const s = r.sections.find((x) => x.id === 1)!;
    expect(s.hint).toBe('kind:operator_only');
    expect(seen).toEqual([{ kind: 'operator_only', slug: 'E_NODE_TOO_OLD' }]);
  });

  it('§1: a throwing provider falls back to the no-provider hint (red by mutation: drop the catch in hints())', async () => {
    setHintProvider({
      render: () => {
        throw new Error('provider blew up');
      },
    });
    const r = await runDiagnostics(deps({ nodeVersion: '20.11.0' }), { scope: 'tenant' });
    const s = r.sections.find((x) => x.id === 1)!;
    expect(s.hint).toBe('Tell the server operator the code E_NODE_TOO_OLD.');
  });

  it('§1: a provider is never consulted in operator scope (no HintCase rendered)', async () => {
    const seen = echo();
    await runDiagnostics(deps({ nodeVersion: '20.11.0' }));
    expect(seen).toEqual([]);
  });

  it('§2: tenant scope with no accounts carries no hint by default (unchanged: no original exists)', async () => {
    const r = await runDiagnostics(deps({ accountSet: () => null }), { scope: 'tenant' });
    const s = r.sections.find((x) => x.id === 2)!;
    expect(s.hint).toBeUndefined();
  });

  it('§2: a provider renders no_accounts in tenant scope', async () => {
    const seen = echo();
    const r = await runDiagnostics(deps({ accountSet: () => null }), { scope: 'tenant' });
    const s = r.sections.find((x) => x.id === 2)!;
    expect(s.hint).toBe('kind:no_accounts');
    expect(seen).toEqual([{ kind: 'no_accounts' }]);
  });

  it('§6: tenant scope drops the raw probe error text; operator scope keeps it', async () => {
    const probeApi = async (): Promise<ApiProbeResult[]> => { throw new Error('connect ETIMEDOUT 10.0.0.1:443 via corp-proxy.internal'); };
    const tenant = await runDiagnostics(deps({ probeApi }), { scope: 'tenant' });
    const tenantSection = tenant.sections.find((x) => x.id === 6)!;
    expect(tenantSection.lines).toEqual(['Probe could not complete.']);
    expect(JSON.stringify(tenantSection)).not.toContain('corp-proxy.internal');

    const operator = await runDiagnostics(deps({ probeApi }));
    const operatorSection = operator.sections.find((x) => x.id === 6)!;
    expect(operatorSection.lines.join(' ')).toContain('corp-proxy.internal');
  });

  it('§6: a provider renders apis_disabled with the full disabled-service list, in both scopes', async () => {
    const probeApi = async (): Promise<ApiProbeResult[]> => [
      { service: 'gmail', api: 'gmail', ok: true },
      { service: 'drive', api: 'drive', ok: false, notEnabled: true },
    ];
    for (const opts of [{ scope: 'tenant' as const }, undefined]) {
      const seen = echo();
      const r = await runDiagnostics(deps({ probeApi }), opts);
      const s = r.sections.find((x) => x.id === 6)!;
      expect(s.hint).toBe('kind:apis_disabled');
      expect(seen).toEqual([{ kind: 'apis_disabled', services: [{ service: 'drive', api: 'drive' }] }]);
    }
  });
});

describe('runDiagnostics sections', () => {
  it('§1 Runtime fails on old Node', async () => {
    const r = await runDiagnostics(deps({ nodeVersion: '20.11.0' }));
    const s = r.sections.find((x) => x.id === 1)!;
    expect(s.verdict).toBe('fail');
    expect(s.slug).toBe('E_NODE_TOO_OLD');
  });

  it('§1 Runtime ok on Node 22', async () => {
    const r = await runDiagnostics(deps());
    expect(r.sections.find((x) => x.id === 1)!.verdict).toBe('ok');
  });

  it('§2 Config fails with no accounts', async () => {
    const r = await runDiagnostics(deps({ accountSet: () => null }));
    const s = r.sections.find((x) => x.id === 2)!;
    expect(s.verdict).toBe('fail');
    expect(s.slug).toBe('E_NO_ACCOUNTS_CONFIGURED');
  });

  it('§2 Config warns on legacy env', async () => {
    const r = await runDiagnostics(deps({ env: { GOOGLE_ACCOUNTS: 'work:x@y.com' } }));
    const s = r.sections.find((x) => x.id === 2)!;
    expect(s.verdict).toBe('warn');
    expect(s.hint).toMatch(/migrate-config/);
  });

  it('§3 Keys fails when unprovisioned but tokens exist (brick)', async () => {
    const r = await runDiagnostics(deps({ masterKeyProvenance: () => 'unprovisioned', anyTokensExist: () => true }));
    const s = r.sections.find((x) => x.id === 3)!;
    expect(s.verdict).toBe('fail');
    expect(s.slug).toBe('E_MASTER_KEY_MISSING_TOKENS_EXIST');
  });

  it('§3 Keys ok with a provenance and no tokens', async () => {
    const r = await runDiagnostics(deps({ masterKeyProvenance: () => 'keychain', anyTokensExist: () => false }));
    expect(r.sections.find((x) => x.id === 3)!.verdict).toBe('ok');
  });

  it('§4 Tokens fails on needs_reauth', async () => {
    const r = await runDiagnostics(deps({ accountHealth: (a) => health(a, { token: { status: 'needs_reauth', hint: 'run auth' } }) }));
    const s = r.sections.find((x) => x.id === 4)!;
    expect(s.verdict).toBe('fail');
    expect(s.hint).toBe('run auth');
  });

  it('§5 Scopes warns when scopes are requested-not-granted', async () => {
    const scopes = { ...emptyScopes(), callable: ['a'], requestable: ['https://scope/x'] };
    const r = await runDiagnostics(deps({ accountHealth: (a) => health(a, { scopes }) }));
    const s = r.sections.find((x) => x.id === 5)!;
    expect(s.verdict).toBe('warn');
    expect(s.slug).toBe('E_SCOPE_NOT_GRANTED');
  });

  it('§5: a provider renders scopes_missing with the account', async () => {
    const seen: HintCase[] = [];
    setHintProvider({ render: (c) => { seen.push(c); return { hint: `kind:${c.kind}` }; } });
    try {
      const scopes = { ...emptyScopes(), callable: ['a'], requestable: ['https://scope/x'] };
      const r = await runDiagnostics(deps({ accountHealth: (a) => health(a, { scopes }) }));
      const s = r.sections.find((x) => x.id === 5)!;
      expect(s.hint).toBe('kind:scopes_missing');
      expect(seen).toEqual([{ kind: 'scopes_missing', account: 'work' }]);
    } finally {
      setHintProvider(null);
    }
  });

  it('§6 API enablement is unknown without a probe', async () => {
    const r = await runDiagnostics(deps());
    expect(r.sections.find((x) => x.id === 6)!.verdict).toBe('unknown');
  });

  it('§6 fails with a per-API deep-link when a service is not enabled', async () => {
    const probeApi = async (): Promise<ApiProbeResult[]> => [
      { service: 'gmail', api: 'gmail', ok: true },
      { service: 'drive', api: 'drive', ok: false, notEnabled: true },
    ];
    const r = await runDiagnostics(deps({ probeApi }));
    const s = r.sections.find((x) => x.id === 6)!;
    expect(s.verdict).toBe('fail');
    expect(s.slug).toBe('E_API_NOT_ENABLED');
    expect(s.hint).toContain(apiEnableLink('drive'));
  });

  it('§6 downgrades a probe throw to WARN, never crashes', async () => {
    const probeApi = async (): Promise<ApiProbeResult[]> => { throw new Error('offline'); };
    const r = await runDiagnostics(deps({ probeApi }));
    expect(r.sections.find((x) => x.id === 6)!.verdict).toBe('warn');
  });

  it('§6 reports unknown when the probe finds nothing probeable (no matching grants)', async () => {
    const probeApi = async (): Promise<ApiProbeResult[]> => [];
    const r = await runDiagnostics(deps({ probeApi }));
    const s = r.sections.find((x) => x.id === 6)!;
    expect(s.verdict).toBe('unknown');
    expect(s.lines[0]).toContain('No probeable');
  });

  it('§7 HTTP appears for http/both transports; an invalid MCP_TRANSPORT fails it (not silently unknown)', async () => {
    const withHttp = await runDiagnostics(deps({ env: { MCP_TRANSPORT: 'both', MCP_OWNER_EMAILS: 'work@example.com' } }));
    expect(withHttp.sections.find((x) => x.id === 7)?.verdict).toBe('ok');
    const invalid = await runDiagnostics(deps({ env: { MCP_TRANSPORT: 'stdio,http' } }));
    expect(invalid.sections.find((x) => x.id === 7)?.slug).toBe('E_INVALID_TRANSPORT');
    const stdio = await runDiagnostics(deps());
    expect(stdio.sections.find((x) => x.id === 7)).toBeUndefined();
  });
});

describe('verdict + exit code', () => {
  it('unknown never worsens the overall verdict', () => {
    expect(overallVerdict([{ id: 1, title: '', verdict: 'ok', lines: [] }, { id: 6, title: '', verdict: 'unknown', lines: [] }])).toBe('ok');
  });
  it('fail dominates', () => {
    expect(overallVerdict([{ id: 1, title: '', verdict: 'warn', lines: [] }, { id: 2, title: '', verdict: 'fail', lines: [] }])).toBe('fail');
  });
  it('exit code: fail→1, warn+strict→1, warn→0, ok→0', () => {
    expect(exitCodeFor({ verdict: 'fail', sections: [] }, false)).toBe(1);
    expect(exitCodeFor({ verdict: 'warn', sections: [] }, true)).toBe(1);
    expect(exitCodeFor({ verdict: 'warn', sections: [] }, false)).toBe(0);
    expect(exitCodeFor({ verdict: 'ok', sections: [] }, false)).toBe(0);
  });
});

describe('renderers', () => {
  it('renderReport masks email local-parts', () => {
    const report = { verdict: 'ok' as const, sections: [{ id: 4, title: 'Tokens', verdict: 'ok' as const, lines: ['work (alice@acme.example): ok'] }] };
    const out = renderReport(report, '6.0.0');
    expect(out).not.toContain('alice@acme.example');
    expect(out).toContain('a***@acme.example');
  });
  it('renderDoctorText shows an overall line and glyphs', () => {
    const report = { verdict: 'fail' as const, sections: [{ id: 1, title: 'Runtime', verdict: 'fail' as const, lines: ['Node 20'], hint: 'upgrade' }] };
    const out = renderDoctorText(report);
    expect(out).toContain('Overall: FAIL');
    expect(out).toContain('→ upgrade');
  });
});

describe('§7 HTTP', () => {
  const httpEnv = { MCP_TRANSPORT: 'http', MCP_OWNER_EMAILS: 'work@example.com' };

  it('is absent entirely on stdio-only transport', async () => {
    const r = await runDiagnostics(deps());
    expect(r.sections.find((x) => x.id === 7)).toBeUndefined();
  });

  it('fails on an invalid MCP_PUBLIC_URL with the config slug', async () => {
    const r = await runDiagnostics(deps({ env: { ...httpEnv, MCP_PUBLIC_URL: 'not a url' } }));
    const s = r.sections.find((x) => x.id === 7)!;
    expect(s.verdict).toBe('fail');
    expect(s.slug).toBe('E_PUBLIC_URL_INVALID');
  });

  it('fails when MCP_OWNER_EMAILS is empty', async () => {
    const r = await runDiagnostics(deps({ env: { MCP_TRANSPORT: 'http' } }));
    const s = r.sections.find((x) => x.id === 7)!;
    expect(s.verdict).toBe('fail');
    expect(s.slug).toBe('E_OWNER_EMAILS_REQUIRED');
  });

  it('warns when an owner email matches no configured account', async () => {
    const r = await runDiagnostics(deps({ env: { ...httpEnv, MCP_OWNER_EMAILS: 'stranger@example.com' } }));
    const s = r.sections.find((x) => x.id === 7)!;
    expect(s.verdict).toBe('warn');
    expect(s.slug).toBe('W_OWNER_EMAIL_UNKNOWN');
  });

  it('reports unknown (never a fail, never worsening overall) when the live probe cannot reach the server', async () => {
    const probeHttp = async (): Promise<HttpProbeResult> => ({ ok: false, unreachable: true });
    const r = await runDiagnostics(deps({ env: httpEnv, probeHttp }));
    const s = r.sections.find((x) => x.id === 7)!;
    expect(s.verdict).toBe('unknown');
    expect(s.lines.join(' ')).toContain('not reachable');
  });

  it('fails on a metadata mismatch from a reachable server', async () => {
    const probeHttp = async (): Promise<HttpProbeResult> => ({ ok: false, problem: 'PRM resource "http://other/mcp" does not match' });
    const r = await runDiagnostics(deps({ env: httpEnv, probeHttp }));
    const s = r.sections.find((x) => x.id === 7)!;
    expect(s.verdict).toBe('fail');
    expect(s.slug).toBe('E_HTTP_METADATA_MISMATCH');
  });

  it('is ok end-to-end with matching owners and a green probe', async () => {
    const probeHttp = async (): Promise<HttpProbeResult> => ({ ok: true });
    const r = await runDiagnostics(deps({ env: httpEnv, probeHttp }));
    const s = r.sections.find((x) => x.id === 7)!;
    expect(s.verdict).toBe('ok');
    expect(s.lines.join(' ')).toContain('PRM + AS metadata verified');
  });
});

describe('§5 Scopes: registered tools the account cannot call', () => {
  const summary = {
    total: 10, callable: 6, requestableNotGranted: 1,
    byBundle: [{ bundle: 'slides', tools: 3 }], neverRequestable: 0,
  };

  it('adds a per-account tool line and a remediation hint for the operator', async () => {
    const r = await runDiagnostics(deps({ toolScopes: () => summary }));
    const s = r.sections.find((x) => x.id === 5)!;
    expect(s.lines).toContain(
      'work: 6 of 10 tools callable; 1 need re-auth to grant a scope already in the profile; 3 need a bundle not in the profile (slides 3)',
    );
    expect(s.hint).toMatch(/profile bundles/);
    expect(s.verdict).toBe('ok');
  });

  it('keeps the section byte-identical when no tool counts are wired', async () => {
    const r = await runDiagnostics(deps());
    const s = r.sections.find((x) => x.id === 5)!;
    expect(s.lines).toEqual(['work: 0 callable, all profile scopes granted']);
    expect(s.hint).toBeUndefined();
  });

  it('stays out of tenant-scoped reports', async () => {
    const r = await runDiagnostics(deps({ toolScopes: () => summary }), { scope: 'tenant' });
    expect(JSON.stringify(r)).not.toContain('tools callable');
  });

  it('gives a plain line and no hint when every tool is callable', async () => {
    const r = await runDiagnostics(deps({ toolScopes: () => ({ total: 4, callable: 4, requestableNotGranted: 0, byBundle: [], neverRequestable: 0 }) }));
    const s = r.sections.find((x) => x.id === 5)!;
    expect(s.lines).toContain('work: 4 of 4 tools callable');
    expect(s.hint).toBeUndefined();
  });
});
