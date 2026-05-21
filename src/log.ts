// Minimal stderr logger. stdout is the MCP channel — anything written there
// corrupts the protocol — so all diagnostics go to stderr. Object args are
// redacted first. `debug` is off unless MCP_LOG=debug (or DEBUG) is set.
// Structured/observability logging is deferred to v6 (see FSD cc-logging).
import { redact } from './redactor.js';

const DEBUG_ENABLED = /^(1|true|debug)$/i.test(
  process.env.MCP_LOG ?? process.env.DEBUG ?? '',
);

type Level = 'DEBUG' | 'WARN' | 'ERROR';

function emit(level: Level, msg: string, meta?: unknown): void {
  let line = `mcp-google-multi ${level}: ${msg}`;
  if (meta !== undefined) line += ' ' + JSON.stringify(redact(meta));
  process.stderr.write(line + '\n');
}

export const log = {
  /** Verbose; only emitted when MCP_LOG=debug (or DEBUG) is set. */
  debug(msg: string, meta?: unknown): void {
    if (DEBUG_ENABLED) emit('DEBUG', msg, meta);
  },
  warn(msg: string, meta?: unknown): void {
    emit('WARN', msg, meta);
  },
  error(msg: string, meta?: unknown): void {
    emit('ERROR', msg, meta);
  },
};
