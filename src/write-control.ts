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

function opOf(tool: ToolRef): string {
  return tool.name.includes('_') ? tool.name.slice(tool.name.indexOf('_') + 1) : tool.name;
}

function candidates(tool: ToolRef): string[] {
  return [`${tool.service}:${tool.cud}`, `${tool.service}:${opOf(tool)}`];
}

function firstMatch(tool: ToolRef, globs: string[]): string | undefined {
  if (globs.length === 0) return undefined;
  const cands = candidates(tool);
  return globs.find((g) => {
    const re = globToRegExp(g);
    return cands.some((c) => re.test(c));
  });
}

function matchesAny(tool: ToolRef, globs: string[]): boolean {
  return firstMatch(tool, globs) !== undefined;
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

/** Which profiles would permit this cud at all. */
function profilesAllowing(cud: Cud): Profile[] {
  return PROFILES.filter((p) => profileAllows(p, cud));
}

export type DenyReason =
  | { rule: 'read_only' }
  | { rule: 'deny_glob'; pattern: string }
  | { rule: 'profile'; profile: Profile };

/** WHICH rule refused the call. `isAllowed` has a precedence order, so exactly
 * one rule decides; naming the others sends the caller to a setting that
 * cannot change the outcome. */
export function denyReason(tool: ToolRef, policy: Policy): DenyReason | undefined {
  if (tool.cud === 'read') return undefined;
  if (policy.readOnly) return { rule: 'read_only' };
  const pattern = firstMatch(tool, policy.deny);
  if (pattern !== undefined) return { rule: 'deny_glob', pattern };
  if (matchesAny(tool, policy.allow)) return undefined;
  if (profileAllows(policy.profile, tool.cud)) return undefined;
  return { rule: 'profile', profile: policy.profile };
}

function denyHint(tool: ToolRef, reason: DenyReason): string {
  if (reason.rule === 'read_only') {
    return 'GOOGLE_READ_ONLY=true refuses every write, ahead of the profile and the allow-list, so neither of those can enable this. Unset GOOGLE_READ_ONLY to allow writes.';
  }
  if (reason.rule === 'deny_glob') {
    return `GOOGLE_WRITE_DENY pattern "${reason.pattern}" matches this tool, and deny is checked before the allow-list and the profile, so neither can override it. Remove or narrow that pattern.`;
  }
  const usable = profilesAllowing(tool.cud).filter((p) => p !== reason.profile);
  const profiles = usable.length > 0
    ? `Use GOOGLE_PROFILE=${usable.join(' or ')}`
    : 'No profile permits this operation';
  // The allow-list vocabulary is service:cud or service:op, never the tool
  // name, so suggesting the name would hand back a pattern that never matches.
  return `Profile "${reason.profile}" does not permit ${tool.cud}. ${profiles}, or allow just this one with GOOGLE_WRITE_ALLOW="${tool.service}:${opOf(tool)}".`;
}

export function writeDisabledResult(tool: ToolRef, policy: Policy, account?: string) {
  // Recomputed rather than passed in: every call site has already run
  // isAllowed, and a hint that disagrees with the verdict is worse than none.
  const reason = denyReason(tool, policy) ?? { rule: 'profile' as const, profile: policy.profile };
  const envelope = {
    error: 'write_disabled',
    message: `"${tool.name}" (${tool.cud}) is disabled by the current write-control policy (profile: ${policy.profile}${policy.readOnly ? ', GOOGLE_READ_ONLY=true' : ''}).`,
    hint: denyHint(tool, reason),
    retriable: false,
    ...(account ? { account } : {}),
  };
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(envelope) }],
    isError: true as const,
  };
}

export function describePolicy(policy: Policy): string {
  return `profile=${policy.profile} readOnly=${policy.readOnly} allow=[${policy.allow.join(', ')}] deny=[${policy.deny.join(', ')}]`;
}
