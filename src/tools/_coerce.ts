import { z } from 'zod';

function parseJsonLoose(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

export function coerceArray<T extends z.ZodTypeAny>(element: T) {
  return z.preprocess((val) => {
    if (typeof val !== 'string') return val;
    const t = val.trim();
    if (t === '') return [];
    if (t.startsWith('[')) return parseJsonLoose(t);
    return t.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  }, z.array(element));
}

export function coerceJson<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((val) => (typeof val === 'string' ? parseJsonLoose(val) : val), schema);
}

export const coerceBoolean = z.preprocess((val) => {
  if (typeof val === 'boolean') return val;
  if (typeof val === 'string') {
    const t = val.trim().toLowerCase();
    if (['true', '1', 'yes', 'y'].includes(t)) return true;
    if (['false', '0', 'no', 'n'].includes(t)) return false;
  }
  return val;
}, z.boolean());
