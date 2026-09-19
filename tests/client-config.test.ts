import { describe, it, expect } from 'vitest';
import {
  detectClients,
  buildServerEntry,
  claudeCodeCommand,
  renderInstruction,
  applyFileEntry,
  resolveMode,
  DEFAULT_SERVER_NAME,
  type ClientDeps,
  type ClientInfo,
} from '../src/client-config.js';

function fakeFs(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const deps: ClientDeps = {
    homedir: '/home/u',
    platform: 'linux',
    env: {},
    fileExists: (p) => files.has(p),
    readFile: (p) => {
      const v = files.get(p);
      if (v === undefined) throw new Error(`ENOENT ${p}`);
      return v;
    },
    writeFile: (p, d) => {
      files.set(p, d);
    },
    mkdirp: () => {},
  };
  return { deps, files };
}

const fileClient = (configPath: string): ClientInfo => ({
  id: 'cursor',
  label: 'Cursor',
  managed: 'file',
  configPath,
  present: true,
});

describe('detectClients', () => {
  it('resolves OS-specific desktop paths', () => {
    const linux = detectClients({ homedir: '/home/u', platform: 'linux', fileExists: () => false });
    expect(linux.find((c) => c.id === 'claude-desktop')!.configPath).toBe(
      '/home/u/.config/Claude/claude_desktop_config.json',
    );
    const mac = detectClients({ homedir: '/Users/u', platform: 'darwin', fileExists: () => false });
    expect(mac.find((c) => c.id === 'claude-desktop')!.configPath).toBe(
      '/Users/u/Library/Application Support/Claude/claude_desktop_config.json',
    );
    // win32 target must use backslash separators regardless of the host runner.
    const win = detectClients({ homedir: 'C:\\u', platform: 'win32', env: { APPDATA: 'C:\\u\\AppData\\Roaming' }, fileExists: () => false });
    expect(win.find((c) => c.id === 'claude-desktop')!.configPath).toBe('C:\\u\\AppData\\Roaming\\Claude\\claude_desktop_config.json');
    expect(win.find((c) => c.id === 'cursor')!.configPath).toBe('C:\\u\\.cursor\\mcp.json');
  });

  it('marks a client present when its config file or dir exists', () => {
    const clients = detectClients({
      homedir: '/home/u',
      platform: 'linux',
      fileExists: (p) => p === '/home/u/.cursor/mcp.json',
    });
    expect(clients.find((c) => c.id === 'cursor')!.present).toBe(true);
    expect(clients.find((c) => c.id === 'claude-desktop')!.present).toBe(false);
  });

  it('classifies Claude Code as cli-managed, others as file', () => {
    const clients = detectClients({ fileExists: () => false });
    expect(clients.find((c) => c.id === 'claude-code')!.managed).toBe('cli');
    expect(clients.find((c) => c.id === 'claude-desktop')!.managed).toBe('file');
    expect(clients.find((c) => c.id === 'cursor')!.managed).toBe('file');
  });
});

describe('buildServerEntry / claudeCodeCommand', () => {
  it('stdio default is npx, no secret env', () => {
    const e = buildServerEntry({ mode: 'stdio' });
    expect(e).toEqual({ command: 'npx', args: ['-y', 'mcp-google-multi'] });
    expect(JSON.stringify(e)).not.toMatch(/MASTER_KEY|CLIENT_SECRET|env/i);
  });

  it('http entry is a bare url and requires resourceUri', () => {
    expect(buildServerEntry({ mode: 'http', resourceUri: 'https://mcp.example.com/mcp' })).toEqual({
      url: 'https://mcp.example.com/mcp',
    });
    expect(() => buildServerEntry({ mode: 'http' })).toThrow(/resourceUri/);
  });

  it('claudeCodeCommand renders stdio and http invocations', () => {
    expect(claudeCodeCommand('mcp-google-multi', { command: 'npx', args: ['-y', 'mcp-google-multi'] })).toBe(
      'claude mcp add mcp-google-multi -- npx -y mcp-google-multi',
    );
    expect(claudeCodeCommand('mcp-google-multi', { url: 'https://mcp.example.com/mcp' })).toBe(
      'claude mcp add --transport http mcp-google-multi https://mcp.example.com/mcp',
    );
  });
});

describe('renderInstruction', () => {
  it('cli client → command; file client → snippet + path', () => {
    const cli = renderInstruction(
      { id: 'claude-code', label: 'Claude Code', managed: 'cli', configPath: '/home/u/.claude.json', present: true },
      DEFAULT_SERVER_NAME,
      { command: 'npx', args: ['-y', 'mcp-google-multi'] },
    );
    expect(cli.kind).toBe('cli');
    expect(cli.text).toContain('claude mcp add');

    const file = renderInstruction(fileClient('/home/u/.cursor/mcp.json'), DEFAULT_SERVER_NAME, { command: 'npx', args: ['-y', 'mcp-google-multi'] });
    expect(file.kind).toBe('file');
    expect(file.path).toBe('/home/u/.cursor/mcp.json');
    expect(JSON.parse(file.text)).toEqual({ mcpServers: { 'mcp-google-multi': { command: 'npx', args: ['-y', 'mcp-google-multi'] } } });
  });
});

