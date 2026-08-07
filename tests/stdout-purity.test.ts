import { describe, it, expect, vi, afterEach } from 'vitest';

// stdout IS the JSON-RPC channel for a stdio MCP server — nothing may write to
// it at import time. Regression guard for the dotenv v17 banner (issue #109).
describe('import-time stdout purity', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('importing accounts.ts writes nothing to stdout', async () => {
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const consoleLog = vi.spyOn(console, 'log');

    vi.resetModules();
    await import('../src/accounts.js');

    expect(stdoutWrite).not.toHaveBeenCalled();
    expect(consoleLog).not.toHaveBeenCalled();
  });
});
