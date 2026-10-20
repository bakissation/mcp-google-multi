// Opt-in outbound recipient allowlist: a prompt-injection blast-radius
// control (a hijacked agent cannot mail/invite/share outside the operator's list). Off by default.

import { hints } from './hint-provider.js';

export interface OutboundAllowlist {
  entries: string[];
  allows(email: string): boolean;
}

/** Parse GOOGLE_OUTBOUND_ALLOWLIST: comma-separated addresses and @domain
 * suffixes ("a@b.com, @company.com"). null = feature off (nothing gated). */
export function resolveOutboundAllowlist(env: NodeJS.ProcessEnv = process.env): OutboundAllowlist | null {
  const raw = env.GOOGLE_OUTBOUND_ALLOWLIST;
  if (raw === undefined || raw.trim() === '') return null;
  const entries = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (entries.length === 0) return null;
  const exact = new Set(entries.filter((e) => !e.startsWith('@')));
  const domains = entries.filter((e) => e.startsWith('@'));
  return {
    entries,
    allows(email: string): boolean {
      const a = email.trim().toLowerCase();
      // Reject anything that isn't a single address: a comma/semicolon/
      // whitespace-joined string, or more than one "@", could smuggle an
      // unlisted address alongside one that happens to make the WHOLE
      // string pass an @domain suffix check (e.g. "evil@x.io,ok@corp.com"
      // ends with "@corp.com") even though it names two recipients.
      if (!a || /[,;\s]/.test(a) || a.indexOf('@') !== a.lastIndexOf('@')) return false;
      if (exact.has(a)) return true;
      return domains.some((d) => a.endsWith(d));
    },
  };
}

/** The addresses in `emails` the active allowlist rejects; [] when off. */
export function outboundViolations(emails: string[], env: NodeJS.ProcessEnv = process.env): string[] {
  const list = resolveOutboundAllowlist(env);
  if (!list) return [];
  return emails.map((e) => e.trim()).filter(Boolean).filter((e) => !list.allows(e));
}

/** The standard error envelope for a blocked outbound target. */
export function outboundDeniedEnvelope(kind: string, blocked: string[], account: string, env: NodeJS.ProcessEnv = process.env) {
  const list = resolveOutboundAllowlist(env);
  const rendered = hints()?.render({ kind: 'outbound_denied', what: kind, blocked, entries: list?.entries ?? [] });
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          error: 'recipient_not_allowed',
          message: `${kind} blocked by the outbound allowlist: ${blocked.join(', ')}.`,
          hint:
            rendered?.hint ??
            (`GOOGLE_OUTBOUND_ALLOWLIST is active (${(list?.entries ?? []).join(', ')}). ` +
              'The operator must add the address (or its @domain) to the list, or unset the variable, to allow this target.'),
          retriable: false,
          account,
        }),
      },
    ],
    isError: true as const,
  };
}

/** Convenience: envelope when violations exist, else null. */
export function checkOutbound(kind: string, emails: string[], account: string, env: NodeJS.ProcessEnv = process.env) {
  const blocked = outboundViolations(emails, env);
  return blocked.length > 0 ? outboundDeniedEnvelope(kind, blocked, account, env) : null;
}

// RAW compose methods can't be inspected (base64 RFC 822), so with the
// allowlist active they're refused outright in favor of the curated tools that enforce it.
// drafts.update is in this set too: it replaces a draft's raw content (so a
// draft gmail_create_draft checked at creation time could be rewritten with
// an unlisted recipient and then sent via gmail_send_draft, which re-checks
// the draft's actual headers right before send as a second guard).
const RAW_SEND_METHODS = new Set(['gmail.users.messages.send', 'gmail.users.drafts.send', 'gmail.users.drafts.create', 'gmail.users.drafts.update', 'gmail.users.messages.insert', 'gmail.users.messages.import']);

/**
 * Discovery methods whose body can name a grantee outside the plain
 * "emailAddress"/"email" keys collectBodyRecipients inspects: a Drive
 * permission's type/domain, a Gmail delegate/forwarding-address/send-as
 * email, a filter's forward action, a Calendar ACL scope. Each is checked by
 * its own shape rather than the generic key walk, and a write to one of
 * these whose body does not match the shape we understand is refused rather
 * than let an unrecognised grantee channel through uninspected.
 */
