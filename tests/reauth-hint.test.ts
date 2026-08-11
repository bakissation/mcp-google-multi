import { describe, it, expect, afterEach } from 'vitest';
import { setHttpReauthBase, reauthHint } from '../src/reauth-hint.js';

afterEach(() => setHttpReauthBase(null));

describe('reauthHint (BV-1)', () => {
  it('defaults to the stdio auth CLI', () => {
    setHttpReauthBase(null);
    expect(reauthHint('personal')).toBe('Run: npx mcp-google-multi auth --account personal');
  });
  it('becomes a clickable AS re-auth link once the HTTP base is set', () => {
    setHttpReauthBase('https://mcp.example.com');
    const h = reauthHint('personal');
    expect(h).toContain('https://mcp.example.com/authorize?flow=alias_reauth&alias=personal');
  });
  it('url-encodes the alias', () => {
    setHttpReauthBase('https://mcp.example.com');
    expect(reauthHint('a b')).toContain('alias=a%20b');
  });
});
