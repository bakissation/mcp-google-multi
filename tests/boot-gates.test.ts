import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  accountsAssertRequired,
  assertNoEnvAccountsMode,
  assertNoEnvOptionalScopesMode,
  isMultiTenantBoot,
  mtBootGates,
  setMtBootGates,
} from '../src/boot-gates.js';

afterEach(() => {
  setMtBootGates(null);
  vi.restoreAllMocks();
});

const spyExit = () => {
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('exit-called');
  });
  return { stderr, exit };
};

describe('boot gates (S1.16)', () => {
  it('no gates installed = free core: not multi-tenant, no gate object', () => {
    expect(isMultiTenantBoot()).toBe(false);
    expect(mtBootGates()).toBeNull();
  });

  it('installed gates are visible and clearable', () => {
    const assertProvisioningGate = vi.fn();
    setMtBootGates({ multiTenant: true, assertProvisioningGate });
    expect(isMultiTenantBoot()).toBe(true);
    mtBootGates()!.assertProvisioningGate();
    expect(assertProvisioningGate).toHaveBeenCalledOnce();
    setMtBootGates(null);
    expect(isMultiTenantBoot()).toBe(false);
  });

  it('accountsAssertRequired truth table: stdio always asserts; HTTP asserts only when single-owner', () => {
    expect(accountsAssertRequired(true, false)).toBe(true); // stdio, free core
    expect(accountsAssertRequired(true, true)).toBe(true); // stdio leg of "both" under MT still asserts
    expect(accountsAssertRequired(false, false)).toBe(true); // single-owner HTTP
    expect(accountsAssertRequired(false, true)).toBe(false); // MT HTTP boots empty
  });

  it('assertNoEnvAccountsMode fails fast when GOOGLE_ACCOUNTS is set, no-ops otherwise', () => {
    const { stderr } = spyExit();
    expect(() => assertNoEnvAccountsMode({ GOOGLE_ACCOUNTS: 'a:a@x.example' } as NodeJS.ProcessEnv)).toThrow('exit-called');
    expect(String(stderr.mock.calls[0]?.[0])).toContain('E_ENV_ACCOUNTS_MODE_MT');
    expect(() => assertNoEnvAccountsMode({} as NodeJS.ProcessEnv)).not.toThrow();
    expect(() => assertNoEnvAccountsMode({ GOOGLE_ACCOUNTS: '  ' } as NodeJS.ProcessEnv)).not.toThrow();
  });

  it('assertNoEnvOptionalScopesMode refuses the second cross-tenant env vector the same way', () => {
    const { stderr } = spyExit();
    expect(() => assertNoEnvOptionalScopesMode({ GOOGLE_OPTIONAL_SCOPES: 'forms' } as NodeJS.ProcessEnv)).toThrow('exit-called');
    expect(String(stderr.mock.calls[0]?.[0])).toContain('E_ENV_OPTIONAL_SCOPES_MT');
    expect(() => assertNoEnvOptionalScopesMode({} as NodeJS.ProcessEnv)).not.toThrow();
  });
});
