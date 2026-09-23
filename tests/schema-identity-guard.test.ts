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

// S1.22: the #1001 failure mode (a tool argument, not the verified session,
// selects whose identity/credentials to use) closed PERMANENTLY: no
// registered tool - curated, generated, or meta - may declare an
// identity-shaped input field. The verified JWT sub is the ONLY identity
// carrier; `account` selects an alias WITHIN the authenticated context.

const FORBIDDEN = new Set([
  'tenantid', 'tenant_id', 'tenant',
  'sub', 'subjectid', 'subject_id',
  'owneremail', 'owner_email', 'owners_email',
  'user_google_email', 'usergoogleemail', 'google_email',
  'impersonate', 'impersonateuser', 'impersonate_user', 'onbehalfof', 'on_behalf_of',
  'principal', 'principal_id', 'principalid',
]);

const POLICY: Policy = { profile: 'read-only', readOnly: true, allow: [], deny: [] };

// The surface-honesty pattern: register EVERY service directly, bypassing the
// scope-bundle gates, so the guard scans the complete 900+ tool surface
// regardless of what the sandbox env enables.
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

// Google's OWN API parameters that happen to carry an identity-shaped name.
// These are Discovery path/query params sent verbatim to the Google endpoint
// (a resource selector WITHIN the caller's authorized account, gated by the
// account token's scopes) - not an MCP-level identity override. Each entry is
// tool.field exact; anything new must be justified here or it fails the guard.
const GOOGLE_API_PARAM_EXCEPTIONS = new Set([
  'workspaceevents_tasks_cancel.tenant',
  'workspaceevents_tasks_get.tenant',
  'workspaceevents_tasks_push_notification_configs_create.tenant',
  'workspaceevents_tasks_push_notification_configs_delete.tenant',
  'workspaceevents_tasks_push_notification_configs_get.tenant',
  'workspaceevents_tasks_push_notification_configs_list.tenant',
  'workspaceevents_tasks_subscribe.tenant',
]);

describe('static identity-field guard (S1.22, #1001)', () => {
  it('no registered tool declares an identity-shaped input field', () => {
    const registry = fullRegistry();
    expect(registry.tools.length).toBeGreaterThan(900); // the FULL surface, nothing gated off
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