const GRANTEE_METHODS = new Set([
  'drive.permissions.create',
  'gmail.users.settings.delegates.create',
  'gmail.users.settings.forwardingAddresses.create',
  'gmail.users.settings.sendAs.create',
  'gmail.users.settings.filters.create',
  'calendar.acl.insert',
  'calendar.acl.update',
  'calendar.acl.patch',
  'classroom.userProfiles.guardianInvitations.create',
  'directory.users.patch',
  'directory.users.insert',
  'directory.users.update',
  'chat.spaces.setup',
]);

/**
 * Writes whose body cannot be trusted to carry the real grantee at all:
 * drive.permissions.update only takes role/expirationTime (the grantee is
 * named by the permissionId path parameter, which Google resolves
 * server-side; a caller-supplied body claiming a safe emailAddress proves
 * nothing about who permissionId actually names), and
 * drive.accessproposals.resolve's body is just an ACCEPT/DENY action (the
 * requester is a property of the proposal itself, not of this call). Both
 * need a server lookup (permissions.get / accessproposals.get) to resolve
 * for real; the curated tools that wrap them do that lookup directly (they
 * already hold the client). The generic escape-hatch/generated-tool path
 * does not have a good place to thread that lookup through, so it fails
 * closed instead of trusting an unverifiable body.
 */
const BODY_UNTRUSTED_METHODS = new Set(['drive.permissions.update', 'drive.accessproposals.resolve']);

interface GranteeCheck {
  /** Plain addresses to run through the allowlist. */
  emails: string[];
  /** "@domain" strings that need an exact allowlist entry. */
  domains: string[];
  /** A share-with-anyone / calendar-default grant: always blocked while the
   * allowlist is active, however it is spelled, since there is no address
   * an operator could add to permit it. */
  public: boolean;
  /** False when the body does not match any shape this method is known to
   * take (a required field missing or of the wrong type): the caller fails
   * closed instead of treating an unexamined body as grantee-free. */
  understood: boolean;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function asNonEmptyString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

// Google's JSON parser follows the proto3 JSON mapping, which also accepts
// a field's original (snake_case) proto name alongside its canonical
// lowerCamelCase JSON name, and coerces a "boxed" scalar (a string for a
// bool/number field) leniently. Every rule below, and the generic key
// scan, reads a literal camelCase key and compares against a literal
// `true`, so a body using snake_case keys or string "true" passed
// unexamined. Both are normalised once, up front, before any check runs.
function snakeToCamel(key: string): string {
  return key.replace(/_([a-z0-9])/gi, (_, c: string) => c.toUpperCase());
}

interface NormalizeResult {
  value: unknown;
  /** True anywhere in the (sub)tree two differently-spelled source keys
   * (e.g. enable_auto_reply and enableAutoReply) normalised to the same
   * key: which one "won" is iteration-order noise, not a shape any check
   * below should trust. */
  ambiguous: boolean;
}

function normalizeBodyKeysDeep(v: unknown, depth: number): NormalizeResult {
  if (depth > 12) return { value: v, ambiguous: false }; // pathological nesting: stop rewriting, not throwing
  if (Array.isArray(v)) {
    let ambiguous = false;
    const value = v.map((x) => {
      const r = normalizeBodyKeysDeep(x, depth + 1);
      ambiguous = ambiguous || r.ambiguous;
      return r.value;
    });
    return { value, ambiguous };
  }
  if (v && typeof v === 'object') {
    // Object.create(null): a bracket-assigned key literally named
    // "__proto__" on a plain {} would invoke Object.prototype's own
    // __proto__ SETTER (a [[Set]], not a [[DefineOwnProperty]]), silently
    // repointing this object's prototype instead of storing a normal
    // data property; a null-prototype object has no such setter to invoke.
    const out: Record<string, unknown> = Object.create(null);
    let ambiguous = false;
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const camel = snakeToCamel(k);
      if (camel in out) ambiguous = true;
      const r = normalizeBodyKeysDeep(val, depth + 1);
      ambiguous = ambiguous || r.ambiguous;
      out[camel] = r.value;
    }
    return { value: out, ambiguous };
  }
  return { value: v, ambiguous: false };
}

