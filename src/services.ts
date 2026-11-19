import type { AccountSet } from './accounts.js';
import type { CuratedToolDeps } from './client.js';
import { registerGmailTools } from './tools/gmail.js';
import { registerDriveTools } from './tools/drive.js';
import { registerCalendarTools } from './tools/calendar.js';
import { registerSheetsTools } from './tools/sheets.js';
import { registerDocsTools } from './tools/docs.js';
import { registerContactsTools } from './tools/contacts.js';
import { registerSearchConsoleTools } from './tools/searchconsole.js';
import { registerTasksTools } from './tools/tasks.js';
import { registerMeetTools } from './tools/meet.js';
import { registerSlidesTools } from './tools/slides.js';
import { registerFormsTools } from './tools/forms.js';
import { registerClassroomTools } from './tools/classroom.js';
import { registerChatTools } from './tools/chat.js';
import { registerAdminTools } from './tools/admin.js';
import { registerAnalyticsTools } from './tools/analytics.js';
import { getOptionalBundles, getAdminAccounts } from './auth.js';
import { serviceOf, type ToolRegistry } from './registry.js';
import { getToolsets, toolsetEnabled } from './toolsets.js';
import { GENERATED_SERVICES } from './tools/generated/index.js';
import { suggestKeys } from './arg-strict.js';
import { sliceClean } from './trim.js';
import { hints } from './hint-provider.js';

export interface ServiceEntry {
  name: string;
  register: (registry: ToolRegistry, deps?: CuratedToolDeps) => void;
  /** Absent = always on. Gates evaluate against the PASSED account set (the
   * calling tenant's view); omitted set = the global registry, today's
   * behavior. */
  enabled?: (set?: AccountSet) => boolean;
}

export const SERVICES: ServiceEntry[] = [
  { name: 'gmail', register: registerGmailTools },
  { name: 'drive', register: registerDriveTools },
  { name: 'calendar', register: registerCalendarTools },
  { name: 'sheets', register: registerSheetsTools },
  { name: 'docs', register: registerDocsTools },
  { name: 'contacts', register: registerContactsTools },
  { name: 'searchconsole', register: registerSearchConsoleTools },
  { name: 'tasks', register: registerTasksTools },
  { name: 'meet', register: registerMeetTools },
  { name: 'slides', register: registerSlidesTools, enabled: (set) => new Set(getOptionalBundles(set)).has('slides') },
  { name: 'classroom', register: registerClassroomTools, enabled: (set) => { const b = new Set(getOptionalBundles(set)); return b.has('classroom') || b.has('classroom_readonly'); } },
  { name: 'forms', register: registerFormsTools, enabled: (set) => new Set(getOptionalBundles(set)).has('forms') },
  { name: 'chat', register: registerChatTools, enabled: (set) => new Set(getOptionalBundles(set)).has('chat') },
  { name: 'analytics', register: registerAnalyticsTools, enabled: (set) => { const b = new Set(getOptionalBundles(set)); return b.has('analytics') || b.has('analytics_write'); } },
  { name: 'admin', register: registerAdminTools, enabled: (set) => getAdminAccounts(set).length > 0 },
];

// Generated-only services with opt-in scopes; admin/forms/chat/analytics reuse their curated gate in buildRegistry,
// and workspaceevents is deliberately absent — no dedicated scope (subscriptions use resource scopes).
const bundleGate = (name: string) => ({
  enabled: (set?: AccountSet) => new Set(getOptionalBundles(set)).has(name),
  hint: `add "${name}" to an account's scope profile (or legacy GOOGLE_OPTIONAL_SCOPES)`,
});
export const GENERATED_GATES: Record<string, { enabled: (set?: AccountSet) => boolean; hint: string }> = {
  appsmarket: bundleGate('appsmarket'),
  classroom: {
    enabled: (set?: AccountSet) => {
      const b = new Set(getOptionalBundles(set));
      return b.has('classroom') || b.has('classroom_readonly');
    },
    hint: `add "classroom" (or "classroom_readonly" to read only) to an account's scope profile (or legacy GOOGLE_OPTIONAL_SCOPES)`,
  },
  cloudidentity: bundleGate('cloudidentity'),
  cloudsearch: bundleGate('cloudsearch'),
  driveactivity: bundleGate('driveactivity'),
  drivelabels: bundleGate('drivelabels'),
  groupsmigration: bundleGate('groupsmigration'),
  groupssettings: bundleGate('groupssettings'),
  keep: bundleGate('keep'),
  licensing: bundleGate('licensing'),
  postmaster: bundleGate('postmaster'),
  reseller: bundleGate('reseller'),
  script: bundleGate('script'),
  vault: bundleGate('vault'),
};

