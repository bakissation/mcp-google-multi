import { existsSync } from 'node:fs';
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

// Precedence: real env > CWD .env > package-root .env > ~/.config .env.
// process.loadEnvFile never overwrites keys already in process.env (pinned by
// tests/env-load.test.ts T4), so highest-priority file loads FIRST and real
// env wins by already being present; the boot snapshot re-assert is a second
// line of defense should those semantics ever change.
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

  return { loaded, searched: candidates };
}