function normalizeBodyKeys(v: unknown): NormalizeResult {
  return normalizeBodyKeysDeep(v, 0);
}

// A boolean gate that turns something ON (enableAutoReply, published,
// publishedOutsideDomain, ...) must treat anything other than absent/
// null/false/"false" as true: proto3 JSON accepts a bool field written
// as a string ("true"), and this check must not be the more permissive
// reader between the two, or a value Google would reject outright could
// quietly fail to register as "this call does something dangerous".
function isTruthyGate(v: unknown): boolean {
  if (v === undefined || v === null || v === false) return false;
  if (typeof v === 'string' && v.trim().toLowerCase() === 'false') return false;
  return true;
}

// A boolean gate that turns a RESTRICTION on (restrictToContacts,
// restrictToDomain) is read the other way around: only a strict `true`,
// or a string that trims and lowercases to "true", counts. Anything else
// -- "0", "no", "", 0, [false], an object -- must NOT be read as "the
// restriction is in effect", the way isTruthyGate's lenient reading would
// (every one of those is truthy by isTruthyGate's rule, since none of
// them is exactly false or the string "false"); Google likely parses
// those non-boolean, non-"true"/"false" values as false, meaning the
// restriction would NOT actually be on.
function isStrictlyTrue(v: unknown): boolean {
  if (v === true) return true;
  return typeof v === 'string' && v.trim().toLowerCase() === 'true';
}

const UNRECOGNIZED: GranteeCheck = { emails: [], domains: [], public: false, understood: false };

/** Shared by drive.permissions.create's body (type/domain/emailAddress) and
 * drive_permission_update's own permissions.get lookup (same resource
 * shape, fetched instead of trusted from the body; see BODY_UNTRUSTED_METHODS). */
export function driveGranteeFromPermission(perm: { type?: string | null; domain?: string | null; emailAddress?: string | null } | null | undefined): GranteeCheck {
  const type = perm?.type ?? undefined;
  if (type === 'anyone') return { emails: [], domains: [], public: true, understood: true };
  if (type === 'domain') {
    const domain = asNonEmptyString(perm?.domain);
    return domain ? { emails: [], domains: [`@${domain.toLowerCase()}`], public: false, understood: true } : UNRECOGNIZED;
  }
  if (type === 'user' || type === 'group') {
    const email = asNonEmptyString(perm?.emailAddress);
    return email ? { emails: [email], domains: [], public: false, understood: true } : UNRECOGNIZED;
  }
  return UNRECOGNIZED;
}

/** The access proposal's own recipient (the person who gains access if an
 * ACCEPT goes through), for drive_access_proposal_resolve's own
 * accessproposals.get lookup; see BODY_UNTRUSTED_METHODS. */
export function driveGranteeFromAccessProposal(proposal: { recipientEmailAddress?: string | null; requesterEmailAddress?: string | null } | null | undefined): GranteeCheck {
  const email = asNonEmptyString(proposal?.recipientEmailAddress) ?? asNonEmptyString(proposal?.requesterEmailAddress);
  return email ? { emails: [email], domains: [], public: false, understood: true } : UNRECOGNIZED;
}

/** Applies an already-resolved GranteeCheck against the allowlist: the
 * entry point curated tools use once they have looked up a grantee
 * themselves (drive_permission_update, drive_access_proposal_resolve), the
 * same logic checkOutboundForMethod applies to a body/path-derived one. */
export function checkOutboundGrantee(kind: string, grantee: GranteeCheck, account: string, env: NodeJS.ProcessEnv = process.env) {
  const list = resolveOutboundAllowlist(env);
  if (!list) return null;
  if (!grantee.understood) return unrecognizedShapeEnvelope(kind, account);
  if (grantee.public) return outboundDeniedEnvelope(`${kind} grantee`, ['anyone (public)'], account, env);
  const blockedDomains = grantee.domains.filter((d) => !list.entries.includes(d));
  if (blockedDomains.length > 0) return outboundDeniedEnvelope(`${kind} domain grantee`, blockedDomains, account, env);
  if (grantee.emails.length > 0) return checkOutbound(`${kind} grantee`, grantee.emails, account, env);
  return null;
}