const MAX_TOOL_NAME_ECHO = 64;

/** Message for a `tools/call` naming a tool that is not registered: the SDK's
 * bare "Tool X not found" reads identically for a typo, a gated service, and
 * an unknown API, but the server knows which is which from its boot-time enabled-service list. */
export function unknownToolMessage(registry: ToolRegistry, rawName: string): string {
  // The name is the caller's, unvalidated: echo a bounded prefix only.
  const name = rawName.length > MAX_TOOL_NAME_ECHO ? `${sliceClean(rawName, MAX_TOOL_NAME_ECHO)}...` : rawName;

  // A service that EXISTS but registered nothing is off, not misspelled;
  // checked before the did-you-mean, which would otherwise point chat_spaces_get at meet_spaces_get.
  const service = serviceOf(name);
  const known = SERVICES.some((s) => s.name === service) || GENERATED_SERVICES.some((s) => s.name === service);
  if (known && !registry.services().includes(service)) {
    const aliases = registry.accountSet().aliases;
    if (!toolsetEnabled(getToolsets(), service)) {
      const rendered = hints()?.render({ kind: 'service_not_enabled', tool: name, service, aliases, admin: false, toolsetOff: true, awaitingRestart: false });
      return rendered?.hint ?? `Tool ${name} not found: the "${service}" service is turned off in this deployment (GOOGLE_TOOLSETS).`;
    }
    if (servicesAwaitingRestart(registry).includes(service)) {
      const rendered = hints()?.render({ kind: 'service_not_enabled', tool: name, service, aliases, admin: false, toolsetOff: false, awaitingRestart: true });
      return rendered?.hint ?? `Tool ${name} not found: the "${service}" service was enabled after this server started, and tools register at startup. Restart the server to use them. Until then, google_api_call can reach the same API.`;
    }
    const isAdmin = service === 'admin';
    const hint =
      isAdmin
        ? 'set admin on an account/profile (or GOOGLE_ADMIN_ACCOUNTS), then re-auth'
        : (GENERATED_GATES[service]?.hint ?? `add "${service}" to an account's scope profile (or legacy GOOGLE_OPTIONAL_SCOPES), then re-auth`);
    const rendered = hints()?.render({
      kind: 'service_not_enabled',
      tool: name,
      service,
      bundle: isAdmin ? undefined : service,
      aliases,
      admin: isAdmin,
      toolsetOff: false,
      awaitingRestart: false,
    });
    return rendered?.hint ?? `Tool ${name} not found: the "${service}" service is not enabled in this deployment. To enable it, ${hint}. Until then, google_api_call can reach the same API.`;
  }

  const near = suggestKeys(rawName, registry.toolNames(), 3);
  if (near.length > 0) return `Tool ${name} not found. Did you mean: ${near.join(', ')}?`;
  return `Tool ${name} not found. Call {service}_discover to list a service's tools, or google_api_search to find a method on any Google API.`;
}

/**
 * Gated services the registry's CURRENT accounts enable but that registered
 * nothing: an account added mid-session unlocked them after buildRegistry
 * decided the gates. Mirrors compose.ts gate for gate, so an ungated or
 * toolset-excluded service is never reported.
 */
export function servicesAwaitingRestart(registry: ToolRegistry): string[] {
  const toolsets = getToolsets();
  const registered = new Set(registry.services());
  const live = registry.accountSet();
  const names = [...new Set([...SERVICES.map((s) => s.name), ...GENERATED_SERVICES.map((g) => g.name)])];
  return names.filter((n) => {
    const gate = SERVICES.find((s) => s.name === n)?.enabled ?? GENERATED_GATES[n]?.enabled;
    return gate !== undefined && toolsetEnabled(toolsets, n) && !registered.has(n) && gate(live);
  });
}
