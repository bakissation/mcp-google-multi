import { describe, it, expect, afterEach } from 'vitest';
import { setHttpReauthLink, reauthHint } from '../src/reauth-hint.js';

afterEach(() => setHttpReauthLink(null));

describe('reauthHint (BV-1)', () => {
  it('defaults to the stdio auth CLI', () => {
    setHttpReauthLink(null);
    expect(reauthHint('personal')).toBe('Run: npx mcp-google-multi auth --account personal');
  });
  it('becomes the server-signed re-auth link once the HTTP linker is set', () => {
    const asked: string[] = [];
    setHttpReauthLink((alias) => {
      asked.push(alias);
      return `https://mcp.example.com/authorize?flow=alias_reauth&alias=${encodeURIComponent(alias)}&exp=1&sig=s`;
    });
    expect(reauthHint('a b')).toBe('Re-authenticate "a b" in your browser, then retry: https://mcp.example.com/authorize?flow=alias_reauth&alias=a%20b&exp=1&sig=s');
    expect(asked).toEqual(['a b']);
  });
});