/** The grantee(s) a known resource-scoped write method's body carries, or
 * null when the method isn't one of GRANTEE_METHODS (caller falls back to
 * the generic emailAddress/email key walk). */
function granteeCheck(methodId: string, body: unknown): GranteeCheck | null {
  const b = asRecord(body) ?? {};
  switch (methodId) {
    case 'drive.permissions.create':
      return driveGranteeFromPermission(b as { type?: string | null; domain?: string | null; emailAddress?: string | null });
    case 'classroom.userProfiles.guardianInvitations.create': {
      const email = asNonEmptyString(b.invitedEmailAddress);
      return email ? { emails: [email], domains: [], public: false, understood: true } : UNRECOGNIZED;
    }
    case 'directory.users.patch':
    case 'directory.users.insert':
    case 'directory.users.update': {
      // recoveryEmail is optional on a user resource; most calls don't
      // touch it at all, so its absence is not an unrecognised shape.
      const recoveryEmail = asNonEmptyString(b.recoveryEmail);
      return recoveryEmail
        ? { emails: [recoveryEmail], domains: [], public: false, understood: true }
        : { emails: [], domains: [], public: false, understood: true };
    }
    case 'chat.spaces.setup': {
      // memberships present but not an array (a number-keyed object, a
      // bare string, ...) is an unrecognised shape, not zero memberships:
      // Array.isArray's false branch must not be read as "nothing here".
      if (b.memberships !== undefined && !Array.isArray(b.memberships)) return UNRECOGNIZED;
      const memberships = Array.isArray(b.memberships) ? b.memberships : [];
      const emails: string[] = [];
      for (const m of memberships) {
        const mem = asRecord(m);
        // groupMember names a Group (groups/<id>), never a checkable email;
        // a member whose name is not users/<email> (e.g. a numeric Chat
        // user id, which is the common real-world form) cannot be checked
        // either. Both are unrecognised shapes, not zero grantees: silently
        // skipping either let a membership through unexamined.
        if (!mem || 'groupMember' in mem) return UNRECOGNIZED;
        const member = asRecord(mem.member);
        const name = member ? asNonEmptyString(member.name) : undefined;
        if (!name || !name.startsWith('users/')) return UNRECOGNIZED;
        const id = name.slice('users/'.length);
        if (!id.includes('@')) return UNRECOGNIZED;
        emails.push(id);
      }
      return { emails, domains: [], public: false, understood: true };
    }
    case 'gmail.users.settings.delegates.create': {
      const email = asNonEmptyString(b.delegateEmail);
      return email ? { emails: [email], domains: [], public: false, understood: true } : UNRECOGNIZED;
    }
    case 'gmail.users.settings.forwardingAddresses.create': {
      const email = asNonEmptyString(b.forwardingEmail);
      return email ? { emails: [email], domains: [], public: false, understood: true } : UNRECOGNIZED;
    }
    case 'gmail.users.settings.sendAs.create': {
      const email = asNonEmptyString(b.sendAsEmail);
      return email ? { emails: [email], domains: [], public: false, understood: true } : UNRECOGNIZED;
    }
    case 'gmail.users.settings.filters.create': {
      // No forward action is the common, ungated case: most filters only label or archive.
      if (b.action === undefined) return { emails: [], domains: [], public: false, understood: true };
      const action = asRecord(b.action);
      if (!action) return UNRECOGNIZED;
      if (!('forward' in action)) return { emails: [], domains: [], public: false, understood: true };
      // A `forward` key that isn't a plain non-empty string is not a shape
      // this check understands (it might still be a real address some other
      // way), so this fails closed rather than silently treating it as "no forward".
      const forward = asNonEmptyString(action.forward);
      return forward ? { emails: [forward], domains: [], public: false, understood: true } : UNRECOGNIZED;
    }
    case 'calendar.acl.insert':
    case 'calendar.acl.update':
    case 'calendar.acl.patch': {
      const scope = asRecord(b.scope);
      const scopeType = scope ? asNonEmptyString(scope.type) : undefined;
      if (!scope || !scopeType) return UNRECOGNIZED;
      if (scopeType === 'default') return { emails: [], domains: [], public: true, understood: true };
      if (scopeType === 'domain') {
        const domain = asNonEmptyString(scope.value);
        return domain ? { emails: [], domains: [`@${domain.toLowerCase()}`], public: false, understood: true } : UNRECOGNIZED;
      }
      if (scopeType === 'user' || scopeType === 'group') {
        const email = asNonEmptyString(scope.value);
        return email ? { emails: [email], domains: [], public: false, understood: true } : UNRECOGNIZED;
      }
      return UNRECOGNIZED;
    }
    default:
      return null;
  }
}

