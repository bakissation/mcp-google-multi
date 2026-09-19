import type { Cud } from './registry.js';

export type Profile = 'read-only' | 'safe-writes' | 'full-writes';
export type Transport = 'stdio' | 'http';

export interface Policy {
  profile: Profile;
  readOnly: boolean;
  allow: string[];
  deny: string[];
  /**
   * B14 reserved seam (cc-write-control "HTTP posture", LOCKED to OQ-5
   * "annotations only"): the dispatch transport is threaded into the resolved
   * policy for the EE/future seam, but in v6 alpha it does NOT stiffen the
   * profile or alter any `isAllowed` verdict. "Stricter on HTTP" is achieved
   * entirely by the `anthropic/requiresUserInteraction` annotation on the
   * irreversible set (A12), emitted identically on both transports.
   * Optional so existing Policy literals (codegen/tests) need no change;
   * resolvePolicy always populates it.
   */
  transport?: Transport;
}

interface ToolRef {
  name: string;
  service: string;
  cud: Cud;
}

const PROFILES: Profile[] = ['read-only', 'safe-writes', 'full-writes'];

/** The irreversible set (frozen, cc-write-control): real sends leave the
 * user's (or org's) identity unrecallably; permanent deletes bypass Trash.
 * Includes the callable GENERATED twins of the curated ops — the surface is
 * always callable by name, so a prompt-free twin would defeat the layer.
 * Reversible mutations (trash/untrash, draft create/update, labels, calendar
 * edits) are deliberately excluded so the approval prompt never nags. The
 * escape hatch is documented as outside this layer (server write-control
 * still gates it). */
export const IRREVERSIBLE_TOOLS = new Set([
  // curated
  'gmail_send',
  'gmail_send_draft',
  'gmail_delete',
  'gmail_batch_delete',
  'drive_delete',
  'drive_empty_trash',
  // generated twins (permanent deletes / real sends)
  'gmail_users_threads_delete',
  'gmail_users_drafts_delete',
  'chat_spaces_messages_delete',
  'cloudidentity_customers_userinvitations_send',
  'vault_matters_holds_delete',
]);

function parseGlobs(value: string | undefined): string[] {
  return (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

export function resolvePolicy(
  env: NodeJS.ProcessEnv = process.env,
  opts: { transport?: Transport } = {},
): Policy {
  const raw = (env.GOOGLE_PROFILE ?? 'read-only').trim() as Profile;
  if (raw && !PROFILES.includes(raw)) {
    // Fail-closed to read-only, but say so — a typo'd profile otherwise looks
    // like every write tool silently breaking.
    process.stderr.write(`GOOGLE_PROFILE="${raw}" is not valid (${PROFILES.join(' | ')}); using read-only\n`);
  }
  return {
    profile: PROFILES.includes(raw) ? raw : 'read-only',
    readOnly: /^(1|true|yes)$/i.test(env.GOOGLE_READ_ONLY ?? ''),
    allow: parseGlobs(env.GOOGLE_WRITE_ALLOW),
    deny: parseGlobs(env.GOOGLE_WRITE_DENY),
    // Reserved seam only (see Policy.transport): does not affect the verdict.
    transport: opts.transport ?? 'stdio',
  };
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.trim().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function candidates(tool: ToolRef): string[] {
  const op = tool.name.includes('_') ? tool.name.slice(tool.name.indexOf('_') + 1) : tool.name;
  return [`${tool.service}:${tool.cud}`, `${tool.service}:${op}`];
}

function matchesAny(tool: ToolRef, globs: string[]): boolean {
  if (globs.length === 0) return false;
  const cands = candidates(tool);
  return globs.some((g) => {
    const re = globToRegExp(g);
    return cands.some((c) => re.test(c));
  });
}

function profileAllows(profile: Profile, cud: Cud): boolean {
  if (profile === 'full-writes') return true;
  if (profile === 'safe-writes') return cud === 'create' || cud === 'update';
  return false;
}

export function isAllowed(tool: ToolRef, policy: Policy): boolean {
  if (tool.cud === 'read') return true;
  if (policy.readOnly) return false;
  if (matchesAny(tool, policy.deny)) return false;
  if (matchesAny(tool, policy.allow)) return true;
  return profileAllows(policy.profile, tool.cud);
}

export function writeDisabledResult(tool: ToolRef, policy: Policy) {
  const envelope = {
    error: 'write_disabled',
    message: `"${tool.name}" (${tool.cud}) is disabled by the current write-control policy (profile: ${policy.profile}${policy.readOnly ? ', GOOGLE_READ_ONLY=true' : ''}).`,
    hint: `Enable via GOOGLE_PROFILE=safe-writes|full-writes, or GOOGLE_WRITE_ALLOW="${tool.service}:*".`,
    retriable: false,
  };
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(envelope) }],
    isError: true as const,
  };
}

export function describePolicy(policy: Policy): string {
  return `profile=${policy.profile} readOnly=${policy.readOnly} allow=[${policy.allow.join(', ')}] deny=[${policy.deny.join(', ')}]`;
}
