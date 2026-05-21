// Secret redactor — a security primitive, not logging polish. Any object that
// might be logged or embedded in an error message is passed through here first
// so OAuth tokens and secrets never leak. See FSD cc-logging / cc-security.

const REDACTED = '[REDACTED]';

// Normalized (lowercased, non-alphanumerics stripped) key names to redact.
// Deliberately NOT bare "token" — that would clobber non-secret Google fields
// like pageToken / nextPageToken / token_type.
const SENSITIVE_KEYS = new Set([
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'authtoken',
  'authorization',
  'clientsecret',
  'privatekey',
  'apikey',
  'password',
  'encblob',
]);

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key.toLowerCase().replace(/[^a-z0-9]/g, ''));
}

/**
 * Deep-copy `value` with sensitive fields replaced by `[REDACTED]`.
 * Never mutates the input. Safe on circular/shared references, arrays,
 * `Error`, `Date`, and `Buffer`.
 */
export function redact<T>(value: T): T {
  return redactInner(value, new WeakMap()) as T;
}

function redactInner(value: unknown, seen: WeakMap<object, unknown>): unknown {
  if (value === null || typeof value !== 'object') return value;

  if (Buffer.isBuffer(value)) return '[Buffer]';
  if (value instanceof Date) return value;

  const existing = seen.get(value);
  if (existing !== undefined) return existing;

  if (value instanceof Error) {
    const out: Record<string, unknown> = { name: value.name, message: value.message };
    seen.set(value, out);
    for (const key of Object.keys(value)) {
      out[key] = isSensitiveKey(key)
        ? REDACTED
        : redactInner((value as unknown as Record<string, unknown>)[key], seen);
    }
    return out;
  }

  if (Array.isArray(value)) {
    const out: unknown[] = [];
    seen.set(value, out);
    for (const item of value) out.push(redactInner(item, seen));
    return out;
  }

  const out: Record<string, unknown> = {};
  seen.set(value, out);
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitiveKey(key) ? REDACTED : redactInner(v, seen);
  }
  return out;
}
