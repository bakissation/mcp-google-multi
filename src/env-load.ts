import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface EnvLoadResult {
  loaded: string[];
  searched: string[];
}

/** Path overrides are for tests only; production callers pass nothing. */
export interface EnvLoadPaths {
  cwd?: string;
  packageRoot?: string;
  configDir?: string;
}

// Precedence: real env > CWD .env > package-root .env > ~/.config .env;
// the boot snapshot re-assert below is a second line of defense.
export function loadEnvFiles(paths: EnvLoadPaths = {}): EnvLoadResult {
  // loadEnvFile exists since 20.12, so a feature check alone would let 20.12-21.x through.
  const major = Number(process.versions.node.split('.', 1)[0]);
  if (major < 22 || typeof process.loadEnvFile !== 'function') {
    process.stderr.write(
      `E_NODE_TOO_OLD: mcp-google-multi requires Node.js >= 22 (running ${process.versions.node}). Upgrade to Node 22 LTS or newer.\n`,
    );
    process.exit(1);
  }

  const configDir =
    paths.configDir ??
    path.join(
      process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config'),
      'mcp-google-multi',
    );
  const explicit = process.env.MCP_GOOGLE_MULTI_ENV;
  const candidates = explicit
    ? [path.resolve(explicit)]
    : [
        path.join(paths.cwd ?? process.cwd(), '.env'),
        path.join(paths.packageRoot ?? path.resolve(__dirname, '..'), '.env'),
        path.join(configDir, '.env'),
      ];

  const boot = new Map(
    Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
  );
  const loaded: string[] = [];
  for (const p of candidates) {
    try {
      process.loadEnvFile(p);
      loaded.push(p);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        // Node collapses every open()-stage failure (EACCES, ENOTDIR, ...) into
        // ENOENT, so stat to tell "absent" from "present but unreadable".
        if (explicit) {
          const reason = existsSync(p) ? 'exists but is not readable' : 'does not exist';
          process.stderr.write(
            `E_ENV_NOT_FOUND: MCP_GOOGLE_MULTI_ENV points to "${p}" but the file ${reason}.\n`,
          );
          process.exit(1);
        }
        continue;
      }
      throw e;
    }
  }
  for (const [k, v] of boot) process.env[k] = v;

  lastLoad = { bootKeys: new Set(boot.keys()), loaded };
  return { loaded, searched: candidates };
}

let lastLoad: { bootKeys: Set<string>; loaded: string[] } | undefined;

/** The .env files this process actually loaded a secret from (candidates
 * that did not exist are not included). Used by the local-file guard to
 * refuse reading or writing a file the server itself sourced secrets from,
 * even though it sits outside the config/token directory (e.g. a project
 * root .env, or MCP_GOOGLE_MULTI_ENV pointing elsewhere entirely). */
export function getLoadedEnvFiles(): string[] {
  return lastLoad?.loaded ?? [];
}

/**
 * Which layer supplied `key`: the real process env, or the first loaded .env
 * file defining it (autoload never overwrites, so first wins). undefined when
 * the key is unset. Powers self-announcing enablement sources (usage metrics).
 */
export function envValueSource(key: string): { kind: 'process' } | { kind: 'file'; file: string } | undefined {
  if (process.env[key] === undefined) return undefined;
  if (!lastLoad || lastLoad.bootKeys.has(key)) return { kind: 'process' };
  const re = new RegExp(`^\\s*${key}\\s*=`, 'm');
  for (const p of lastLoad.loaded) {
    try {
      if (re.test(readFileSync(p, 'utf-8'))) return { kind: 'file', file: p };
    } catch { /* file vanished since load: fall through */ }
  }
  return { kind: 'process' };
}
