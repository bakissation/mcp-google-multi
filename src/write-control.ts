import type { Cud } from './registry.js';
import { hints } from './hint-provider.js';

export type Profile = 'read-only' | 'safe-writes' | 'full-writes';
export type Transport = 'stdio' | 'http';

export interface Policy {
  profile: Profile;
  readOnly: boolean;
  allow: string[];
  deny: string[];
  /**
   * Reserved seam (HTTP posture is "annotations only"): the dispatch
   * transport is threaded into the resolved policy for a future seam, but in v6 alpha it does NOT stiffen the
   * profile or alter any `isAllowed` verdict. "Stricter on HTTP" is achieved
   * entirely by the `anthropic/requiresUserInteraction` annotation on the
   * irreversible set, emitted identically on both transports.
   * Optional so existing Policy literals (codegen/tests) need no change;
   * resolvePolicy always populates it.
   */
  transport?: Transport;
}

export interface ToolRef {
  name: string;
  service: string;
  cud: Cud;
  // Absent means "unknown", treated as not privileged: a missing scope list
  // must not silently widen the gate or break an ordinary write.
  scopes?: readonly string[];
}

const PROFILES: Profile[] = ['read-only', 'safe-writes', 'full-writes'];

/** The irreversible set (frozen): real sends leave the
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
  'gmail_delete_draft',
  'gmail_batch_delete',
  'drive_delete',
  'drive_empty_trash',
  // generated twins (permanent deletes / real sends)
  'gmail_users_threads_delete',
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

// Scopes that authorize acting on the whole organization, legal holds,
// billing, or deployed code: not a "safe" write, whatever its HTTP verb.
const PRIVILEGED_SCOPE_RE =
  /\/auth\/(admin\.directory|admin\.datatransfer|cloud-identity|apps\.licensing|apps\.order|apps\.groups\.settings|apps\.groups\.migration|ediscovery|script\.projects|script\.deployments)/;

/** Registering a push channel hands this account's activity to an external URL.
 * It is shaped like a create and behaves like an export, so the verb hides it.
 * forms.forms.watches.create/renew generate as _watches_create/_watches_renew
 * (plural "watches", unlike every other API's singular *.watch), so they
 * need their own branch alongside the common _watch suffix. */
const PUSH_REGISTRATION_RE = /(_watch|_watches_create|_watches_renew|_subscriptions_create|_subscriptions_reactivate)$/;

export type PrivilegeKind = 'push_registration' | 'privileged_scope';

/** Why this write counts as privileged, or undefined if it does not.
 * Derived, not a hand-kept name list: the tool surface is regenerated from
 * Discovery, and a list of names would drift out of date silently. */
export function privilegeOf(tool: ToolRef): PrivilegeKind | undefined {
  if (PUSH_REGISTRATION_RE.test(tool.name)) return 'push_registration';
  // `some`, not `every`: the scope list is an any-of, so a tool that CAN be
  // authorized by a privileged scope is treated as privileged.
  if (tool.scopes?.some((sc) => PRIVILEGED_SCOPE_RE.test(sc))) return 'privileged_scope';
  return undefined;
}

/** Moves an item to Trash rather than deleting it permanently: the owner can
 * still recover it, so safe-writes treats this like its other reversible
 * writes despite the delete-shaped verb. Named explicitly rather than matched
 * by verb, so a synthetic delete-classified check (drive_transfer's move
 * flag) never qualifies by accident, and so emptying Trash, which the same
 * verb regex also classifies as delete, is never swept in by a suffix match. */
const TRASH_MOVE_TOOLS = new Set([
  'gmail_trash',
  'drive_trash',
  'gmail_users_threads_trash',
]);

function profileAllows(profile: Profile, tool: ToolRef): boolean {
  if (profile === 'full-writes') return true;
  if (profile === 'safe-writes') {
    if (privilegeOf(tool) !== undefined) return false;
    if (tool.cud === 'create' || tool.cud === 'update') return true;
    return tool.cud === 'delete' && TRASH_MOVE_TOOLS.has(tool.name);
  }
  return false;
}

export function isAllowed(tool: ToolRef, policy: Policy): boolean {
  if (tool.cud === 'read') return true;
  if (policy.readOnly) return false;
  if (matchesAny(tool, policy.deny)) return false;
  if (matchesAny(tool, policy.allow)) return true;
  return profileAllows(policy.profile, tool);
}

export type EscapeHatchDecision = 'allow' | 'deny' | 'ask';

export interface EscapeHatchVerdict {
  decision: EscapeHatchDecision;
  /** The ref that explains the verdict: the specific name a deny glob
   * matched, or `primaryName` for every other case. */
  ref: ToolRef;
}

/**
 * The escape hatch (google_api_call and every generated per-method tool)
 * has no allow-list or privileged-write special case of its own anymore:
 * an explicit deny on any name the operation is known by still wins
 * (narrows what gets through, never widens it, so listing every curated
 * tool sharing a raw method here is always safe); full-writes with the
 * outbound allowlist off is the only automatic allow; everything else
 * (the default profile, safe-writes, any allow list set, or full-writes
 * with the allowlist on) asks a human via elicitation instead of
 * resolving the question itself.
 */
