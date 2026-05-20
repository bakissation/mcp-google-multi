/**
 * Secret redactor — strips sensitive fields from any object recursively.
 *
 * Redacts the following keys (case-insensitive):
 *   access_token, refresh_token, client_secret, private_key,
 *   Authorization, enc_blob
 *
 * Handles nested objects, arrays, and primitive values.
 * Uses a Map<object, object> to store original→redacted mappings:
 *   - Circular refs: returns the already-built redacted copy from the Map
 *   - Shared refs: deduplicates so identical input ref → identical output ref
 *
 * The deduplication means that shared references like `[x, x]` produce
 * output where `items[0] === items[1]` — fine for logging, and avoids
 * double-processing. Circular refs `{ self }` resolve to the already-built
 * result rather than infinite recursion.
 */

// ---------------------------------------------------------------------------
// Secrets list (lower-case for case-insensitive matching)
// ---------------------------------------------------------------------------

const SECRET_KEYS = new Set([
  'access_token',
  'refresh_token',
  'client_secret',
  'private_key',
  'authorization',
  'enc_blob',
]);

function isSecretKey(key: string): boolean {
  return SECRET_KEYS.has(key.toLowerCase());
}

// ---------------------------------------------------------------------------
// Redactor
// ---------------------------------------------------------------------------

/**
 * Recursively walk `value` and return a copy with all secret fields
 * replaced by `"[REDACTED]"`. Uses a memo Map to store already-processed
 * objects so circular references resolve to their redacted form and
 * shared objects produce identical output references.
 *
 * @param value - The value to redact (will not mutate the original)
 * @returns A new value with secrets replaced
 */
export function redactor<T>(value: T): T {
  const memo = new Map<object, object>();
  return _redact(value, memo);
}

function _redact<T>(value: T, memo: Map<object, object>): T {
  // Primitives — return as-is
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;

  // If we've already built a redacted copy for this exact object,
  // return it — handles both circular refs and shared references.
  const existing = memo.get(value as object);
  if (existing !== undefined) return existing as unknown as T;

  if (Array.isArray(value)) {
    const redacted = value.map((item) => _redact(item, memo));
    memo.set(value as object, redacted as unknown as object);
    return redacted as unknown as T;
  }

  // Plain object — create result and register it BEFORE recursing so that
  // circular child references see it in the memo immediately.
  const result: Record<string, unknown> = {};
  memo.set(value as object, result as unknown as object);

  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    result[k] = isSecretKey(k) ? '[REDACTED]' : _redact(v, memo);
  }
  return result as unknown as T;
}