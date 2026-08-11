import { describe, it, expect } from 'vitest';
import {
  canonicalizePublicUrl,
  resolveTransport,
  transportIncludesHttp,
  resolveHttpConfig,
  HttpConfigError,
  CLAUDE_AI_ORIGIN,
} from '../src/http-config.js';

describe('resolveTransport', () => {
  it('defaults to stdio when unset or blank', () => {
    expect(resolveTransport({})).toBe('stdio');
    expect(resolveTransport({ MCP_TRANSPORT: '' })).toBe('stdio');
    expect(resolveTransport({ MCP_TRANSPORT: '   ' })).toBe('stdio');
  });

  it('accepts stdio|http|both, case-insensitive and trimmed', () => {
    expect(resolveTransport({ MCP_TRANSPORT: 'stdio' })).toBe('stdio');
    expect(resolveTransport({ MCP_TRANSPORT: 'HTTP' })).toBe('http');
    expect(resolveTransport({ MCP_TRANSPORT: '  Both ' })).toBe('both');
  });

  it('fails fast on an unknown value rather than silently downgrading', () => {
    expect(() => resolveTransport({ MCP_TRANSPORT: 'sse' })).toThrow(HttpConfigError);
    try {
      resolveTransport({ MCP_TRANSPORT: 'sse' });
    } catch (e) {
      expect((e as HttpConfigError).slug).toBe('E_INVALID_TRANSPORT');
    }
  });

  it('transportIncludesHttp is true only for http/both', () => {
    expect(transportIncludesHttp('stdio')).toBe(false);
    expect(transportIncludesHttp('http')).toBe(true);
    expect(transportIncludesHttp('both')).toBe(true);
  });
});

describe('canonicalizePublicUrl (BR4)', () => {
  it('strips a trailing slash', () => {
    expect(canonicalizePublicUrl('https://mcp.example.com/')).toBe('https://mcp.example.com');
    expect(canonicalizePublicUrl('https://mcp.example.com///')).toBe('https://mcp.example.com');
  });

  it('drops the default port for the scheme', () => {
    expect(canonicalizePublicUrl('https://mcp.example.com:443')).toBe('https://mcp.example.com');
    expect(canonicalizePublicUrl('http://mcp.example.com:80')).toBe('http://mcp.example.com');
  });

  it('keeps a non-default port', () => {
    expect(canonicalizePublicUrl('http://127.0.0.1:4243')).toBe('http://127.0.0.1:4243');
    expect(canonicalizePublicUrl('https://mcp.example.com:8443')).toBe('https://mcp.example.com:8443');
  });

  it('lowercases scheme and host', () => {
    expect(canonicalizePublicUrl('HTTPS://MCP.EXAMPLE.COM')).toBe('https://mcp.example.com');
  });

  it('strips fragment, query, and userinfo', () => {
    expect(canonicalizePublicUrl('https://mcp.example.com/#frag')).toBe('https://mcp.example.com');
    expect(canonicalizePublicUrl('https://mcp.example.com/?a=1')).toBe('https://mcp.example.com');
    expect(canonicalizePublicUrl('https://user:pass@mcp.example.com')).toBe('https://mcp.example.com');
  });

  it('preserves a non-root path but strips its trailing slash (case-sensitive path)', () => {
    expect(canonicalizePublicUrl('https://mcp.example.com/Base/')).toBe('https://mcp.example.com/Base');
  });

  it('rejects a non-absolute or non-http(s) URL', () => {
    for (const bad of ['not a url', 'ftp://x.com', 'ws://x.com', '/mcp', 'mcp.example.com']) {
      expect(() => canonicalizePublicUrl(bad)).toThrow(HttpConfigError);
    }
    try {
      canonicalizePublicUrl('ftp://x.com');
    } catch (e) {
      expect((e as HttpConfigError).slug).toBe('E_PUBLIC_URL_INVALID');
    }
  });

  it('is idempotent: the canonical form re-canonicalizes to itself', () => {
    const c = canonicalizePublicUrl('https://mcp.example.com/');
    expect(canonicalizePublicUrl(c)).toBe(c);
  });

  it('NEGATIVE TEST: trailing-slash / default-port / wrong-case all collapse to ONE URI (the 401-loop guard)', () => {
    const variants = [
      'https://mcp.example.com',
      'https://mcp.example.com/',
      'https://mcp.example.com:443',
      'https://mcp.example.com:443/',
      'HTTPS://MCP.Example.com/',
      'https://mcp.example.com/#x',
    ];
    const canon = variants.map(canonicalizePublicUrl);
    expect(new Set(canon).size).toBe(1);
    expect(canon[0]).toBe('https://mcp.example.com');
  });
});

