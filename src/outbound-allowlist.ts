// Opt-in outbound recipient allowlist for unattended deployments: a
// prompt-injection blast-radius control (a hijacked agent cannot mail, invite
// or share outside the operator's list), a safety feature first and an
// enterprise checkbox second. FREE-core forever (ee-definition-v0 handoff).
// Off by default: an unset/empty GOOGLE_OUTBOUND_ALLOWLIST gates nothing.

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
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          error: 'recipient_not_allowed',
          message: `${kind} blocked by the outbound allowlist: ${blocked.join(', ')}.`,
          hint:
            `GOOGLE_OUTBOUND_ALLOWLIST is active (${(list?.entries ?? []).join(', ')}). ` +
            'The operator must add the address (or its @domain) to the list, or unset the variable, to allow this target.',
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

// Escape-hatch / generated-tool enforcement. Structured bodies are inspected
// for the known recipient fields; RAW compose methods cannot be inspected
// (base64 RFC 822), so with the allowlist active they are refused outright in
// favor of the curated tools that enforce it.
const RAW_SEND_METHODS = new Set(['gmail.users.messages.send', 'gmail.users.drafts.send', 'gmail.users.drafts.create', 'gmail.users.messages.insert', 'gmail.users.messages.import']);

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
  if (!resolveOutboundAllowlist(env)) return null;
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
  return checkOutbound(`${methodId} recipient`, collectBodyRecipients(body), account, env);
}
