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
import { registerChatTools } from './tools/chat.js';
import { registerAdminTools } from './tools/admin.js';
import { registerAnalyticsTools } from './tools/analytics.js';
import { getOptionalBundles, getAdminAccounts } from './auth.js';
import type { ToolRegistry } from './registry.js';
import { GENERATED_SERVICES } from './tools/generated/index.js';
import { suggestKeys } from './arg-strict.js';

export interface ServiceEntry {
  name: string;
  register: (registry: ToolRegistry) => void;
  enabled?: () => boolean;
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
  { name: 'slides', register: registerSlidesTools, enabled: () => new Set(getOptionalBundles()).has('slides') },
  { name: 'forms', register: registerFormsTools, enabled: () => new Set(getOptionalBundles()).has('forms') },
  { name: 'chat', register: registerChatTools, enabled: () => new Set(getOptionalBundles()).has('chat') },
  { name: 'analytics', register: registerAnalyticsTools, enabled: () => { const b = new Set(getOptionalBundles()); return b.has('analytics') || b.has('analytics_write'); } },
  { name: 'admin', register: registerAdminTools, enabled: () => getAdminAccounts().length > 0 },
];

// Generated-only services with opt-in scopes; admin/forms/chat/analytics reuse their curated gate in buildRegistry,
// and workspaceevents is deliberately absent — no dedicated scope (subscriptions use resource scopes).
const bundleGate = (name: string) => ({
  enabled: () => new Set(getOptionalBundles()).has(name),
  hint: `add "${name}" to an account's scope profile (or legacy GOOGLE_OPTIONAL_SCOPES)`,
});
export const GENERATED_GATES: Record<string, { enabled: () => boolean; hint: string }> = {
  appsmarket: bundleGate('appsmarket'),
  classroom: bundleGate('classroom'),
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

/**
 * Message for a `tools/call` naming a tool that is not registered. The SDK's
 * own answer is a bare "Tool X not found", which reads identically for a typo,
 * for a service gated behind a scope bundle, and for an API this server has
 * never heard of. Those need different next steps, and the server knows which
 * is which: it composed the enabled-service list at boot.
 */
export function unknownToolMessage(registry: ToolRegistry, name: string): string {
  const near = suggestKeys(name, registry.toolNames(), 3);
  if (near.length > 0) return `Tool ${name} not found. Did you mean: ${near.join(', ')}?`;

  // A service that EXISTS in the build but registered nothing is gated, not
  // misspelled, and the fix is a scope bundle rather than a different name.
  const service = name.split('_')[0];
  const known = SERVICES.some((s) => s.name === service) || GENERATED_SERVICES.some((s) => s.name === service);
  if (known && !registry.services().includes(service)) {
    const hint =
      service === 'admin'
        ? 'set admin on an account/profile (or GOOGLE_ADMIN_ACCOUNTS), then re-auth'
        : (GENERATED_GATES[service]?.hint ?? `add "${service}" to an account's scope profile (or legacy GOOGLE_OPTIONAL_SCOPES), then re-auth`);
    return `Tool ${name} not found: the "${service}" service is not enabled in this deployment. To enable it, ${hint}. Until then, google_api_call can reach the same API.`;
  }
  return `Tool ${name} not found. Call {service}_discover to list a service's tools, or google_api_search to find a method on any Google API.`;
}
