import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  stringToArray,
  stringToObject,
  stringToBoolean,
  validationError,
} from '../src/tools/_coerce.js';

// ─── stringToArray ────────────────────────────────────────────────────────────
// stringToArray is a complete schema: z.union([z.string(), z.array(z.string())]).transform(...)
// It accepts a raw string or a JSON-encoded string[] (e.g. when Claude Code serialises
// an array as a string before sending).
describe('stringToArray', () => {
  it('passes a real string array through unchanged', () => {
    // Array arrives as a string-encoded JSON array, e.g. '["a","b","c"]' — the transform
    // correctly parses the JSON back to a string[].
    const schema = z.object({ ids: stringToArray });
    expect(schema.parse({ ids: ['a', 'b', 'c'] })).toEqual({ ids: ['a', 'b', 'c'] });
  });

  it('parses a comma-separated string', () => {
    const schema = z.object({ ids: stringToArray });
    expect(schema.parse({ ids: 'a,b,c' })).toEqual({ ids: ['a', 'b', 'c'] });
  });

  it('trims whitespace around comma-separated items', () => {
    const schema = z.object({ ids: stringToArray });
    expect(schema.parse({ ids: '  a ,  b , c  ' })).toEqual({ ids: ['a', 'b', 'c'] });
  });

  it('parses a JSON string array', () => {
    const schema = z.object({ ids: stringToArray });
    expect(schema.parse({ ids: '["x", "y", "z"]' })).toEqual({ ids: ['x', 'y', 'z'] });
  });

  it('drops empty strings from comma-split', () => {
    const schema = z.object({ ids: stringToArray });
    expect(schema.parse({ ids: 'a,,b,  ,c' })).toEqual({ ids: ['a', 'b', 'c'] });
  });

  it('throws on number input', () => {
    const schema = z.object({ ids: stringToArray });
    expect(() => schema.parse({ ids: 42 })).toThrow(z.ZodError);
  });

  it('throws on null input', () => {
    const schema = z.object({ ids: stringToArray });
    expect(() => schema.parse({ ids: null })).toThrow(z.ZodError);
  });
});

// ─── stringToObject ────────────────────────────────────────────────────────────
// stringToObject is a complete schema: z.union([z.record(...), z.string()]).transform(...)
// It accepts a plain object or a JSON string.
describe('stringToObject', () => {
  it('passes a real object through unchanged', () => {
    const schema = z.object({ data: stringToObject });
    expect(schema.parse({ data: { a: 1, b: 'two' } })).toEqual({ data: { a: 1, b: 'two' } });
  });

  it('parses a JSON string object', () => {
    const schema = z.object({ data: stringToObject });
    expect(schema.parse({ data: '{"key": "value", "num": 42}' })).toEqual({ data: { key: 'value', num: 42 } });
  });

  it('throws on a plain string that is not valid JSON', () => {
    const schema = z.object({ data: stringToObject });
    expect(() => schema.parse({ data: 'not json at all' })).toThrow(z.ZodError);
  });

  it('throws on number input', () => {
    const schema = z.object({ data: stringToObject });
    expect(() => schema.parse({ data: 123 })).toThrow(z.ZodError);
  });

  it('throws on boolean input', () => {
    const schema = z.object({ data: stringToObject });
    expect(() => schema.parse({ data: true })).toThrow(z.ZodError);
  });

  it('throws on null input', () => {
    const schema = z.object({ data: stringToObject });
    expect(() => schema.parse({ data: null })).toThrow(z.ZodError);
  });

  it('validation_error message is clear when JSON decode fails', () => {
    const schema = z.object({ data: stringToObject });
    try {
      schema.parse({ data: 'broken{' });
    } catch (e) {
      expect(e.issues[0].message).toContain('validation_error');
    }
  });
});

// ─── stringToBoolean ──────────────────────────────────────────────────────────
// Usage: z.union([z.boolean(), z.string()]).pipe(stringToBoolean)
//         OR just stringToBoolean alone (handles bool + string → bool)
describe('stringToBoolean', () => {
  it('passes a real boolean through unchanged', () => {
    const schema = z.object({ flag: stringToBoolean });
    expect(schema.parse({ flag: true })).toEqual({ flag: true });
    expect(schema.parse({ flag: false })).toEqual({ flag: false });
  });

  it('coerces "true" / "True" / "TRUE" to true', () => {
    const schema = z.object({ flag: stringToBoolean });
    expect(schema.parse({ flag: 'true' })).toEqual({ flag: true });
    expect(schema.parse({ flag: 'True' })).toEqual({ flag: true });
    expect(schema.parse({ flag: 'TRUE' })).toEqual({ flag: true });
  });

  it('coerces "false" / "False" / "FALSE" to false', () => {
    const schema = z.object({ flag: stringToBoolean });
    expect(schema.parse({ flag: 'false' })).toEqual({ flag: false });
    expect(schema.parse({ flag: 'False' })).toEqual({ flag: false });
    expect(schema.parse({ flag: 'FALSE' })).toEqual({ flag: false });
  });

  it('coerces "1" / "yes" to true and "0" / "no" to false', () => {
    const schema = z.object({ flag: stringToBoolean });
    expect(schema.parse({ flag: '1' })).toEqual({ flag: true });
    expect(schema.parse({ flag: 'yes' })).toEqual({ flag: true });
    expect(schema.parse({ flag: '0' })).toEqual({ flag: false });
    expect(schema.parse({ flag: 'no' })).toEqual({ flag: false });
  });

  it('throws on unrecognised strings', () => {
    const schema = z.object({ flag: stringToBoolean });
    expect(() => schema.parse({ flag: 'maybe' })).toThrow(z.ZodError);
    expect(() => schema.parse({ flag: '2' })).toThrow(z.ZodError);
  });

  it('trims whitespace before evaluating', () => {
    const schema = z.object({ flag: stringToBoolean });
    expect(schema.parse({ flag: '  true  ' })).toEqual({ flag: true });
    expect(schema.parse({ flag: '  false  ' })).toEqual({ flag: false });
  });

  it('validation_error message is clear on failure', () => {
    const schema = z.object({ flag: stringToBoolean });
    try {
      schema.parse({ flag: 'unknown' });
    } catch (e) {
      expect(e.issues[0].message).toContain('validation_error');
    }
  });
});

// ─── validationError helper ───────────────────────────────────────────────────

describe('validationError', () => {
  it('returns a ZodError with the correct structure', () => {
    const err = validationError('attendees', 'array of strings', 'not-an-array');
    expect(err).toBeInstanceOf(z.ZodError);
    expect(err.issues[0].code).toBe('custom');
    expect(err.issues[0].message).toContain('validation_error');
    expect(err.issues[0].message).toContain('attendees');
    expect(err.issues[0].message).toContain('array of strings');
    expect(err.issues[0].path).toEqual(['attendees']);
  });
});