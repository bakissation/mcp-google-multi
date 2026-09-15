import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { resolveAccounts, invalidateAccountSet } from '../src/accounts.js';
import { ToolRegistry } from '../src/registry.js';
import type { Policy } from '../src/write-control.js';

const POLICY: Policy = { profile: 'full-writes', readOnly: false, allow: [], deny: [] };

let base: string;
let cfgPath: string;

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), 'defacct-'));
  cfgPath = path.join(base, 'config.json');
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  delete process.env.GOOGLE_DEFAULT_ACCOUNT;
  invalidateAccountSet();
  vi.restoreAllMocks();
});

describe('default resolution (env > config > unset)', () => {
  it('env wins over the config field', () => {
    writeFileSync(
      cfgPath,
      JSON.stringify({ version: 1, accounts: { a: { email: 'a@x.com' }, b: { email: 'b@x.com' } }, defaultAccount: 'a' }),
    );
    const set = resolveAccounts({ GOOGLE_DEFAULT_ACCOUNT: 'b' } as NodeJS.ProcessEnv, cfgPath);
    expect(set.defaultAccount).toBe('b');
    expect(set.defaultAccountSource).toBe('env');
  });

  it('config field applies when env is unset', () => {
    writeFileSync(
      cfgPath,
      JSON.stringify({ version: 1, accounts: { a: { email: 'a@x.com' } }, defaultAccount: 'a' }),
    );
    const set = resolveAccounts({} as NodeJS.ProcessEnv, cfgPath);
    expect(set.defaultAccount).toBe('a');
    expect(set.defaultAccountSource).toBe('config');
  });

  it('unset default leaves the field absent', () => {
    writeFileSync(cfgPath, JSON.stringify({ version: 1, accounts: { a: { email: 'a@x.com' } } }));
    expect(resolveAccounts({} as NodeJS.ProcessEnv, cfgPath).defaultAccount).toBeUndefined();
  });

  it('E_DEFAULT_ACCOUNT_UNKNOWN fails fast on an unknown alias (throw mode: reload-safe)', () => {
    writeFileSync(
      cfgPath,
      JSON.stringify({ version: 1, accounts: { a: { email: 'a@x.com' } }, defaultAccount: 'ghost' }),
    );
    expect(() => resolveAccounts({} as NodeJS.ProcessEnv, cfgPath, 'throw')).toThrow(
      /E_DEFAULT_ACCOUNT_UNKNOWN.*"ghost"/,
    );
  });
});

describe('withDefaultAccount injection matrix (single dispatch site)', () => {
  async function callWith(defaultEnv: string | undefined, args: Record<string, unknown>) {
    if (defaultEnv === undefined) delete process.env.GOOGLE_DEFAULT_ACCOUNT;
    else process.env.GOOGLE_DEFAULT_ACCOUNT = defaultEnv;
    invalidateAccountSet();
    const seen: unknown[] = [];
    let registered: (...a: unknown[]) => unknown = () => {};
    const server = { registerTool: (_n: string, _c: never, h: never) => { registered = h as never; return 'ok'; }, sendToolListChanged: vi.fn(), server: { setRequestHandler: () => {} } };
    const reg = new ToolRegistry(server as never, POLICY, 'lazy');
    reg.registerTool(
      'gmail_probe_read',
      { description: 'x', inputSchema: { account: z.string().optional() } },
      async (a: Record<string, unknown>) => { seen.push(a.account); return { content: [{ type: 'text' as const, text: '{}' }] }; },
    );
    const res = await registered(args);
    return { seen, res };
  }

  it('omitted -> default injected', async () => {
    const { seen } = await callWith('test', {});
    expect(seen).toEqual(['test']);
  });

  it("'' -> default injected", async () => {
    const { seen } = await callWith('test', { account: '' });
    expect(seen).toEqual(['test']);
  });

  it('explicit alias untouched', async () => {
    const { seen } = await callWith('test', { account: 'other' });
    expect(seen).toEqual(['other']);
  });

  it('omitted with NO default -> E_NO_DEFAULT_ACCOUNT isError result', async () => {
    const { seen, res } = await callWith(undefined, {});
    expect(seen).toEqual([]);
    const payload = JSON.parse((res as { content: { text: string }[] }).content[0].text);
    expect(payload.error).toBe('E_NO_DEFAULT_ACCOUNT');
    expect(payload.hint).toContain('GOOGLE_DEFAULT_ACCOUNT');
    expect((res as { isError: boolean }).isError).toBe(true);
  });

  it('tools without an account field are untouched', async () => {
    delete process.env.GOOGLE_DEFAULT_ACCOUNT;
    invalidateAccountSet();
    let registered: (...a: unknown[]) => unknown = () => {};
    const server = { registerTool: (_n: string, _c: never, h: never) => { registered = h as never; return 'ok'; }, sendToolListChanged: vi.fn(), server: { setRequestHandler: () => {} } };
    const reg = new ToolRegistry(server as never, POLICY, 'lazy');
    reg.registerTool('util_probe', { description: 'x', inputSchema: { q: z.string() } }, async () => ({ content: [{ type: 'text' as const, text: '"ok"' }] }));
    const res = await registered({ q: 'x' });
    expect((res as { isError?: boolean }).isError).toBeUndefined();
  });
});
