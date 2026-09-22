import net from 'node:net';

// Node's happy-eyeballs gives each address family 250ms per connect attempt on
// every LTS line (raised to 500ms only in v25.2+); on high-latency or
// broken-IPv6 links that aborts EVERY Google call while curl works. Raise the
// process default unless the user tuned it themselves. Why: docs/internals.md.
export const CONNECT_ATTEMPT_TIMEOUT_MS = 2000;

const USER_FLAGS = ['--network-family-autoselection-attempt-timeout', '--no-network-family-autoselection'];

/** Pure decision: the timeout to apply, or null to leave Node's setting alone. */
export function decideConnectAttemptTimeout(opts: {
  execArgv: readonly string[];
  nodeOptions: string | undefined;
  current: number;
}): number | null {
  const userArgs = [...opts.execArgv, opts.nodeOptions ?? ''].join(' ');
  if (USER_FLAGS.some((f) => userArgs.includes(f))) return null;
  if (opts.current >= CONNECT_ATTEMPT_TIMEOUT_MS) return null;
  return CONNECT_ATTEMPT_TIMEOUT_MS;
}

export function applyNetTuning(): void {
  const timeout = decideConnectAttemptTimeout({
    execArgv: process.execArgv,
    nodeOptions: process.env.NODE_OPTIONS,
    current: net.getDefaultAutoSelectFamilyAttemptTimeout(),
  });
  if (timeout !== null) net.setDefaultAutoSelectFamilyAttemptTimeout(timeout);
}
