// B15: after the setup wizard finalizes an account, offer to register the
// server with the user's MCP client so they never hand-edit JSON. Pure core
// (detection + entry building + idempotent apply), deps-injectable for tests.
// Consent + non-TTY behavior live in the CLI/tool surfaces; secrets are NEVER
// inlined — the server self-loads its .env from ~/.config/mcp-google-multi, so
// a stdio entry needs no secret env at all (distribution.md B15).

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import * as readline from 'node:readline';
import path from 'node:path';
import { homedir } from 'node:os';

export type ClientId = 'claude-code' | 'claude-desktop' | 'cursor';
export type Mode = 'stdio' | 'http';

export const DEFAULT_SERVER_NAME = 'mcp-google-multi';

export interface ClientInfo {
  id: ClientId;
  label: string;
  /** `cli` = registered via a command (Claude Code's ~/.claude.json is
   *  app-managed, so we never hand-edit it); `file` = a JSON config we merge. */
  managed: 'file' | 'cli';
  /** For `file`: the config path. For `cli`: the file we probe for presence. */
  configPath: string;
  present: boolean;
}

export interface ClientDeps {
  homedir?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  fileExists?: (p: string) => boolean;
  readFile?: (p: string) => string;
  writeFile?: (p: string, data: string) => void;
  mkdirp?: (dir: string) => void;
}

interface Resolved {
  home: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  fileExists: (p: string) => boolean;
  readFile: (p: string) => string;
  writeFile: (p: string, data: string) => void;
  mkdirp: (dir: string) => void;
}

function resolve(deps: ClientDeps): Resolved {
  return {
    home: deps.homedir ?? homedir(),
    platform: deps.platform ?? process.platform,
    env: deps.env ?? process.env,
    fileExists: deps.fileExists ?? ((p) => existsSync(p)),
    readFile: deps.readFile ?? ((p) => readFileSync(p, 'utf-8')),
    writeFile: deps.writeFile ?? ((p, d) => writeFileSync(p, d)),
    mkdirp: deps.mkdirp ?? ((dir) => mkdirSync(dir, { recursive: true })),
  };
}

// Build paths for the TARGET platform's separators, not the running host's, so
// the injected `platform` is honored deterministically (a Windows CI runner
// must still produce posix paths for a linux target, and vice versa).
function pp(r: Resolved): path.PlatformPath {
  return r.platform === 'win32' ? path.win32 : path.posix;
}

