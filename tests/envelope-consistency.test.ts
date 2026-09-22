import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateAddForm } from '../src/tools/account-wizard.js';
import { writeDisabledResult } from '../src/write-control.js';
import { invalidParams } from '../src/tools/_errors.js';
import { KNOWN_ERROR_SLUGS } from '../src/usage-metrics.js';
import type { Account } from '../src/accounts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, '..', 'src');

function readAll(dir: string, out: { file: string; src: string }[] = []) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) readAll(p, out);
    else if (f.name.endsWith('.ts')) out.push({ file: p, src: fs.readFileSync(p, 'utf-8') });
  }
  return out;
}

describe('no handler puts prose in the error slug', () => {
  // `error` is a machine-readable slug. A sentence there means a client cannot
  // branch on it and metrics buckets every distinct wording separately.
  it('every error literal across src/ is a single slug token', () => {
    const offenders: string[] = [];
    for (const { file, src } of readAll(SRC)) {
      for (const m of src.matchAll(/error: '([^']{2,})'/g)) {
        if (/[ .]/.test(m[1])) offenders.push(`${path.basename(file)}: ${m[1].slice(0, 60)}`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});

describe('wizard failures are envelopes, not prose', () => {
  it('validateAddForm splits the message from the recovery hint', () => {
    const r = validateAddForm({ alias: 'has space', email: 'a@b.com' }, []);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // The message states the fault; the hint states the fix. Concatenating
      // them is what made these unusable as structured errors.
      expect(r.message).not.toContain('Use letters');
      expect(r.hint).toContain('Use letters');
      expect(KNOWN_ERROR_SLUGS.has(r.slug)).toBe(true);
    }
  });

  it('carries the alias so a fan-out merge can attribute the failure', () => {
    const r = validateAddForm({ alias: 'ic', email: 'a@b.com' }, ['ic']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.alias).toBe('ic');
  });
});

describe('write_disabled names the account it refused', () => {
  const policy = { profile: 'read-only' as const, readOnly: false, allow: [], deny: [] };

  it('includes the account when dispatch knows it', () => {
    const r = writeDisabledResult({ name: 'gmail_send', service: 'gmail', cud: 'create' }, policy, 'work');
    expect(JSON.parse(r.content[0].text).account).toBe('work');
  });

  // google_api_call's policy self-check can refuse before an alias resolves.
  it('omits it rather than inventing one when there is none', () => {
    const r = writeDisabledResult({ name: 'gmail_send', service: 'gmail', cud: 'create' }, policy);
    expect('account' in JSON.parse(r.content[0].text)).toBe(false);
  });
});

describe('invalidParams', () => {
  it('tolerates an unresolved account instead of emitting the string "undefined"', () => {
    const r = invalidParams(undefined, 'Bad input.', 'Fix it.');
    const env = JSON.parse(r.content[0].text);
    expect(env.account).toBeUndefined();
    expect(env.retriable).toBe(false);
    expect(r.isError).toBe(true);
  });

  it('keeps the account when one is known', () => {
    const env = JSON.parse(invalidParams('work' as Account, 'Bad input.', 'Fix it.').content[0].text);
    expect(env.account).toBe('work');
  });
});
