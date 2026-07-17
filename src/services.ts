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
import { getOptionalBundles, getAdminAccounts } from './auth.js';
import type { ToolRegistry } from './registry.js';

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
  { name: 'admin', register: registerAdminTools, enabled: () => getAdminAccounts().length > 0 },
];

// Opt-in gates for generated-only services whose scopes are not granted by
// default; shared services (admin, forms, chat) reuse their curated gate in
// buildRegistry. workspaceevents has no dedicated scope (subscriptions use the
// underlying resource scopes), so it registers ungated.
const bundleGate = (name: string) => ({
  enabled: () => new Set(getOptionalBundles()).has(name),
  hint: `add "${name}" to GOOGLE_OPTIONAL_SCOPES`,
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