/** Claude Desktop's config path is OS-specific. */
function desktopConfigPath(r: Resolved): string {
  const j = pp(r);
  if (r.platform === 'darwin') {
    return j.join(r.home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  }
  if (r.platform === 'win32') {
    const appData = r.env.APPDATA || j.join(r.home, 'AppData', 'Roaming');
    return j.join(appData, 'Claude', 'claude_desktop_config.json');
  }
  return j.join(r.home, '.config', 'Claude', 'claude_desktop_config.json');
}

function claudeJsonPath(r: Resolved): string {
  return pp(r).join(r.home, '.claude.json');
}

function cursorConfigPath(r: Resolved): string {
  return pp(r).join(r.home, '.cursor', 'mcp.json');
}

export function detectClients(deps: ClientDeps = {}): ClientInfo[] {
  const r = resolve(deps);
  const j = pp(r);
  const desktop = desktopConfigPath(r);
  const cursor = cursorConfigPath(r);
  const claudeJson = claudeJsonPath(r);
  return [
    {
      id: 'claude-code',
      label: 'Claude Code',
      managed: 'cli',
      configPath: claudeJson,
      // Best-effort: the CLI-managed file or the config dir signals a Claude
      // Code install; we can't reliably probe PATH cross-platform here.
      present: r.fileExists(claudeJson) || r.fileExists(j.join(r.home, '.claude')),
    },
    {
      id: 'claude-desktop',
      label: 'Claude Desktop',
      managed: 'file',
      configPath: desktop,
      present: r.fileExists(desktop) || r.fileExists(j.dirname(desktop)),
    },
    {
      id: 'cursor',
      label: 'Cursor',
      managed: 'file',
      configPath: cursor,
      present: r.fileExists(cursor) || r.fileExists(j.dirname(cursor)),
    },
  ];
}

export type ServerEntry = { command: string; args: string[] } | { url: string };

export interface EntryOptions {
  name?: string;
  mode: Mode;
  /** Required for http mode: `${MCP_PUBLIC_URL}/mcp`. */
  resourceUri?: string;
  /** stdio launch override; defaults to `npx -y mcp-google-multi`. */
  command?: string;
  args?: string[];
}

/**
 * The client `mcpServers` entry. stdio needs no secret env: the server loads
 * its own .env from ~/.config/mcp-google-multi (cc-config R1), so we never
 * inline MASTER_KEY / GOOGLE_CLIENT_SECRET into a world-readable client config.
 */
export function buildServerEntry(opts: EntryOptions): ServerEntry {
  if (opts.mode === 'http') {
    if (!opts.resourceUri) throw new Error('E_VALIDATION: http mode requires resourceUri');
    return { url: opts.resourceUri };
  }
  return {
    command: opts.command ?? 'npx',
    args: opts.args ?? ['-y', 'mcp-google-multi'],
  };
}

/** The `claude mcp add ...` invocation for Claude Code (cli-managed). */
export function claudeCodeCommand(name: string, entry: ServerEntry): string {
  if ('url' in entry) {
    return `claude mcp add --transport http ${name} ${entry.url}`;
  }
  return `claude mcp add ${name} -- ${entry.command} ${entry.args.join(' ')}`;
}

export interface Instruction {
  client: ClientId;
  kind: 'cli' | 'file';
  /** The copy-pasteable command (cli) or JSON snippet (file). */
  text: string;
  /** Target file for `file` kind. */
  path?: string;
}

export function renderInstruction(client: ClientInfo, name: string, entry: ServerEntry): Instruction {
  if (client.managed === 'cli') {
    return { client: client.id, kind: 'cli', text: claudeCodeCommand(name, entry) };
  }
  const snippet = JSON.stringify({ mcpServers: { [name]: entry } }, null, 2);
  return { client: client.id, kind: 'file', text: snippet, path: client.configPath };
}

export type ApplyResult =
  | { ok: true; client: ClientId; action: 'added' | 'updated'; path: string; backup?: string }
  | { ok: false; client: ClientId; reason: 'parse_error' | 'cli_managed'; message: string; path: string; snippet?: string };

/**
 * Idempotently merge the entry into a file-managed client config: read latest,
 * refuse to clobber an unparseable file (print the snippet instead), back up
 * the prior file, update-in-place if the key exists.
 */
export function applyFileEntry(
  client: ClientInfo,
  name: string,
  entry: ServerEntry,
  deps: ClientDeps = {},
): ApplyResult {
  const r = resolve(deps);
  if (client.managed !== 'file') {
    return { ok: false, client: client.id, reason: 'cli_managed', message: `${client.label} is registered via the CLI, not a config file.`, path: client.configPath };
  }
  const p = client.configPath;
  let existing: Record<string, unknown> = {};
  let priorRaw: string | null = null;
  if (r.fileExists(p)) {
    priorRaw = r.readFile(p);
    if (priorRaw.trim() !== '') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(priorRaw);
      } catch {
        return {
          ok: false,
          client: client.id,
          reason: 'parse_error',
          message: `${p} is not valid JSON; not overwriting. Add this entry by hand:`,
          path: p,
          snippet: renderInstruction(client, name, entry).text,
        };
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return {
          ok: false,
          client: client.id,
          reason: 'parse_error',
          message: `${p} is not a JSON object; not overwriting. Add this entry by hand:`,
          path: p,
          snippet: renderInstruction(client, name, entry).text,
        };
      }
      existing = parsed as Record<string, unknown>;
    }
  }

  const prevServers = (existing.mcpServers && typeof existing.mcpServers === 'object' && !Array.isArray(existing.mcpServers))
    ? (existing.mcpServers as Record<string, unknown>)
    : {};
  const had = Object.prototype.hasOwnProperty.call(prevServers, name);
  const next = { ...existing, mcpServers: { ...prevServers, [name]: entry } };

  r.mkdirp(pp(r).dirname(p));
  // Back up the prior file before rewriting so a bad write is recoverable
  // (these foreign configs are small and not concurrently written by us, so a
  // backup + direct write is sufficient — our own config.json uses fs-atomic).
  let backup: string | undefined;
  if (priorRaw !== null) {
    backup = `${p}.bak`;
    r.writeFile(backup, priorRaw);
  }
  r.writeFile(p, `${JSON.stringify(next, null, 2)}\n`);
  return { ok: true, client: client.id, action: had ? 'updated' : 'added', path: p, backup };
}

