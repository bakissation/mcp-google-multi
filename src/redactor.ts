/**
 * Secret redactor — strips sensitive fields from any object recursively.
 *
 * Redacts the following keys (case-insensitive):
 *   access_token, refresh_token, client_secret, private_key,
 *   authorization, enc_blob, id_token
 *
 * Handles nested objects, arrays, Error, Date, Buffer, and primitive values.
 * Uses a Map<object, object> to store original→redacted mapping:
 *   - Circular refs: returns the already-built redacted copy from the Map
 *   - Shared refs: deduplicates so identical input ref → identical output ref
 *
 * Special-case handling:
 *   - Error: keeps name/message, drops stack/enumerable props
 *   - Date: preserved as-is (not walked as a plain object)
 *   - Buffer: replaced with "[Buffer]" (binary data, not serializable to JSON)
 */

// No LogRecord import needed

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
  'id_token',
]);

function isSecretKey(key: string): boolean {
  return SECRET_KEYS.has(key.toLowerCase());
}

function isCamelCaseSecret(key: string): boolean {
  // Matches common credential field names in camelCase:
  // accessToken, refreshToken, idToken, authToken, bearerToken,
  // clientSecret, userPassword, apiKey, apiSecret, userSecret
  // NOT: clientId, userId, accessKey, secretKey, tokens, sessionToken
  const credKeyLower = key.toLowerCase();
  return (
    credKeyLower === 'accesstoken' ||
    credKeyLower === 'refreshtoken' ||
    credKeyLower === 'idtoken' ||
    credKeyLower === 'authtoken' ||
    credKeyLower === 'bearertoken' ||
    credKeyLower === 'clientsecret' ||
    credKeyLower === 'usersecret' ||
    credKeyLower === 'userpassword' ||
    credKeyLower === 'userpass' ||
    credKeyLower === 'userpin' ||
    credKeyLower === 'apisecret' ||
    credKeyLower === 'apikey' ||
    credKeyLower === 'sessionkey' ||
    credKeyLower === 'encryptionkey'
  );
}

function shouldRedactKey(key: string): boolean {
  return isSecretKey(key) || isCamelCaseSecret(key);
}

// ---------------------------------------------------------------------------
// Redactor
// ---------------------------------------------------------------------------

// No special types needed

/**
 * Recursively walk `value` and return a copy with all secret fields
 * replaced by `"[REDACTED]"`. Uses a memo Map to store already-processed
 * objects so circular references resolve to their redacted form and
 * shared objects produce identical output references.
 */
export function redactor<T>(value: T): T {
  const memo = new Map<object, object>();
  return _redact(value, memo);
}

/**
 * Detects and replaces circular references in an object graph, replacing
 * back-references with the string "[Circular]". Works on plain objects,
 * arrays, and mixed structures.
 */
function handleCircularRefs(value: unknown, seen: Map<object, string>): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (value instanceof Date) return value;
  if (Buffer.isBuffer(value)) return '[Buffer]';
  if (Array.isArray(value)) {
    return value.map((item) => handleCircularRefs(item, seen));
  }
  if (value instanceof Error) return value; // handled separately

  const existing = seen.get(value as object);
  if (existing !== undefined) return existing;

  seen.set(value as object, '[Circular]');
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    result[k] = handleCircularRefs(v, seen);
  }
  return result;
}

function _redact<T>(value: T, memo: Map<object, object>): T {
  // Primitives — return as-is
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;

  // Handle Error specially: preserve name/message, redact everything else
  if (value instanceof Error) {
    return {
      name: '[REDACTED]',
      message: '[REDACTED]',
      stack: '[REDACTED]',
    } as unknown as T;
  }

  // Preserve Date objects as-is
  if (value instanceof Date) return value;

  // Handle Buffer
  if (Buffer.isBuffer(value)) return '[Buffer]' as unknown as T;

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
    result[k] = shouldRedactKey(k) ? '[REDACTED]' : _redact(v, memo);
  }
  return result as unknown as T;
}

/**
 * Safe JSON stringify — handles circular refs by replacing them with "[Circular]"
 * and returns a JSON string. Never throws.
 */
export function safeStringify(value: unknown): string {
  try {
    const circularSafe = handleCircularRefs(value, new Map());
    return JSON.stringify(circularSafe);
  } catch {
    return '"[Circular]"';
  }
}