export function escapeHatchVerdict(
  denyNames: readonly string[],
  base: { service: string; cud: Cud; scopes?: readonly string[] },
  primaryName: string,
  policy: Policy,
  outboundAllowlistActive: boolean,
): EscapeHatchVerdict {
  const primaryRef: ToolRef = { name: primaryName, service: base.service, cud: base.cud, scopes: base.scopes };
  if (base.cud === 'read') return { decision: 'allow', ref: primaryRef };
  if (policy.readOnly) return { decision: 'deny', ref: primaryRef };
  const denyRefs = denyNames.map((name): ToolRef => ({ name, service: base.service, cud: base.cud, scopes: base.scopes }));
  const deniedRef = denyRefs.find((ref) => matchesAny(ref, policy.deny));
  if (deniedRef) return { decision: 'deny', ref: deniedRef };
  if (policy.profile === 'full-writes' && !outboundAllowlistActive) return { decision: 'allow', ref: primaryRef };
  return { decision: 'ask', ref: primaryRef };
}

/** Which profiles would permit this tool at all. */
function profilesAllowing(tool: ToolRef): Profile[] {
  return PROFILES.filter((p) => profileAllows(p, tool));
}

export type DenyReason =
  | { rule: 'read_only' }
  | { rule: 'deny_glob'; pattern: string }
  | { rule: 'privileged'; profile: Profile; kind: PrivilegeKind }
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
  if (profileAllows(policy.profile, tool)) return undefined;
  const kind = privilegeOf(tool);
  // Distinguished from a plain profile refusal: "delete is not a safe write"
  // and "this is an org-wide operation" need different answers.
  if (kind !== undefined && policy.profile === 'safe-writes') {
    return { rule: 'privileged', profile: policy.profile, kind };
  }
  return { rule: 'profile', profile: policy.profile };
}

const CUD_CLASSES: readonly string[] = ['read', 'create', 'update', 'delete'];

// The allow-list vocabulary is service:cud or service:op, never the tool
// name, so suggesting the name would hand back a pattern that never matches.
function allowSuggestion(tool: ToolRef): string {
  const op = opOf(tool);
  const pattern = `${tool.service}:${op}`;
  // An op spelled like a cud class (drive_update) is also that class's pattern.
  if (CUD_CLASSES.includes(op)) {
    return `allow it with GOOGLE_WRITE_ALLOW="${pattern}", which also allows every other ${op}-class ${tool.service} tool`;
  }
  return `allow just this one with GOOGLE_WRITE_ALLOW="${pattern}"`;
}

function denyHint(tool: ToolRef, reason: DenyReason): string {
  if (reason.rule === 'read_only') {
    return 'GOOGLE_READ_ONLY=true refuses every write, ahead of the profile and the allow-list, so neither of those can enable this. Unset GOOGLE_READ_ONLY to allow writes.';
  }
  if (reason.rule === 'deny_glob') {
    return `GOOGLE_WRITE_DENY pattern "${reason.pattern}" matches this tool, and deny is checked before the allow-list and the profile, so neither can override it. Remove or narrow that pattern.`;
  }
  if (reason.rule === 'privileged') {
    const what = reason.kind === 'push_registration'
      ? 'registers a push channel, which sends this account\'s activity to an external URL'
      : 'needs a scope that acts on the whole organization, on legal holds, on billing, or on deployed code';
    return `"${tool.name}" ${what}, so "${reason.profile}" refuses it whatever its verb. Use GOOGLE_PROFILE=full-writes, or ${allowSuggestion(tool)}.`;
  }
  const usable = profilesAllowing(tool).filter((p) => p !== reason.profile);
  const profiles = usable.length > 0
    ? `Use GOOGLE_PROFILE=${usable.join(' or ')}`
    : 'No profile permits this operation';
  return `Profile "${reason.profile}" does not permit ${tool.cud}. ${profiles}, or ${allowSuggestion(tool)}.`;
}

export function writeDisabledResult(tool: ToolRef, policy: Policy, account?: string) {
  // Recomputed rather than passed in: every call site has already run
  // isAllowed, and a hint that disagrees with the verdict is worse than none.
  const reason = denyReason(tool, policy) ?? { rule: 'profile' as const, profile: policy.profile };
  const rendered = hints()?.render({
    kind: 'write_denied',
    tool: { name: tool.name, service: tool.service, cud: tool.cud },
    reason,
    policy,
  });
  const envelope = {
    error: 'write_disabled',
    message:
      rendered?.message ??
      `"${tool.name}" (${tool.cud}) is disabled by the current write-control policy (profile: ${policy.profile}${policy.readOnly ? ', GOOGLE_READ_ONLY=true' : ''}).`,
    hint: rendered?.hint ?? denyHint(tool, reason),
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
