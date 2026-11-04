import { describe, it, expect } from 'vitest';
import { BUNDLE_CATALOG, homeDomains, isPersonalGoogleAddress, orgOnlyRefusal, refusedBundlesFor } from '../src/scope-catalog.js';

describe('personal-account bundle refusals', () => {
  it('only gmail.com and googlemail.com count as personal addresses', () => {
    for (const e of ['a@gmail.com', 'A@GMAIL.COM', ' a@googlemail.com ']) expect(isPersonalGoogleAddress(e), e).toBe(true);
    for (const e of ['a@example.com', 'a@gmail.com.example.com', 'gmail.com@example.com', 'a@mail.gmail.co']) expect(isPersonalGoogleAddress(e), e).toBe(false);
  });

  it('keep and cloudidentity are the refused bundles, and only for a personal address', () => {
    const all = Object.keys(BUNDLE_CATALOG);
    expect(refusedBundlesFor('a@gmail.com', all).sort()).toEqual(['cloudidentity', 'keep']);
    expect(refusedBundlesFor('a@example.com', all)).toEqual([]);
    expect(refusedBundlesFor('a@gmail.com', ['forms', 'toString', 'nope'])).toEqual([]);
  });
});

describe('external-organisation bundle refusals (GOOGLE_HOME_DOMAINS)', () => {
  const all = Object.keys(BUNDLE_CATALOG);
  const home = ['ideacrafters.com', 'ic.example'];

  it('parses the setting: comma list, trimmed, lower-cased, optional leading @, empty when unset', () => {
    expect(homeDomains({})).toEqual([]);
    expect(homeDomains({ GOOGLE_HOME_DOMAINS: ' IdeaCrafters.com, @ic.example ,' })).toEqual(['ideacrafters.com', 'ic.example']);
  });

  it('refuses keep and cloudidentity for a Workspace address outside the home organisation', () => {
    expect(refusedBundlesFor('dounia@le2.agency', all, home).sort()).toEqual(['cloudidentity', 'keep']);
    expect(orgOnlyRefusal('dounia@le2.agency', home)).toBe('external');
  });

  it('keeps them for an address in any home domain, whatever its case', () => {
    expect(refusedBundlesFor('baki@ideacrafters.com', all, home)).toEqual([]);
    expect(refusedBundlesFor('Baki@IC.Example', all, home)).toEqual([]);
    expect(orgOnlyRefusal('baki@ideacrafters.com', home)).toBeNull();
  });

  it('a subdomain or look-alike of a home domain is external', () => {
    expect(refusedBundlesFor('a@mail.ideacrafters.com', ['keep'], home)).toEqual(['keep']);
    expect(refusedBundlesFor('a@ideacrafters.com.evil.test', ['keep'], home)).toEqual(['keep']);
  });

  it('with no home organisation configured nothing changes: only personal addresses are refused', () => {
    expect(refusedBundlesFor('dounia@le2.agency', all, [])).toEqual([]);
    expect(refusedBundlesFor('a@gmail.com', all, []).sort()).toEqual(['cloudidentity', 'keep']);
    expect(orgOnlyRefusal('a@gmail.com', home)).toBe('personal');
  });

  it('only flags the bundles Google was shown to refuse', () => {
    const orgOnly = Object.entries(BUNDLE_CATALOG).filter(([, e]) => e.orgOnly).map(([n]) => n).sort();
    expect(orgOnly).toEqual(['cloudidentity', 'keep']);
  });
});
