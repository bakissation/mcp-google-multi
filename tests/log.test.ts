import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('log', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  let outSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('writes warn/error to stderr, never stdout', async () => {
    const { log } = await import('../src/log.js');
    log.warn('hi');
    log.error('bad');
    expect(outSpy).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledTimes(2);
    expect(errSpy.mock.calls[0][0]).toContain('mcp-google-multi WARN: hi');
    expect(errSpy.mock.calls[1][0]).toContain('mcp-google-multi ERROR: bad');
  });

  it('redacts object metadata before writing', async () => {
    const { log } = await import('../src/log.js');
    log.error('oops', { access_token: 'SECRET', keep: 1 });
    const line = String(errSpy.mock.calls[0][0]);
    expect(line).not.toContain('SECRET');
    expect(line).toContain('[REDACTED]');
    expect(line).toContain('"keep":1');
  });

  it('suppresses debug by default', async () => {
    vi.stubEnv('MCP_LOG', '');
    vi.stubEnv('DEBUG', '');
    vi.resetModules();
    const { log } = await import('../src/log.js');
    log.debug('quiet');
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('emits debug when MCP_LOG=debug', async () => {
    vi.stubEnv('MCP_LOG', 'debug');
    vi.resetModules();
    const { log } = await import('../src/log.js');
    log.debug('loud');
    expect(errSpy).toHaveBeenCalledOnce();
    expect(String(errSpy.mock.calls[0][0])).toContain('DEBUG: loud');
  });
});
