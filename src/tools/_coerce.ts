import { z } from 'zod';

/**
 * Shared string-coercion helpers for MCP tool input schemas.
 *
 * Some MCP clients (e.g. Claude Code) send array/object fields as JSON-encoded
 * strings, or boolean fields as "true"/"false" string literals.  These helpers
 * coerce those strings into their intended types before the tool handler runs,
 * producing a clear `validation_error` response when coercion is not possible.
 *
 * Each helper is a Zod schema (z.union + z.transform) that accepts both the
 * native type and a string representation, and transforms to the canonical output.
 *
 * Usage — apply via .pipe() on z.unknown() or z.string():
 *
 *   // For array-of-strings fields:
 *   attendees: z.unknown().pipe(stringToArray).optional()
 *
 *   // For object fields:
 *   filters: z.unknown().pipe(stringToObject).optional()
 *
 *   // For boolean fields (client may send "true"/"false" strings):
 *   allDay: z.union([z.boolean(), z.string()]).pipe(stringToBoolean).optional()
 *
 * Note: the helpers can be used standalone (no .pipe()) since they already accept
 * z.union input (both native and string representations).
 */

// ─── stringToArray ────────────────────────────────────────────────────────────
// Coerces: string[] → unchanged, string → JSON-parse-or-comma-split
const _stringToArrayTransform = z.union([z.string(), z.array(z.string())]).transform((val, ctx) => {
  if (Array.isArray(val)) return val as string[];
  if (typeof val === 'string') {
    try { return JSON.parse(val) as string[]; } catch (_) { /* not JSON, fall through to comma-split */ }
    return val.split(',').map((s: string) => s.trim()).filter(Boolean);
  }
  ctx.addIssue({
    code: 'custom',
    message: `validation_error: expected string or array, received ${typeof val}`,
  });
  return z.NEVER;
});

export const stringToArray = _stringToArrayTransform;

// ─── stringToObject ──────────────────────────────────────────────────────────
// Coerces: plain object → unchanged, JSON string → parsed object
const _stringToObjectTransform = z.union([
  z.record(z.string(), z.any()),
  z.string(),
]).transform((val, ctx) => {
  if (typeof val === 'object' && val !== null) return val as Record<string, unknown>;
  if (typeof val === 'string') {
    try { return JSON.parse(val) as Record<string, unknown>; } catch {
      ctx.addIssue({
        code: 'custom',
        message: `validation_error: cannot coerce "${val}" to object`,
      });
      return z.NEVER;
    }
  }
  ctx.addIssue({
    code: 'custom',
    message: `validation_error: expected object or JSON string, received ${typeof val}`,
  });
  return z.NEVER;
});

export const stringToObject = _stringToObjectTransform;

// ─── stringToBoolean ─────────────────────────────────────────────────────────
// Coerces: boolean unchanged; "true"/"1"/"yes" → true; "false"/"0"/"no" → false
const _stringToBooleanTransform = z.union([z.boolean(), z.string()]).transform((val, ctx) => {
  if (typeof val === 'boolean') return val;
  const str = String(val).trim().toLowerCase();
  if (str === 'true' || str === '1' || str === 'yes') return true;
  if (str === 'false' || str === '0' || str === 'no') return false;
  ctx.addIssue({ code: 'custom', message: `validation_error: cannot coerce "${val}" to boolean` });
  return z.NEVER;
});

export const stringToBoolean = _stringToBooleanTransform;

/**
 * Builds a ZodError with a clear validation_error message for use in transforms.
 */
export function validationError(
  field: string,
  expected: string,
  received: unknown,
): z.ZodError {
  return new z.ZodError([{
    code: 'custom' as const,
    message: `validation_error: field "${field}" expected ${expected}, received ${typeof received}: ${JSON.stringify(received)}`,
    path: [field],
  }]);
}