describe('resolveHttpConfig', () => {
  it('stdio defaults: loopback bind, port 4243, loopback public URL', () => {
    const c = resolveHttpConfig({});
    expect(c.transport).toBe('stdio');
    expect(c.host).toBe('127.0.0.1');
    expect(c.port).toBe(4243);
    expect(c.publicUrl).toBe('http://127.0.0.1:4243');
    expect(c.resourceUri).toBe('http://127.0.0.1:4243/mcp');
  });

  it('derives allowlists behind a tunnel from MCP_PUBLIC_URL', () => {
    const c = resolveHttpConfig({
      MCP_TRANSPORT: 'http',
      MCP_HTTP_HOST: '127.0.0.1',
      MCP_HTTP_PORT: '4243',
      MCP_PUBLIC_URL: 'https://mcp.example.com/',
    });
    expect(c.publicUrl).toBe('https://mcp.example.com');
    expect(c.resourceUri).toBe('https://mcp.example.com/mcp');
    expect(c.allowedHosts).toContain('mcp.example.com');
    expect(c.allowedHosts).toContain('127.0.0.1');
    expect(c.allowedHosts).toContain('127.0.0.1:4243');
    expect(c.allowedOrigins).toContain('https://mcp.example.com');
    expect(c.allowedOrigins).toContain(CLAUDE_AI_ORIGIN);
  });

  it('always includes claude.ai in the Origin allowlist and appends MCP_ALLOWED_ORIGINS', () => {
    const c = resolveHttpConfig({
      MCP_TRANSPORT: 'http',
      MCP_PUBLIC_URL: 'https://mcp.example.com',
      MCP_ALLOWED_ORIGINS: 'https://foo.example, https://bar.example:8443',
    });
    expect(c.allowedOrigins).toEqual(
      expect.arrayContaining([
        'https://mcp.example.com',
        CLAUDE_AI_ORIGIN,
        'https://foo.example',
        'https://bar.example:8443',
      ]),
    );
  });

  it('dedupes allowed hosts for a default-port public URL', () => {
    const c = resolveHttpConfig({
      MCP_TRANSPORT: 'http',
      MCP_HTTP_HOST: 'mcp.example.com',
      MCP_HTTP_PORT: '443',
      MCP_PUBLIC_URL: 'https://mcp.example.com',
    });
    // no duplicate entries
    expect(new Set(c.allowedHosts).size).toBe(c.allowedHosts.length);
    expect(c.allowedHosts).toContain('mcp.example.com');
  });

  it('brackets an IPv6 bind host in the default public URL and host allowlist', () => {
    const c = resolveHttpConfig({ MCP_TRANSPORT: 'http', MCP_HTTP_HOST: '::1', MCP_HTTP_PORT: '4243' });
    expect(c.publicUrl).toBe('http://[::1]:4243');
    expect(c.resourceUri).toBe('http://[::1]:4243/mcp');
    expect(c.allowedHosts).toContain('[::1]:4243');
    expect(c.allowedHosts).toContain('::1');
  });

  it('rejects a bad port', () => {
    for (const bad of ['0', '70000', 'abc', '-1', '80.5']) {
      expect(() => resolveHttpConfig({ MCP_HTTP_PORT: bad })).toThrow(HttpConfigError);
    }
    try {
      resolveHttpConfig({ MCP_HTTP_PORT: '0' });
    } catch (e) {
      expect((e as HttpConfigError).slug).toBe('E_INVALID_HTTP_PORT');
    }
  });

  it('rejects a bad MCP_ALLOWED_ORIGINS entry', () => {
    expect(() =>
      resolveHttpConfig({ MCP_TRANSPORT: 'http', MCP_PUBLIC_URL: 'https://x.com', MCP_ALLOWED_ORIGINS: 'not a url' }),
    ).toThrow(HttpConfigError);
    try {
      resolveHttpConfig({ MCP_TRANSPORT: 'http', MCP_PUBLIC_URL: 'https://x.com', MCP_ALLOWED_ORIGINS: 'garbage' });
    } catch (e) {
      expect((e as HttpConfigError).slug).toBe('E_INVALID_ORIGIN');
    }
  });
});
