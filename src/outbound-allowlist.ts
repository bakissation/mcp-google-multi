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
  'drive.permissions.update',
  'gmail.users.settings.delegates.create',
  'gmail.users.settings.forwardingAddresses.create',
  'gmail.users.settings.sendAs.create',
  'gmail.users.settings.filters.create',
  'calendar.acl.insert',
  'calendar.acl.update',
  'calendar.acl.patch',
]);

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

const UNRECOGNIZED: GranteeCheck = { emails: [], domains: [], public: false, understood: false };

/** The grantee(s) a known resource-scoped write method's body carries, or
 * null when the method isn't one of GRANTEE_METHODS (caller falls back to
 * the generic emailAddress/email key walk). */
function granteeCheck(methodId: string, body: unknown): GranteeCheck | null {
  const b = asRecord(body) ?? {};
  switch (methodId) {
    case 'drive.permissions.create':
    case 'drive.permissions.update': {
      const type = asNonEmptyString(b.type);
      if (type === 'anyone') return { emails: [], domains: [], public: true, understood: true };
      if (type === 'domain') {
        const domain = asNonEmptyString(b.domain);
        return domain ? { emails: [], domains: [`@${domain.toLowerCase()}`], public: false, understood: true } : UNRECOGNIZED;
      }
      if (type === 'user' || type === 'group') {
        const email = asNonEmptyString(b.emailAddress);
        return email ? { emails: [email], domains: [], public: false, understood: true } : UNRECOGNIZED;
      }
      return UNRECOGNIZED;
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
// independently of whatever the body's `scope` says — so a body that omits
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

  const bodyGrantee = GRANTEE_METHODS.has(methodId) ? granteeCheck(methodId, body) : null;
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
    const emails = [...grantee.emails, ...collectBodyRecipients(body)];
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
  const isRead = opts.httpMethod !== undefined && /^(get|head)$/i.test(opts.httpMethod);
  if (!isRead && matchesGranteePattern(methodId)) {
    return unrecognizedShapeEnvelope(methodId, account);
  }

  return checkOutbound(`${methodId} recipient`, collectBodyRecipients(body), account, env);
}
