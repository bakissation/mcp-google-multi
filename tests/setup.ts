import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// src/accounts.ts fails at import time if no accounts are configured (CI has
// no .env) — seed a fixture before test imports pull it in.
process.env.GOOGLE_ACCOUNTS ||= 'test:test@example.com';
// Sandbox EVERY module-load filesystem side effect away from the real home:
// the first-run shim materializes config.json into XDG_CONFIG_HOME, and the
// env loader reads an .env tier from there.
process.env.XDG_CONFIG_HOME = mkdtempSync(path.join(tmpdir(), 'mcp-gm-test-xdg-'));
process.env.TOKEN_STORE_PATH = path.join(process.env.XDG_CONFIG_HOME, 'tokens');
// ToolRegistry reads GOOGLE_TRIM at construction — pin it so an ambient
// GOOGLE_TRIM=off in a developer shell can't redden the compaction tests.
process.env.GOOGLE_TRIM = '';
