import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { coerceArray, coerceJson, coerceBoolean, coerceNumber } from '../src/tools/_coerce.js';

describe('coerceArray', () => {
  const s = coerceArray(z.string());
  it('passes arrays through', () => expect(s.parse(['a', 'b'])).toEqual(['a', 'b']));
  it('splits comma strings', () => expect(s.parse('a, b ,c')).toEqual(['a', 'b', 'c']));
  it('parses JSON arrays', () => expect(s.parse('["x","y"]')).toEqual(['x', 'y']));
  it('treats empty string as empty array', () => expect(s.parse('')).toEqual([]));
  it('validates element types', () => {
    const e = coerceArray(z.enum(['r', 'w']));
    expect(e.parse('r,w')).toEqual(['r', 'w']);
    expect(e.safeParse('x').success).toBe(false);
  });
});

describe('coerceJson', () => {
  const o = coerceJson(z.record(z.string(), z.unknown()));
  it('passes objects through', () => expect(o.parse({ a: 1 })).toEqual({ a: 1 }));
  it('parses JSON object strings', () => expect(o.parse('{"a":1}')).toEqual({ a: 1 }));
  it('fails on non-JSON strings', () => expect(o.safeParse('nope').success).toBe(false));
  it('coerces 2D arrays from a JSON string', () => {
    const grid = coerceJson(z.array(z.array(z.any())));
    expect(grid.parse('[[1,2],[3,4]]')).toEqual([[1, 2], [3, 4]]);
  });
});

describe('coerceBoolean', () => {
  it('passes booleans through', () => {
    expect(coerceBoolean.parse(true)).toBe(true);
    expect(coerceBoolean.parse(false)).toBe(false);
  });
  it('coerces truthy strings', () => {
    for (const v of ['true', '1', 'yes', 'Y']) expect(coerceBoolean.parse(v)).toBe(true);
  });
  it('coerces falsy strings', () => {
    for (const v of ['false', '0', 'no', 'N']) expect(coerceBoolean.parse(v)).toBe(false);
  });
  it('rejects nonsense', () => expect(coerceBoolean.safeParse('maybe').success).toBe(false));
});

describe('coerceNumber', () => {
  const schema = coerceNumber(z.number().min(1).max(100));
  it('passes numbers through', () => expect(schema.parse(5)).toBe(5));
  it('coerces numeric strings (stdio has no arg-normalization layer)', () => {
    expect(schema.parse('5')).toBe(5);
    expect(schema.parse(' 20 ')).toBe(20);
  });
  it('still enforces the inner bounds after coercion', () => {
    expect(schema.safeParse('0').success).toBe(false);
    expect(schema.safeParse('101').success).toBe(false);
  });
  it('rejects non-numeric strings and empty strings', () => {
    expect(schema.safeParse('five').success).toBe(false);
    expect(schema.safeParse('').success).toBe(false);
  });
});
