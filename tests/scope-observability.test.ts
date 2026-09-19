import { describe, it, expect } from 'vitest';
import {
  classifyScope,
  classifyMethodScopes,
  scopeHint,
  scopeHintForMethod,
  buildScopesReport,
} from '../src/scope-observability.js';
import { ADMIN_SCOPES, BUNDLE_CATALOG } from '../src/scope-catalog.js';
import { deriveAccountHealth } from '../src/tools/accounts-tool.js';

const FORMS_BODY = 'https://www.googleapis.com/auth/forms.body';
const GMAIL_MODIFY = 'https://www.googleapis.com/auth/gmail.modify';

describe('classifyScope (three-state)', () => {
  const granted = new Set([GMAIL_MODIFY]);
  const profile = new Set([GMAIL_MODIFY, FORMS_BODY]);

  it('granted -> callable', () => {
    expect(classifyScope(GMAIL_MODIFY, granted, profile).state).toBe('callable');
  });

  it('in profile, not granted -> requestable_not_granted', () => {
    expect(classifyScope(FORMS_BODY, granted, profile).state).toBe('requestable_not_granted');
  });

  it('in catalog, not in profile -> not_requestable{add_bundle} naming the narrowest bundle', () => {
    const c = classifyScope('https://www.googleapis.com/auth/presentations', granted, profile);
    expect(c).toMatchObject({ state: 'not_requestable', reason: 'add_bundle', bundle: 'slides' });
  });

  it('unknown scope -> not_requestable{unknown_scope}', () => {
    const c = classifyScope('https://www.googleapis.com/auth/made-up', granted, profile);
    expect(c).toMatchObject({ state: 'not_requestable', reason: 'unknown_scope' });
  });
});

describe('classifyMethodScopes (Discovery scopes are ANY-OF alternatives)', () => {
  const CHAT_MESSAGES = 'https://www.googleapis.com/auth/chat.messages';
  const CHAT_BOT = 'https://www.googleapis.com/auth/chat.bot';

  it('any single granted alternative makes the method callable', () => {
    const c = classifyMethodScopes([CHAT_BOT, GMAIL_MODIFY], new Set([GMAIL_MODIFY]), new Set());
    expect(c?.state).toBe('callable');
    expect(c?.scope).toBe(GMAIL_MODIFY);
  });

  it('FLAGSHIP: an unknown alternative (chat.bot) never masks a requestable one', () => {
    // Bundle in profile, unchecked at consent: the standard add-then-re-auth flow.
    const c = classifyMethodScopes([CHAT_BOT, CHAT_MESSAGES], new Set(), new Set([CHAT_MESSAGES]));
    expect(c?.state).toBe('requestable_not_granted');
    expect(c?.scope).toBe(CHAT_MESSAGES);
  });

  it('hint and classification always refer to the SAME scope', () => {
    const BASIC = 'https://www.googleapis.com/auth/gmail.settings.basic';
    const SHARING = 'https://www.googleapis.com/auth/gmail.settings.sharing';
    // basic in profile (unchecked), sharing not in profile: best = requestable basic.
    const c = classifyMethodScopes([BASIC, SHARING], new Set(), new Set([BASIC]));
    expect(c?.scope).toBe(BASIC);
    expect(c?.state).toBe('requestable_not_granted');
  });
});

describe('remediation hints (gh-CLI style, honest retriable)', () => {
  it('requestable: re-auth same account, retriable', () => {
    const h = scopeHint(FORMS_BODY, { state: 'requestable_not_granted' }, 'work');
    expect(h.hint).toContain('auth --account work');
    expect(h.retriable).toBe(true);
  });

  it('add_bundle: names the bundle and config.json, not retriable', () => {
    const h = scopeHint(FORMS_BODY, { state: 'not_requestable', reason: 'add_bundle', bundle: 'forms' }, 'work');
    expect(h.hint).toContain('"forms"');
    expect(h.hint).toContain('config.json');
    expect(h.retriable).toBe(false);
  });

  it('unknown: says stop retrying', () => {
    const h = scopeHint('https://x/y', { state: 'not_requestable', reason: 'unknown_scope' }, 'work');
    expect(h.hint).toContain('Do not retry');
    expect(h.retriable).toBe(false);
  });
});

describe('scopeHintForMethod (runtime 403 enrichment)', () => {
  const deps = {
    readTokenFn: () => ({ scope: GMAIL_MODIFY, refresh_token: 'r' }),
    profileFn: () => [GMAIL_MODIFY, FORMS_BODY, ...ADMIN_SCOPES],
  };

  it('state-2 scope produces a re-auth hint', () => {
    const h = scopeHintForMethod([FORMS_BODY], 'work', deps);
    expect(h?.retriable).toBe(true);
    expect(h?.hint).toContain('auth --account work');
  });

  it('admin scope IN profile but 403ing -> hedged re-auth hint (never a fabricated dead end)', () => {
    const h = scopeHintForMethod([ADMIN_SCOPES[0]], 'maybe-workspace', deps);
    expect(h?.retriable).toBe(true);
    expect(h?.hint).toContain('auth --account maybe-workspace');
    expect(h?.hint).toContain('Workspace alias');
  });

  it('base scope excluded by includesBase:false -> includesBase remediation, never "add base bundle"', () => {
    const h = scopeHintForMethod([GMAIL_MODIFY], 'minimal', {
      readTokenFn: () => ({ scope: '', refresh_token: 'r' }),
      profileFn: () => [],
    });
    expect(h?.hint).toContain('includesBase');
    expect(h?.hint).not.toContain('"base" bundle');
    expect(h?.retriable).toBe(false);
  });

  it('null when the token is unreadable (falls back to the generic hint)', () => {
    expect(
      scopeHintForMethod([FORMS_BODY], 'work', { ...deps, readTokenFn: () => { throw new Error('decrypt'); } }),
    ).toBeNull();
  });
});

describe('buildScopesReport / account_list block', () => {
  it('classifies the compact profile∪granted universe with v5-compatible missing', () => {
    const granted = new Set([GMAIL_MODIFY]);
    const profile = new Set([GMAIL_MODIFY, FORMS_BODY]);
    const r = buildScopesReport(granted, profile);
    expect(r.callable).toEqual([GMAIL_MODIFY]);
    expect(r.requestable).toEqual([FORMS_BODY]);
    expect(r.missing).toEqual([FORMS_BODY]);
    expect(r.notRequestable.addBundle).toEqual([]);
  });

  it('registered tool scopes outside the profile classify as add_bundle with the bundle name', () => {
    const r = buildScopesReport(new Set(), new Set([GMAIL_MODIFY]), BUNDLE_CATALOG.slides.scopes);
    expect(r.notRequestable.addBundle).toEqual([
      { scope: 'https://www.googleapis.com/auth/presentations', bundle: 'slides' },
    ]);
  });

  it('deriveAccountHealth emits the extended block', () => {
    const health = deriveAccountHealth('test', {
      hasToken: () => true,
      readToken: () => ({ scope: GMAIL_MODIFY, refresh_token: 'r', expiry_date: Date.now() + 60000 }),
      fileExists: () => false,
      now: Date.now,
    });
    expect(health.scopes.callable).toContain(GMAIL_MODIFY);
    expect(Array.isArray(health.scopes.requestable)).toBe(true);
    expect(health.scopes.notRequestable).toBeDefined();
  });
});