// Resource segments that, by the Discovery API's own naming convention,
// name a grantee/membership/role resource: Drive permissions, Calendar ACL,
// Chat/Groups/Cloud Identity members or memberships, Gmail delegates /
// forwarding addresses / sendAs identities, Classroom invitations/students/
// teachers, GA4 account/property access bindings. Matched against an exact
// dot-separated segment of the method id, not a substring, so an unrelated
// method whose name happens to contain one of these words as part of a
// longer word does not match by accident.
const GRANTEE_RESOURCE_SEGMENTS = new Set([
  'acl',
  'permissions',
  'members',
  'memberships',
  'delegates',
  'forwardingAddresses',
  'sendAs',
  'invitations',
  'accessBindings',
  'students',
  'teachers',
]);

function matchesGranteePattern(methodId: string): boolean {
  return methodId.split('.').some((segment) => GRANTEE_RESOURCE_SEGMENTS.has(segment));
}

/** Grantee-pattern methods that never add an outside recipient, so the
 * generic fail-closed fallback below is a false positive for them:
 * contactGroups.members.modify only reorganizes the caller's OWN existing
 * contacts into groups (resourceNamesToAdd/Delete are people/<id> resource
 * names, never emails); nothing is granted to anyone new. */
const ALWAYS_SAFE_GRANTEE_PATTERN_METHODS = new Set(['people.contactGroups.members.modify']);

/** A sendAs patch/update touching only signature and/or displayName
 * changes nothing about WHO can send as this identity (the fields that do
 * -- sendAsEmail, replyToAddress, treatAsAlias -- are absent), so it is
 * harmless regardless of the allowlist. */
function isHarmlessSendAsPatch(methodId: string, body: unknown): boolean {
  if (methodId !== 'gmail.users.settings.sendAs.patch' && methodId !== 'gmail.users.settings.sendAs.update') return false;
  const b = asRecord(body);
  if (!b) return true; // nothing at all to change is harmless
  const SAFE_FIELDS = new Set(['signature', 'displayName']);
  return Object.keys(b).every((k) => SAFE_FIELDS.has(k));
}

function mergeGrantee(a: GranteeCheck | null, b: GranteeCheck | null): GranteeCheck {
  const parts = [a, b].filter((x): x is GranteeCheck => x !== null);
  return {
    emails: parts.flatMap((p) => p.emails),
    domains: parts.flatMap((p) => p.domains),
    public: parts.some((p) => p.public),
    understood: parts.length > 0 && parts.every((p) => p.understood),
  };
}

// Calendar's ACL rule id itself encodes the grantee ("user:x@evil.example",
// "group:...", "domain:...", or the bare string "default") for update/patch,
// independently of whatever the body's `scope` says, so a body that omits
// or disagrees with `scope` cannot hide the real target named in the path.
function pathParamGrantee(methodId: string, pathParams: Record<string, unknown> | undefined): GranteeCheck | null {
  if (methodId !== 'calendar.acl.update' && methodId !== 'calendar.acl.patch') return null;
  const ruleId = pathParams ? asNonEmptyString(pathParams.ruleId) : undefined;
  if (!ruleId) return null;
  const sep = ruleId.indexOf(':');
  if (sep === -1) return null; // "default" alone: the body's scope.type carries it
  const type = ruleId.slice(0, sep);
  const value = ruleId.slice(sep + 1);
  if (!value) return null;
  if (type === 'user' || type === 'group') return { emails: [value], domains: [], public: false, understood: true };
  if (type === 'domain') return { emails: [], domains: [`@${value.toLowerCase()}`], public: false, understood: true };
  return null;
}

/** Writes refused outright while the allowlist is active because they
 * expose content/access in a way no single email address could permit
 * (there is nothing an operator could add to the allowlist to allow
 * them): publishing a Drive revision makes it reachable by anyone with
 * the link, or by the whole domain, not by an addressable recipient; an
 * unrestricted Gmail vacation auto-reply answers every incoming sender,
 * not just allowlisted ones. */
