import { describe, it, expect } from 'vitest';
import {
  runDiagnostics, overallVerdict, exitCodeFor, apiEnableLink,
  renderReport, renderDoctorText,
  type DiagnosticsDeps, type AccountHealth, type ApiProbeResult, type HttpProbeResult,
} from '../src/doctor.js';

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
    accountSet: () => ({ aliases: ['ic'], configs: {}, defaultAccount: undefined } as any),
    accountHealth: (a) => health(a),
    masterKeyProvenance: () => 'file',
    anyTokensExist: () => true,
    fileExists: () => false,
    ...over,
  };
}

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
    const r = await runDiagnostics(deps({ env: { GOOGLE_ACCOUNTS: 'ic:x@y.com' } }));
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
    const withHttp = await runDiagnostics(deps({ env: { MCP_TRANSPORT: 'both', MCP_OWNER_EMAILS: 'ic@example.com' } }));
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
  it('renderReport masks email local-parts (BR8)', () => {
    const report = { verdict: 'ok' as const, sections: [{ id: 4, title: 'Tokens', verdict: 'ok' as const, lines: ['ic (baki@ideacrafters.com): ok'] }] };
    const out = renderReport(report, '6.0.0');
    expect(out).not.toContain('baki@ideacrafters.com');
    expect(out).toContain('b***@ideacrafters.com');
  });
  it('renderDoctorText shows an overall line and glyphs', () => {
    const report = { verdict: 'fail' as const, sections: [{ id: 1, title: 'Runtime', verdict: 'fail' as const, lines: ['Node 20'], hint: 'upgrade' }] };
    const out = renderDoctorText(report);
    expect(out).toContain('Overall: FAIL');
    expect(out).toContain('→ upgrade');
  });
});

describe('§7 HTTP', () => {
  const httpEnv = { MCP_TRANSPORT: 'http', MCP_OWNER_EMAILS: 'ic@example.com' };

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
