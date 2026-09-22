import { describe, it, expect } from 'vitest';
import { decideConnectAttemptTimeout, CONNECT_ATTEMPT_TIMEOUT_MS } from '../src/net-tuning.js';

describe('decideConnectAttemptTimeout', () => {
  it('raises the LTS default (250ms) to the tolerant default', () => {
    expect(decideConnectAttemptTimeout({ execArgv: [], nodeOptions: undefined, current: 250 })).toBe(
      CONNECT_ATTEMPT_TIMEOUT_MS,
    );
  });

  it('raises the v25.2+ default (500ms) too', () => {
    expect(decideConnectAttemptTimeout({ execArgv: [], nodeOptions: '', current: 500 })).toBe(
      CONNECT_ATTEMPT_TIMEOUT_MS,
    );
  });

  it('never lowers a value at or above the tolerant default', () => {
    expect(decideConnectAttemptTimeout({ execArgv: [], nodeOptions: undefined, current: 2000 })).toBeNull();
    expect(decideConnectAttemptTimeout({ execArgv: [], nodeOptions: undefined, current: 5000 })).toBeNull();
  });

  it('leaves an explicit user flag in execArgv alone, even a lower one', () => {
    expect(
      decideConnectAttemptTimeout({
        execArgv: ['--network-family-autoselection-attempt-timeout=300'],
        nodeOptions: undefined,
        current: 300,
      }),
    ).toBeNull();
  });

  it('leaves an explicit user flag in NODE_OPTIONS alone', () => {
    expect(
      decideConnectAttemptTimeout({
        execArgv: [],
        nodeOptions: '--network-family-autoselection-attempt-timeout=2000',
        current: 2000,
      }),
    ).toBeNull();
  });

  it('respects --no-network-family-autoselection', () => {
    expect(
      decideConnectAttemptTimeout({ execArgv: ['--no-network-family-autoselection'], nodeOptions: undefined, current: 250 }),
    ).toBeNull();
  });
});
