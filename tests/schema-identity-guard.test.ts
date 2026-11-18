import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import type { McpServer } from "@modelcontextprotocol/server";
import { ToolRegistry } from '../src/registry.js';
import { SERVICES } from '../src/services.js';
import { GENERATED_SERVICES } from '../src/tools/generated/index.js';
import { registerDiscoverTools } from '../src/discover.js';
import { registerEscapeTools } from '../src/tools/google-api.js';
import { registerAccountTools } from '../src/tools/accounts-tool.js';
import { registerDiagnoseTool } from '../src/doctor.js';
import { registerAccountWizardTools } from '../src/tools/account-wizard.js';
import type { Policy } from '../src/write-control.js';

// No tool argument may select whose identity/credentials to use; the verified JWT sub is the ONLY
// identity carrier; `account` only selects an alias WITHIN that authenticated context.

const FORBIDDEN = new Set([
  'tenantid', 'tenant_id', 'tenant',
  'sub', 'subjectid', 'subject_id',
  'owneremail', 'owner_email', 'owners_email',
  'user_google_email', 'usergoogleemail', 'google_email',
  'impersonate', 'impersonateuser', 'impersonate_user', 'onbehalfof', 'on_behalf_of',
  'principal', 'principal_id', 'principalid',
]);

const POLICY: Policy = { profile: 'read-only', readOnly: true, allow: [], deny: [] };

// Register every service directly, bypassing scope-bundle gates, so the guard scans the complete
// 900+ tool surface regardless of what the sandbox env enables.
function fullRegistry(): ToolRegistry {
  const stub = { registerTool: () => 'ok', sendToolListChanged: vi.fn(), server: { setRequestHandler: () => {}, getClientCapabilities: () => undefined } };
  const registry = new ToolRegistry(stub as never, POLICY, 'eager');
  for (const svc of SERVICES) svc.register(registry);
  for (const gen of GENERATED_SERVICES) gen.register(registry);
  registerDiscoverTools(registry, POLICY);
  registerEscapeTools(registry, POLICY);
  registerAccountTools(registry);
  registerDiagnoseTool(registry);
  registerAccountWizardTools(registry, stub as unknown as McpServer);
  return registry;
}

// Google's OWN params that look identity-shaped (Discovery path/query sent verbatim, gated by the
// account token's scopes), not an identity override; new entries must be tool.field exact and justified here.
const GOOGLE_API_PARAM_EXCEPTIONS = new Set<string>([]);

describe('static identity-field guard', () => {
  it('no registered tool declares an identity-shaped input field', () => {
    const registry = fullRegistry();
    expect(registry.tools.length).toBeGreaterThan(900);
    const offenders: string[] = [];
    for (const tool of registry.tools) {
      for (const key of Object.keys(tool.inputShape)) {
        if (FORBIDDEN.has(key.toLowerCase()) && !GOOGLE_API_PARAM_EXCEPTIONS.has(`${tool.name}.${key}`)) {
          offenders.push(`${tool.name}.${key}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the exception list carries no dead entries (every one still exists)', () => {
    const registry = fullRegistry();
    const declared = new Set(registry.tools.flatMap((t) => Object.keys(t.inputShape).map((k) => `${t.name}.${k}`)));
    for (const entry of GOOGLE_API_PARAM_EXCEPTIONS) {
      expect(declared.has(entry), `stale exception: ${entry}`).toBe(true);
    }
  });

  it('is load-bearing: a synthetic tool smuggling a tenantId field IS caught', () => {
    const captured: string[] = [];
    const stub = {
      registerTool: (name: string) => {
        captured.push(name);
        return 'ok';
      },
      sendToolListChanged: vi.fn(),
      server: { setRequestHandler: () => {} },
    };
    const registry = new ToolRegistry(stub as never, POLICY, 'eager');
    registry.registerTool(
      'evil_search',
      { description: 'smuggles identity', inputSchema: { tenantId: z.string(), account: z.string().optional() } },
      (async () => ({ content: [{ type: 'text' as const, text: 'x' }] })) as never,
    );
    const offenders = registry.tools.flatMap((t) => Object.keys(t.inputShape).filter((k) => FORBIDDEN.has(k.toLowerCase())).map((k) => `${t.name}.${k}`));
    expect(offenders).toEqual(['evil_search.tenantId']);
  });
});
