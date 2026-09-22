import { describe, it, expect } from 'vitest';
import { buildSetupText } from '../src/setup-prompt.js';

describe('buildSetupText (B8 setup prompt)', () => {
  it('states plainly that the Console steps have no creation API (BR9)', () => {
    const t = buildSetupText();
    expect(t).toMatch(/no creation API/i);
  });

  it('pre-explains the unverified-app scare before consent (BR10)', () => {
    const t = buildSetupText();
    expect(t).toMatch(/unverified app/i);
    expect(t).toMatch(/Advanced/);
  });

  it('warns about the 7-day Testing-mode trap and links In production', () => {
    const t = buildSetupText();
    expect(t).toMatch(/7[- ]day/i);
    expect(t).toContain('console.cloud.google.com/auth/audience');
  });

  it('carries the key per-step deep links', () => {
    const t = buildSetupText();
    expect(t).toContain('console.cloud.google.com/projectcreate');
    expect(t).toContain('console.cloud.google.com/apis/library');
    expect(t).toContain('console.cloud.google.com/auth/clients');
  });

  it('stdio default recommends a Desktop client', () => {
    expect(buildSetupText()).toMatch(/Desktop app/);
  });

  it('with a publicUrl, recommends a Web client with the /callback redirect', () => {
    const t = buildSetupText({ publicUrl: 'https://mcp.example.com/' });
    expect(t).toMatch(/Web application/);
    expect(t).toContain('https://mcp.example.com/callback'); // trailing slash trimmed
  });

  it('never leaks a literal secret placeholder as a real value', () => {
    const t = buildSetupText();
    expect(t).toContain('GOOGLE_CLIENT_ID');
    expect(t).toContain('GOOGLE_CLIENT_SECRET');
    expect(t).toMatch(/never in `config.json`/i);
  });
});
