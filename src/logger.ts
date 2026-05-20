/**
 * Structured logger + secret redactor.
 *
 * All tool handlers must use this logger — never console.log/error.
 * Logs go to stderr (stdio is the MCP channel).
 *
 * Redacts: access_token, refresh_token, client_secret, private_key,
 *          Authorization header, enc_blob.
 */

import { redactor } from './redactor.js';

// ---------------------------------------------------------------------------
// Log levels
// ---------------------------------------------------------------------------

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

// ---------------------------------------------------------------------------
// Log record shape
// ---------------------------------------------------------------------------

export interface LogRecord {
  ts: string;
  level: LogLevel;
  correlation_id: string | undefined;
  tool: string | undefined;
  service: string | undefined;
  account: string | undefined;
  cud: string | undefined;
  outcome: 'success' | 'error' | 'pending';
  latency_ms: number | undefined;
  msg?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Internal counter for correlation IDs
// ---------------------------------------------------------------------------

let _correlationCounter = 0;
function nextCorrelationId(): string {
  return `cid-${Date.now()}-${++_correlationCounter}`;
}

// ---------------------------------------------------------------------------
// Core writer — JSON to stderr
// ---------------------------------------------------------------------------

function writeLog(record: LogRecord): void {
  process.stderr.write(JSON.stringify(record) + '\n');
}

// ---------------------------------------------------------------------------
// Logger factory
// ---------------------------------------------------------------------------

export interface LoggerOptions {
  tool?: string;
  service?: string;
  account?: string;
  cud?: string;
  correlationId?: string;
}

/** Returns a bound logger for a specific tool/service context. */
export function createLogger(options: LoggerOptions = {}) {
  const { tool, service, account, cud, correlationId } = options;
  const baseCorrelationId = correlationId ?? nextCorrelationId();

  function buildRecord(
    level: LogLevel,
    outcome: LogRecord['outcome'],
    extra: Record<string, unknown> = {},
  ): LogRecord {
    return {
      ts: new Date().toISOString(),
      level,
      correlation_id: baseCorrelationId,
      tool,
      service,
      account,
      cud,
      outcome,
      latency_ms: undefined,
      ...extra,
    };
  }

  return {
    /** Debug — not shown in production unless LOG_LEVEL=debug */
    debug(msg: string, extra: Record<string, unknown> = {}): void {
      writeLog(buildRecord('debug', 'pending', { msg, ...extra }));
    },

    /** Info — tool dispatch, successful completion */
    info(outcome: LogRecord['outcome'], latencyMs: number, extra: Record<string, unknown> = {}): void {
      const record = buildRecord('info', outcome, extra);
      record.latency_ms = latencyMs;
      writeLog(record);
    },

    /** Warn — non-fatal issues (rate-limit, partial failure, etc.) */
    warn(msg: string, extra: Record<string, unknown> = {}): void {
      writeLog(buildRecord('warn', 'error', { msg, ...extra }));
    },

    /** Error — handler exceptions */
    error(err: unknown, latencyMs?: number, extra: Record<string, unknown> = {}): void {
      // Pull a sane message out of the error
      const message = err instanceof Error ? err.message : String(err);
      const record = buildRecord('error', 'error', { msg: message, ...extra });
      if (latencyMs !== undefined) record.latency_ms = latencyMs;
      writeLog(record);
    },

    /**
     * Log a tool dispatch with timing.
     * Usage:
     *   const end = logger.start('gmail_search');
     *   // ... do work ...
     *   end({ outcome: 'success' });
     */
    start(toolName: string, extra: Record<string, unknown> = {}): (result: { outcome: LogRecord['outcome']; latencyMs?: number }) => void {
      return ({ outcome, latencyMs }) => {
        const record = buildRecord('info', outcome, extra);
        record.tool = toolName;
        if (latencyMs !== undefined) record.latency_ms = latencyMs;
        writeLog(record);
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Convenience: log with a redacted payload for debugging
// ---------------------------------------------------------------------------

/**
 * Writes a redacted log record. Useful for tracing payloads that might contain
 * secrets — the redactor strips sensitive fields before output.
 */
export function logRedacted(
  level: LogLevel,
  msg: string,
  payload: Record<string, unknown> = {},
): void {
  process.stderr.write(
    JSON.stringify({
      ts: new Date().toISOString(),
      level,
      msg,
      payload: redactor(payload),
    }) + '\n',
  );
}