// Opt-in outbound recipient allowlist: a prompt-injection blast-radius
// control (a hijacked agent cannot mail/invite/share outside the operator's list). Off by default.
//
// Only serves CURATED tools now (drive_share, drive_permission_update,
// drive_access_proposal_resolve, drive_revision_update, gmail_send/
// create_draft/send_draft, gmail_set_vacation, calendar attendees). The
// escape hatch (google_api_call and every generated per-method tool,
// including the raw gmail.users.settings.delegates/forwardingAddresses/
// sendAs/filters methods this file used to gate) no longer has its own
// content-based reasoning here at all: a write there either fails closed
// on an explicit deny, is allowed outright under full-writes with this
// allowlist off, or asks a human via elicitation, who sees the real body
// and decides (src/tools/_escape-hatch.ts).

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

export interface GranteeCheck {
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

function asNonEmptyString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

const UNRECOGNIZED: GranteeCheck = { emails: [], domains: [], public: false, understood: false };

/** Shared by drive_share's own type/domain/emailAddress args and
 * drive_permission_update's permissions.get lookup (same resource
 * shape, fetched instead of trusted from the body: drive.permissions.update
 * only takes role/expirationTime, the grantee is named by the permissionId
 * path parameter, which Google resolves server-side). */
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
 * accessproposals.get lookup: its own body is just an ACCEPT/DENY action,
 * the requester is a property of the proposal itself. */
export function driveGranteeFromAccessProposal(proposal: { recipientEmailAddress?: string | null; requesterEmailAddress?: string | null } | null | undefined): GranteeCheck {
  const email = asNonEmptyString(proposal?.recipientEmailAddress) ?? asNonEmptyString(proposal?.requesterEmailAddress);
  return email ? { emails: [email], domains: [], public: false, understood: true } : UNRECOGNIZED;
}

function unrecognizedShapeEnvelope(kind: string, account: string) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          error: 'recipient_not_allowed',
          message: `${kind} has a body shape the outbound allowlist does not recognize while it is active.`,
          hint: 'Refused rather than risk an unexamined grantee; check the field names against the Discovery schema for this method.',
          retriable: false,
          account,
        }),
      },
    ],
    isError: true as const,
  };
}

/** Applies an already-resolved GranteeCheck against the allowlist: the
 * entry point curated tools use once they have looked up a grantee
 * themselves (drive_permission_update, drive_access_proposal_resolve). */
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
