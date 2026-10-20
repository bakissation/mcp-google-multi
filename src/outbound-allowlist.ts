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
const RAW_SEND_METHODS = new Set(['gmail.users.messages.send', 'gmail.users.drafts.send', 'gmail.users.drafts.create', 'gmail.users.messages.insert', 'gmail.users.messages.import']);

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
      const action = asRecord(b.action);
      // No forward action is the common, ungated case: most filters only label or archive.
      if (b.action === undefined) return { emails: [], domains: [], public: false, understood: true };
      if (!action) return UNRECOGNIZED;
      const forward = asNonEmptyString(action.forward);
      return forward ? { emails: [forward], domains: [], public: false, understood: true } : { emails: [], domains: [], public: false, understood: true };
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

/** Gate one escape-hatch/generated dispatch; envelope when blocked, else null. */
export function checkOutboundForMethod(methodId: string, body: unknown, account: string, env: NodeJS.ProcessEnv = process.env) {
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
  if (GRANTEE_METHODS.has(methodId)) {
    const grantee = granteeCheck(methodId, body);
    if (!grantee || !grantee.understood) return unrecognizedShapeEnvelope(methodId, account);
    if (grantee.public) return outboundDeniedEnvelope(`${methodId} grantee`, ['anyone (public)'], account, env);
    const blockedDomains = grantee.domains.filter((d) => !list.entries.includes(d));
    if (blockedDomains.length > 0) return outboundDeniedEnvelope(`${methodId} domain grantee`, blockedDomains, account, env);
    if (grantee.emails.length > 0) {
      const envelope = checkOutbound(`${methodId} grantee`, grantee.emails, account, env);
      if (envelope) return envelope;
    }
    return null;
  }
  return checkOutbound(`${methodId} recipient`, collectBodyRecipients(body), account, env);
}