function dangerousDefaultRefusal(methodId: string, normalizedBody: unknown): string | null {
  const b = asRecord(normalizedBody) ?? {};
  if (methodId === 'drive.revisions.update') {
    if (isTruthyGate(b.published) || isTruthyGate(b.publishedOutsideDomain)) {
      return 'publishing a revision makes it reachable without an invite, which the allowlist cannot scope to specific recipients';
    }
    return null;
  }
  if (methodId === 'gmail.users.settings.updateVacation') {
    const enabling = isTruthyGate(b.enableAutoReply);
    const restricted = isStrictlyTrue(b.restrictToContacts) || isStrictlyTrue(b.restrictToDomain);
    if (enabling && !restricted) {
      return 'an unrestricted auto-reply answers every sender, including ones outside the allowlist; set restrictToContacts or restrictToDomain';
    }
    return null;
  }
  return null;
}

function dangerousDefaultEnvelope(methodId: string, reason: string, account: string) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          error: 'recipient_not_allowed',
          message: `${methodId} is refused while GOOGLE_OUTBOUND_ALLOWLIST is active: ${reason}.`,
          hint: 'Unset GOOGLE_OUTBOUND_ALLOWLIST, or avoid this call, to proceed.',
          retriable: false,
          account,
        }),
      },
    ],
    isError: true as const,
  };
}

function unrecognizedShapeEnvelope(methodId: string, account: string) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          error: 'recipient_not_allowed',
          message: `${methodId} has a body shape the outbound allowlist does not recognize while it is active.`,
          hint: 'Refused rather than risk an unexamined grantee; check the field names against the Discovery schema for this method.',
          retriable: false,
          account,
        }),
      },
    ],
    isError: true as const,
  };
}

// Distinct wording from unrecognizedShapeEnvelope: this path never looked
// at a body shape at all (the write just has no method-specific rule yet),
// so "a body shape ... does not recognize" would be inaccurate, including
// for calls with no body (most DELETEs).
function noRuleForGranteePatternEnvelope(methodId: string, account: string) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          error: 'recipient_not_allowed',
          message: `${methodId} writes to a grantee-shaped resource with no specific rule yet while the outbound allowlist is active.`,
          hint: 'Refused rather than risk an unexamined grantee; use a curated tool that enforces the allowlist, or ask for a rule covering this method.',
          retriable: false,
          account,
        }),
      },
    ],
    isError: true as const,
  };
}

export function collectBodyRecipients(body: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown, depth: number): void => {
    if (!v || typeof v !== 'object' || depth > 4) return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    for (const [k, x] of Object.entries(v)) {
      if ((k === 'emailAddress' || k === 'email') && typeof x === 'string' && x.includes('@')) out.push(x);
      else if (k === 'attendees' || k === 'permissions') walk(x, depth + 1);
      else if (typeof x === 'object') walk(x, depth + 1);
    }
  };
  walk(body, 0);
  return out;
}

export interface CheckOutboundOpts {
  /** The Discovery method's HTTP verb, when known. GET/HEAD are reads and
   * are never subject to the grantee-pattern fail-closed fallback below
   * (only a write can grant anything); omitted/unknown is treated as "not a
   * read", the conservative default. */
  httpMethod?: string;
  /** Path parameters of the call, when known: some grantees (Calendar ACL's
   * ruleId) are named in the URL rather than the body. */
  pathParams?: Record<string, unknown>;
}

