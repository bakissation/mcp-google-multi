import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// src/accounts.ts fails at import time if no accounts are configured (CI has
// no .env) — seed a fixture before test imports pull it in.
process.env.GOOGLE_ACCOUNTS ||= 'test:test@example.com';
// Sandbox module-load filesystem side effects away from the real home
// (first-run config.json materialization, the .env tier read).
process.env.XDG_CONFIG_HOME = mkdtempSync(path.join(tmpdir(), 'mcp-gm-test-xdg-'));
process.env.TOKEN_STORE_PATH = path.join(process.env.XDG_CONFIG_HOME, 'tokens');

// The OS keyring is real state on a developer machine: stub it process-wide so
// no test (or the env->keychain mirror) can ever touch it.
const { __setKeychainFactoryForTest } = await import('../src/master-key.js');
const fakeKeyringStore = new Map<string, string>();
__setKeychainFactoryForTest((account) => ({
  get: () => fakeKeyringStore.get(account) ?? null,
  set: (v: string) => void fakeKeyringStore.set(account, v),
  del: () => void fakeKeyringStore.delete(account),
}));
// ToolRegistry reads GOOGLE_TRIM at construction — pin it so an ambient
// GOOGLE_TRIM=off in a developer shell can't redden the compaction tests.
process.env.GOOGLE_TRIM = '';
// ToolRegistry also reads GOOGLE_DISCOVERY at construction — pin to the lazy
// default so an ambient mode in a dev shell can't redden visibility tests.
process.env.GOOGLE_DISCOVERY = '';
// GOOGLE_LOCAL_FILES_DIR confines every host-file read/write to a root.
// Existing tests build their fixture files under os.tmpdir() (the universal
// convention across this suite); pin the root to tmpdir itself so those
// paths stay inside it without every test needing to know about the root.
// Tests of the root/default itself override this locally.
process.env.GOOGLE_LOCAL_FILES_DIR = tmpdir();
