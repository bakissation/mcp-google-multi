import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLogger } from '../src/logger.js';

describe('createLogger', () => {
  let stderrData: string[];

  beforeEach(() => {
    stderrData = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string) => {
      stderrData.push(chunk);
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns debug/info/warn/error/start methods', () => {
    const logger = createLogger({ tool: 'test', service: 'gmail' });
    expect(typeof logger.debug).toBe('function');
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.start).toBe('function');
  });

  it('redacts secret values in extra fields on error()', () => {
    const logger = createLogger({ tool: 'test', service: 'gmail' });
    const err = new Error('auth failure');
    // Extra field secret gets redacted; error object itself is redacted separately
    logger.error(err, undefined, { access_token: 'tok_abc', user: 'alice' });

    const record = JSON.parse(stderrData[0]!);
    expect(record.msg).toBe('auth failure');
    // secret in extra is redacted by writeLog calling redactor() before stringify
    expect(record.access_token).toBe('[REDACTED]');
    expect(record.user).toBe('alice');
  });

  it('redacts nested secret values in extra on debug()', () => {
    const logger = createLogger({ tool: 'test', service: 'gmail' });
    logger.debug('hello', { refresh_token: 'secret123', user: 'alice' });

    const record = JSON.parse(stderrData[0]!);
    expect(record.msg).toBe('hello');
    expect(record.refresh_token).toBe('[REDACTED]');
    expect(record.user).toBe('alice');
  });

  it('writes a valid JSON object per log call', () => {
    const logger = createLogger({ tool: 'test', service: 'gmail' });
    logger.info('success', 42);

    expect(stderrData).toHaveLength(1);
    expect(() => JSON.parse(stderrData[0]!)).not.toThrow();
    const record = JSON.parse(stderrData[0]!);
    expect(record.ts).toBeDefined();
    expect(record.level).toBe('info');
    expect(record.outcome).toBe('success');
    expect(record.latency_ms).toBe(42);
  });

  it('start() returns a function that writes a log record', () => {
    const logger = createLogger({ tool: 'test', service: 'gmail' });
    const end = logger.start('my_tool');
    end({ outcome: 'success', latencyMs: 12 });

    expect(stderrData).toHaveLength(1);
    const record = JSON.parse(stderrData[0]!);
    expect(record.tool).toBe('my_tool');
    expect(record.outcome).toBe('success');
    expect(record.latency_ms).toBe(12);
  });
});