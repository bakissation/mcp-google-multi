import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getOptionalBundles, resolveScopesForAccount, OPTIONAL_SCOPE_BUNDLES } from '../src/auth.js';

const PRESENTATIONS_SCOPE = 'https://www.googleapis.com/auth/presentations';

describe('optional scope bundles', () => {
  const saved = process.env.GOOGLE_OPTIONAL_SCOPES;

  beforeEach(() => {
    delete process.env.GOOGLE_OPTIONAL_SCOPES;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.GOOGLE_OPTIONAL_SCOPES;
    else process.env.GOOGLE_OPTIONAL_SCOPES = saved;
  });

  it('slides bundle grants exactly the presentations scope (read + write + thumbnails)', () => {
    expect(OPTIONAL_SCOPE_BUNDLES.slides).toEqual([PRESENTATIONS_SCOPE]);
  });

  it('forms bundle includes the forms.body write scope', () => {
    expect(OPTIONAL_SCOPE_BUNDLES.forms).toContain('https://www.googleapis.com/auth/forms.body');
  });

  it('GOOGLE_OPTIONAL_SCOPES=slides enables the slides bundle', () => {
    process.env.GOOGLE_OPTIONAL_SCOPES = 'slides';
    expect(getOptionalBundles()).toContain('slides');
    expect(resolveScopesForAccount('test')).toContain(PRESENTATIONS_SCOPE);
  });

  it('slides is disabled when GOOGLE_OPTIONAL_SCOPES is unset or lists other bundles', () => {
    expect(getOptionalBundles()).not.toContain('slides');
    expect(resolveScopesForAccount('test')).not.toContain(PRESENTATIONS_SCOPE);

    process.env.GOOGLE_OPTIONAL_SCOPES = 'forms,chat';
    expect(getOptionalBundles()).toEqual(['forms', 'chat']);
    expect(resolveScopesForAccount('test')).not.toContain(PRESENTATIONS_SCOPE);
  });

  it('parses CSV with whitespace and drops unknown bundle names', () => {
    process.env.GOOGLE_OPTIONAL_SCOPES = ' slides , forms ,bogus';
    expect(getOptionalBundles()).toEqual(['slides', 'forms']);
  });
});