/** Resolve stdio-vs-http mode from the current transport config (B11).
 * http/both → a `url` entry; stdio → a `command` entry. */
export function resolveMode(
  httpConfig?: { transport: 'stdio' | 'http' | 'both'; resourceUri: string },
): { mode: Mode; resourceUri?: string } {
  if (httpConfig && (httpConfig.transport === 'http' || httpConfig.transport === 'both')) {
    return { mode: 'http', resourceUri: httpConfig.resourceUri };
  }
  return { mode: 'stdio' };
}

function argFlag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function confirmTty(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer: string = await new Promise((resolve) => rl.question(prompt, resolve));
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/**
 * CLI: `mcp-google-multi write-client-config [--client id] [--name n] [--url u]
 * [--print] [--yes]`. Consent-gated (clig.dev): never writes a file-managed
 * config without an explicit yes; non-TTY / `--print` prints the snippet.
 */
export async function runWriteClientConfigCli(argv: string[]): Promise<number> {
  const name = argFlag(argv, '--name') ?? DEFAULT_SERVER_NAME;
  const only = argFlag(argv, '--client') as ClientId | undefined;
  const printOnly = argv.includes('--print');
  const yes = argv.includes('--yes');
  const urlOverride = argFlag(argv, '--url');

  let mode: Mode = 'stdio';
  let resourceUri: string | undefined;
  if (urlOverride) {
    mode = 'http';
    resourceUri = urlOverride.replace(/\/+$/, '');
  } else {
    try {
      const { resolveHttpConfig } = await import('./http-config.js');
      const http = resolveHttpConfig();
      const m = resolveMode(http);
      mode = m.mode;
      resourceUri = m.resourceUri;
    } catch {
      // fall back to stdio on any config error
    }
  }

  let entry: ServerEntry;
  try {
    entry = buildServerEntry({ name, mode, resourceUri });
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }

  let clients = detectClients();
  if (only) {
    clients = clients.filter((c) => c.id === only);
    if (clients.length === 0) {
      console.error(`Unknown --client "${only}". Known: claude-code, claude-desktop, cursor.`);
      return 1;
    }
  } else {
    const present = clients.filter((c) => c.present);
    if (present.length > 0) clients = present;
  }

  const nonTty = !process.stdin.isTTY;
  let wrote = 0;
  for (const client of clients) {
    const instr = renderInstruction(client, name, entry);
    if (client.managed === 'cli') {
      console.log(`\n${client.label}: run this command`);
      console.log(`  ${instr.text}`);
      continue;
    }
    if (printOnly || (nonTty && !yes)) {
      console.log(`\n${client.label}: add to ${instr.path}`);
      console.log(instr.text);
      if (nonTty && !yes && !printOnly) console.log('(re-run with --yes to write this automatically)');
      continue;
    }
    const ok = yes || (await confirmTty(`\n${client.label}: write ${instr.path}? [y/N] `));
    if (!ok) {
      console.log(`Skipped ${client.label}. Snippet for ${instr.path}:`);
      console.log(instr.text);
      continue;
    }
    const res = applyFileEntry(client, name, entry);
    if (res.ok) {
      wrote++;
      console.log(`✔ ${client.label}: ${res.action} "${name}" in ${res.path}${res.backup ? ` (backup ${res.backup})` : ''}`);
    } else {
      console.error(`✖ ${client.label}: ${res.message}`);
      if (res.snippet) console.error(res.snippet);
    }
  }
  if (mode === 'http') {
    console.log(`\nRemote HTTP server: ${resourceUri} — authentication is handled by the OAuth flow, so no secrets are stored in the client config.`);
  } else {
    console.log('\nSecrets stay in ~/.config/mcp-google-multi/.env; the client entry carries none.');
  }
  void wrote;
  return 0;
}