describe('applyFileEntry', () => {
  const p = '/home/u/.cursor/mcp.json';
  const entry = { command: 'npx', args: ['-y', 'mcp-google-multi'] };

  it('creates a fresh config (added, no backup)', () => {
    const { deps, files } = fakeFs();
    const res = applyFileEntry(fileClient(p), 'mcp-google-multi', entry, deps);
    expect(res).toMatchObject({ ok: true, action: 'added', path: p });
    expect((res as { backup?: string }).backup).toBeUndefined();
    expect(JSON.parse(files.get(p)!)).toEqual({ mcpServers: { 'mcp-google-multi': entry } });
  });

  it('updates in place, preserves other servers + top-level keys, backs up', () => {
    const prior = JSON.stringify({
      theme: 'dark',
      mcpServers: { other: { command: 'foo' }, 'mcp-google-multi': { command: 'old' } },
    });
    const { deps, files } = fakeFs({ [p]: prior });
    const res = applyFileEntry(fileClient(p), 'mcp-google-multi', entry, deps);
    expect(res).toMatchObject({ ok: true, action: 'updated' });
    expect((res as { backup?: string }).backup).toBe(`${p}.bak`);
    expect(files.get(`${p}.bak`)).toBe(prior);
    const written = JSON.parse(files.get(p)!);
    expect(written.theme).toBe('dark');
    expect(written.mcpServers.other).toEqual({ command: 'foo' });
    expect(written.mcpServers['mcp-google-multi']).toEqual(entry);
  });

  it('is idempotent (re-apply yields the same content, still one entry)', () => {
    const { deps, files } = fakeFs();
    applyFileEntry(fileClient(p), 'mcp-google-multi', entry, deps);
    const first = files.get(p);
    applyFileEntry(fileClient(p), 'mcp-google-multi', entry, deps);
    const second = files.get(p);
    expect(second).toBe(first);
    expect(Object.keys(JSON.parse(second!).mcpServers)).toEqual(['mcp-google-multi']);
  });

  it('never clobbers a corrupt existing config (parse_error + snippet, no write)', () => {
    const { deps, files } = fakeFs({ [p]: '{ this is not json' });
    const res = applyFileEntry(fileClient(p), 'mcp-google-multi', entry, deps);
    expect(res.ok).toBe(false);
    expect((res as { reason: string }).reason).toBe('parse_error');
    expect((res as { snippet?: string }).snippet).toContain('mcpServers');
    // the original file is untouched
    expect(files.get(p)).toBe('{ this is not json');
    expect(files.has(`${p}.bak`)).toBe(false);
  });

  it('refuses a non-object JSON root', () => {
    const { deps } = fakeFs({ [p]: '[1,2,3]' });
    const res = applyFileEntry(fileClient(p), 'mcp-google-multi', entry, deps);
    expect(res.ok).toBe(false);
    expect((res as { reason: string }).reason).toBe('parse_error');
  });

  it('reports cli-managed clients as not file-writable', () => {
    const { deps } = fakeFs();
    const res = applyFileEntry(
      { id: 'claude-code', label: 'Claude Code', managed: 'cli', configPath: '/home/u/.claude.json', present: true },
      'mcp-google-multi',
      entry,
      deps,
    );
    expect(res.ok).toBe(false);
    expect((res as { reason: string }).reason).toBe('cli_managed');
  });

  it('written entry inlines no secrets', () => {
    const { deps, files } = fakeFs();
    applyFileEntry(fileClient(p), 'mcp-google-multi', entry, deps);
    expect(files.get(p)).not.toMatch(/MASTER_KEY|CLIENT_SECRET|GOOGLE_CLIENT/);
  });
});

describe('resolveMode', () => {
  it('stdio without http config, http when transport includes http', () => {
    expect(resolveMode()).toEqual({ mode: 'stdio' });
    expect(resolveMode({ transport: 'stdio', resourceUri: 'x' })).toEqual({ mode: 'stdio' });
    expect(resolveMode({ transport: 'http', resourceUri: 'https://m/mcp' })).toEqual({ mode: 'http', resourceUri: 'https://m/mcp' });
    expect(resolveMode({ transport: 'both', resourceUri: 'https://m/mcp' })).toEqual({ mode: 'http', resourceUri: 'https://m/mcp' });
  });
});
