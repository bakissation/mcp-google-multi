// S1.16: multi-tenant boot gates. The free core never sets these — every
// helper reduces to today's single-owner behavior when no gates are
// installed. Deliberately a side-effect-free module (accounts.ts/auth.ts
// resolve env at import time) so the tenancy module can import it cheaply.

import { failStartup } from './config-file.js';

export interface MtBootGates {
  /** True = multi-tenant deployment: the server boots with zero accounts
   * (tenants provision in-band) and the provisioning gate below replaces the
   * flat owner-allowlist requirement. */
  multiTenant: boolean;
  /** Fail-fast replacement for the E_OWNER_EMAILS_REQUIRED check. MUST refuse
   * (exit/throw) when no valid provisioning mechanism is configured — an
   * ungated HTTP endpoint must never boot, whatever the condition checked. */
  assertProvisioningGate: () => void;
}

let gates: MtBootGates | null = null;

export function setMtBootGates(g: MtBootGates | null): void {
  gates = g;
}

export function mtBootGates(): MtBootGates | null {
  return gates;
}

export function isMultiTenantBoot(): boolean {
  return gates?.multiTenant === true;
}

/** BR-4 applies to stdio always, and to HTTP only when single-owner: a
 * multi-tenant HTTP deploy starts empty by design. */
export function accountsAssertRequired(wantStdio: boolean, multiTenant: boolean): boolean {
  return wantStdio || !multiTenant;
}

/** A set GOOGLE_ACCOUNTS on a multi-tenant boot is refused at DEPLOY time:
 * the env registry is process-wide, so it would graft one operator's accounts
 * onto every tenant and turn every tenant's first wizard call into a dead
 * end (the per-call E_ENV_ACCOUNTS_MODE guard), N confusing failures instead
 * of one clear one. */
export function assertNoEnvAccountsMode(env: NodeJS.ProcessEnv = process.env): void {
  if (env.GOOGLE_ACCOUNTS?.trim()) {
    failStartup(
      'E_ENV_ACCOUNTS_MODE_MT',
      'GOOGLE_ACCOUNTS must not be set on a multi-tenant deployment; accounts are linked in-band per tenant. Unset it and restart.',
    );
  }
}

/** Same class, second vector: GOOGLE_OPTIONAL_SCOPES is a process-wide legacy
 * global scope profile, so on a multi-tenant box one operator's scope choice
 * would silently apply to every tenant's consent. */
export function assertNoEnvOptionalScopesMode(env: NodeJS.ProcessEnv = process.env): void {
  if (env.GOOGLE_OPTIONAL_SCOPES?.trim()) {
    failStartup(
      'E_ENV_OPTIONAL_SCOPES_MT',
      'GOOGLE_OPTIONAL_SCOPES must not be set on a multi-tenant deployment; scopes are chosen per tenant at consent. Unset it and restart.',
    );
  }
}