/** Gate one escape-hatch/generated dispatch; envelope when blocked, else null. */
export function checkOutboundForMethod(
  methodId: string,
  body: unknown,
  account: string,
  env: NodeJS.ProcessEnv = process.env,
  opts: CheckOutboundOpts = {},
) {
  const list = resolveOutboundAllowlist(env);
  if (!list) return null;

  // Google's JSON parser accepts a body keyed by proto field name
  // (snake_case) as readily as its canonical lowerCamelCase JSON name; a
  // rule or scan that only ever reads the camelCase key would otherwise
  // miss the exact same field spelled the other way. Normalise once, and
  // use normalizedBody (never the original body) in every check below.
  const { value: normalizedBody, ambiguous } = normalizeBodyKeys(body);
  // Two source keys collided onto the same normalised name (e.g.
  // enable_auto_reply and enableAutoReply both present): which value
  // "won" is iteration-order noise, not a shape any rule below can trust.
  if (ambiguous) return unrecognizedShapeEnvelope(methodId, account);

  const dangerous = dangerousDefaultRefusal(methodId, normalizedBody);
  if (dangerous) return dangerousDefaultEnvelope(methodId, dangerous, account);

  // drive.accessproposals.resolve only grants nothing on a LITERAL DENY;
  // anything else (a non-string, an unrecognised string, a differently
  // cased "accept") is treated as potentially granting access, not
  // whitelisted just for not being the exact string "ACCEPT" (action is
  // Google's to interpret leniently; this check is not). drive.
  // permissions.update's body never carries the grantee at all either way.
  // See BODY_UNTRUSTED_METHODS.
  if (BODY_UNTRUSTED_METHODS.has(methodId)) {
    const isHarmlessProposalAction = methodId === 'drive.accessproposals.resolve' && asRecord(normalizedBody)?.action === 'DENY';
    if (!isHarmlessProposalAction) return unrecognizedShapeEnvelope(methodId, account);
  }

  if (RAW_SEND_METHODS.has(methodId)) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            error: 'recipient_not_allowed',
            message: `${methodId} carries an uninspectable raw message while GOOGLE_OUTBOUND_ALLOWLIST is active.`,
            hint: 'Use gmail_send / gmail_create_draft, which enforce the allowlist on parsed recipients.',
            retriable: false,
            account,
          }),
        },
      ],
      isError: true as const,
    };
  }

  const bodyGrantee = GRANTEE_METHODS.has(methodId) ? granteeCheck(methodId, normalizedBody) : null;
  const fromPath = pathParamGrantee(methodId, opts.pathParams);
  if (bodyGrantee || fromPath) {
    const grantee = mergeGrantee(bodyGrantee, fromPath);
    if (!grantee.understood) return unrecognizedShapeEnvelope(methodId, account);
    if (grantee.public) return outboundDeniedEnvelope(`${methodId} grantee`, ['anyone (public)'], account, env);
    const blockedDomains = grantee.domains.filter((d) => !list.entries.includes(d));
    if (blockedDomains.length > 0) return outboundDeniedEnvelope(`${methodId} domain grantee`, blockedDomains, account, env);
    // The method-aware rule above and the generic emailAddress/email key walk
    // both run (not either/or): the rule catches shapes the walk cannot see,
    // the walk catches a plain email field the rule does not know to look for.
    const emails = [...grantee.emails, ...collectBodyRecipients(normalizedBody)];
    if (emails.length > 0) {
      const envelope = checkOutbound(`${methodId} grantee`, emails, account, env);
      if (envelope) return envelope;
    }
    return null;
  }

  // No method-aware rule matched. A write whose resource name still looks
  // grantee-shaped (permissions, members, memberships, delegates, sendAs,
  // invitations, accessBindings, students, teachers, ...) is refused rather
  // than fall back to a key walk that was never taught this method's fields.
  // Three exceptions, because the pattern alone over-blocks: a DELETE only
  // revokes access (nothing is granted by removing a grantee); a handful of
  // methods that match the pattern never grant access to anyone outside the
  // caller's own data (ALWAYS_SAFE_GRANTEE_PATTERN_METHODS); and a sendAs
  // patch/update touching only signature/displayName changes nothing about
  // who can send as the identity.
  const httpVerb = (opts.httpMethod ?? '').toUpperCase();
  const isRead = /^(GET|HEAD)$/.test(httpVerb);
  const isRemoval = httpVerb === 'DELETE';
  if (
    !isRead &&
    !isRemoval &&
    !ALWAYS_SAFE_GRANTEE_PATTERN_METHODS.has(methodId) &&
    !isHarmlessSendAsPatch(methodId, normalizedBody) &&
    matchesGranteePattern(methodId)
  ) {
    return noRuleForGranteePatternEnvelope(methodId, account);
  }

  return checkOutbound(`${methodId} recipient`, collectBodyRecipients(normalizedBody), account, env);
}
