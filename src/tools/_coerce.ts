import { z } from 'zod';

/**
 * Shared string-coercion helpers for MCP tool input schemas.
 *
 * Some MCP clients (Claude Code) send array/object fields as JSON-encoded
 * strings, or boolean fields as "true"/"false" string literals.  These helpers
 * coerce those strings into their intended types before the tool handler runs,
 * producing a clear `validation_error` response when coercion is not possible.
 *
 * Usage — apply directly as a schema field (no .pipe() needed):
 *
 *   // For array-of-strings fields:
 *   attendees: stringToArray.optional()
 *
 *   // For object fields:
 *   filters: stringToObject.optional()
 *
 *   // For boolean fields (client may send "true"/"false" strings):
 *   allDay: stringToBoolean.optional()
 *
 * Each helper accepts both the native type and a string representation,
 * and transforms to the canonical output type.
 */

// ─── stringToArray ────────────────────────────────────────────────────────────
// Coerces: string[] → unchanged, string → JSON-parse-or-comma-split → string[]
// JSON-parsed values are validated: must be an array of strings after parsing.
const _stringToArrayTransform = z.union([z.string(), z.array(z.string())]).transform((val, ctx) => {
  if (Array.isArray(val)) return val as string[];
  if (typeof val === 'string') {
    try {
      const parsed = JSON.parse(val);
      // Validate that JSON parse produced an array of strings
      if (!Array.isArray(parsed)) {
        ctx.addIssue({
          code: 'custom',
          message: `validation_error: JSON parse produced ${typeof parsed}, expected string[]`,
        });
        return z.NEVER;
      }
      // Validate all elements are strings
      for (let i = 0; i < parsed.length; i++) {
        if (typeof parsed[i] !== 'string') {
          ctx.addIssue({
            code: 'custom',
            message: `validation_error: array element [${i}] is ${typeof parsed[i]}, expected string`,
          });
          return z.NEVER;
        }
      }
      return parsed as string[];
    } catch (_) {
      // Not JSON — fall through to comma-split
    }
    return val.split(',').map((s: string) => s.trim()).filter(Boolean);
  }
  ctx.addIssue({
    code: 'custom',
    message: `validation_error: expected string or array, received ${typeof val}`,
  });
  return z.NEVER;
});

/**
 * Zod schema that accepts string | string[] and coerces to string[].
 * Use directly as a field schema — no .pipe() needed.
 */
export const stringToArray = _stringToArrayTransform;

// ─── stringToObject ──────────────────────────────────────────────────────────
// Coerces: plain object → unchanged, JSON string → parsed object
// JSON-parsed value is validated: must be a plain object (not array/primitives)
const _stringToObjectTransform = z.union([
  z.record(z.string(), z.any()),
  z.string(),
]).transform((val, ctx) => {
  if (typeof val === 'object' && val !== null && !Array.isArray(val)) return val as Record<string, unknown>;
  if (typeof val === 'string') {
    try {
      const parsed = JSON.parse(val);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        ctx.addIssue({
          code: 'custom',
          message: `validation_error: JSON parse produced ${Array.isArray(parsed) ? 'array' : typeof parsed}, expected plain object`,
        });
        return z.NEVER;
      }
      return parsed as Record<string, unknown>;
    } catch {
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

/**
 * Zod schema that accepts object | JSON string and coerces to Record<string, unknown>.
 * Use directly as a field schema — no .pipe() needed.
 */
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

/**
 * Zod schema that accepts boolean | string and coerces to boolean.
 * Use directly as a field schema — no .pipe() needed.
 */
export const stringToBoolean = _stringToBooleanTransform;