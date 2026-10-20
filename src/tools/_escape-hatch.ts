// Shared write-control gate for the escape hatch (google_api_call and
// every generated per-method tool): a read is always allowed; a hard
// read-only setting or an explicit deny refuses outright, never asking;
// full-writes with GOOGLE_OUTBOUND_ALLOWLIST unset allows outright;
// everything else asks a human via MCP elicitation, server-side, showing
// the real call, and executes only on "accept".
import type { ToolRegistry, Cud } from '../registry.js';
import { escapeHatchVerdict, writeDisabledResult, type Policy } from '../write-control.js';
import { resolveOutboundAllowlist } from '../outbound-allowlist.js';
import { jsonResult } from '../executor.js';

export interface EscapeHatchCallInfo {
  account: string;
  accountEmail?: string;
  methodId: string;
  httpMethod: string;
  pathParams?: Record<string, unknown>;
  queryParams?: Record<string, unknown>;
  body?: unknown;
}

// ROUND 7 (MEDIUM 3): every DISPLAYED string is run through this first.
// \p{Cc} (controls, incl. \n/\r/\t, which is fine: this only touches
// individual VALUES before they are embedded in the template, never the
// template's own line breaks), \p{Cf} (format, incl. bidi overrides),
// \p{Zl}/\p{Zp} (U+2028/U+2029) can otherwise forge what looks like a
// genuine new prompt line ("Body: (none)\nAccept to run it...") inside an
// attacker-controlled value. Escaped visibly rather than stripped, so the
// fake line reads as the literal escape text instead of silently vanishing.
const HIDDEN_CHAR_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
function sanitizeDisplay(value: string): string {
  return value.replace(HIDDEN_CHAR_RE, (ch) => `\\u${ch.codePointAt(0)!.toString(16).padStart(4, '0')}`);
}

// ROUND 7 (HIGH 2): redact by KEY NAME, never by what a value looks like.
// The old value-shape regex (a long quoted token-looking string) is gone:
// it swallowed real destinations (Gmail raw, Drive parents) exactly as
// readily as a real secret, and nothing here ever sees a real secret in
// the first place (OAuth tokens live in the token store, never in a tool
// call's own arguments), so there is nothing to protect by value shape.
const SECRET_KEY_RE = /(token|secret|password|passwd|authoriz|api[_-]?key|private[_-]?key|credential)/i;

function redactSecretsByKey(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value as object)) return '[circular]';
  seen.add(value as object);
  if (Array.isArray(value)) return value.map((v) => redactSecretsByKey(v, seen));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEY_RE.test(k) ? '[redacted]' : redactSecretsByKey(v, seen);
  }
  return out;
}

// ROUND 7 (HIGH 2): what the Destinations section looks for, recursively,
// across pathParams, queryParams and body. Two independent signals: the
// VALUE looks like an email or a URL (wherever it sits), or the KEY looks
// like it names a destination/target outright (a Drive parent, an owner,
// a path param naming the resource acted on) even when the value itself
// is just an opaque id with no recognizable shape of its own.
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const URL_RE = /\bhttps?:\/\/[^\s"'<>]+/gi;
const DESTINATION_KEY_RE =
  /^(parents?|folder[_-]?id|new[_-]?owner|owner|destination|target|recipient|delegate(email)?|forwarding(email)?|send[_-]?as(email)?|grantee|member|attendee|to|cc|bcc|email(address)?|address|file[_-]?id|calendar[_-]?id|user[_-]?id|space[_-]?id|document[_-]?id|spreadsheet[_-]?id|presentation[_-]?id|drive[_-]?id|group[_-]?id|customer[_-]?id|device[_-]?id)$/i;

const MAX_DESTINATION_LEN = 200;

function lastKeySegment(keyPath: string): string {
  const cleaned = keyPath.replace(/\[\d+\]/g, '');
  const parts = cleaned.split('.');
  return parts[parts.length - 1] ?? '';
}

function collectDestinations(value: unknown, keyPath: string, out: string[], seen: WeakSet<object>): void {
  if (value === null || value === undefined) return;
  if (typeof value === 'string') {
    const lastKey = lastKeySegment(keyPath);
    if (DESTINATION_KEY_RE.test(lastKey) && value.length > 0) out.push(value);
    for (const m of value.matchAll(EMAIL_RE)) out.push(m[0]);
    for (const m of value.matchAll(URL_RE)) out.push(m[0]);
    return;
  }
  if (typeof value !== 'object') return;
  if (seen.has(value as object)) return;
  seen.add(value as object);
  if (Array.isArray(value)) {
    value.forEach((v, i) => collectDestinations(v, `${keyPath}[${i}]`, out, seen));
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    collectDestinations(v, keyPath ? `${keyPath}.${k}` : k, out, seen);
  }
}

// ROUND 7 (HIGH 2): a Gmail `raw` field is base64url-encoded RFC 822 MIME;
// the body summary otherwise hides its real recipients entirely. Found by
// KEY NAME anywhere in the body (gmail.users.messages.send carries it at
// the top level, gmail.users.drafts.update under message.raw). A `raw`
// that fails to decode, or decodes to something with no recognizable
// header block, cannot be summarized safely: the caller refuses rather
// than show a confirmation that might not describe the real destination.
const WANTED_HEADERS = ['to', 'cc', 'bcc', 'from', 'reply-to', 'subject'];

function decodeGmailRaw(raw: string): Record<string, string> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(raw, 'base64url').toString('utf-8');
  } catch {
    return null;
  }
  if (!decoded) return null;
  const headerBlockEnd = decoded.search(/\r?\n\r?\n/);
  const headerBlock = headerBlockEnd === -1 ? decoded : decoded.slice(0, headerBlockEnd);
  const headers: Record<string, string> = {};
  let current: string | null = null;
  for (const line of headerBlock.split(/\r?\n/)) {
    // Space before the colon is legal older RFC syntax, and a repeated header
    // must append: overwriting would hide one recipient from the confirmation.
    const m = /^([A-Za-z-]+)[ \t]*:\s*(.*)$/.exec(line);
    if (m && WANTED_HEADERS.includes(m[1].toLowerCase())) {
      current = m[1].toLowerCase();
      headers[current] = headers[current] ? `${headers[current]}, ${m[2]}` : m[2];
    } else if (current && /^[ \t]/.test(line)) {
      headers[current] += ` ${line.trim()}`;
    } else {
      current = null;
    }
  }
  return Object.keys(headers).length > 0 ? headers : null;
}

/** Every `raw` string found anywhere in `value`, by key name. */
function collectRawFields(value: unknown, out: string[], seen: WeakSet<object> = new WeakSet()): void {
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value as object)) return;
  seen.add(value as object);
  if (Array.isArray(value)) {
    for (const v of value) collectRawFields(v, out, seen);
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === 'raw' && typeof v === 'string') out.push(v);
    else collectRawFields(v, out, seen);
  }
}

interface Summary {
  ok: true;
  destinationsText: string;
  bodyText: string;
}
interface SummaryFailure {
  ok: false;
  reason: string;
}

const MAX_BODY_CHARS = 500;

/** Builds the Destinations section and the (secret-key-redacted, length-
 * capped) Body section for the confirmation prompt, or reports that the
 * body cannot be summarized safely at all. Destinations are never cut:
 * only the Body JSON is subject to the character cap. */
function buildSummary(info: EscapeHatchCallInfo): Summary | SummaryFailure {
  const seen = new WeakSet<object>();
  const destinations: string[] = [];
  collectDestinations(info.pathParams, 'pathParams', destinations, seen);
  collectDestinations(info.queryParams, 'queryParams', destinations, seen);
  collectDestinations(info.body, 'body', destinations, seen);

  const rawFields: string[] = [];
  collectRawFields(info.body, rawFields);
  for (const raw of rawFields) {
    const headers = decodeGmailRaw(raw);
    if (!headers) {
      return { ok: false, reason: 'the request body carries a "raw" field that could not be decoded as a MIME message' };
    }
    for (const [name, headerValue] of Object.entries(headers)) {
      destinations.push(`${name}: ${headerValue}`);
    }
  }

  const dedupedDestinations = [...new Set(destinations)].map((d) => sanitizeDisplay(d.length > MAX_DESTINATION_LEN ? `${d.slice(0, MAX_DESTINATION_LEN)}...` : d));
  const destinationsText = dedupedDestinations.length > 0 ? dedupedDestinations.join('; ') : '(none found)';

  let bodyText: string;
  try {
    bodyText = JSON.stringify(redactSecretsByKey(info.body)) ?? '(none)';
  } catch {
    return { ok: false, reason: 'the request body could not be serialized for the confirmation prompt' };
  }
  bodyText = sanitizeDisplay(bodyText);
  if (bodyText.length > MAX_BODY_CHARS) {
    bodyText = `${bodyText.slice(0, MAX_BODY_CHARS)}... (truncated, ${bodyText.length} chars total)`;
  }
  return { ok: true, destinationsText, bodyText };
}

function buildPrompt(info: EscapeHatchCallInfo, summary: Summary): string {
  return [
    'A write via the Google API escape hatch needs your confirmation.',
    `Account: ${sanitizeDisplay(info.account)}${info.accountEmail ? ` (${sanitizeDisplay(info.accountEmail)})` : ''}`,
    `Method: ${sanitizeDisplay(info.methodId)}`,
    `HTTP verb: ${sanitizeDisplay(info.httpMethod)}`,
    `Path params: ${sanitizeDisplay(JSON.stringify(info.pathParams ?? {}))}`,
    `Query params: ${sanitizeDisplay(JSON.stringify(info.queryParams ?? {}))}`,
    `Destinations: ${summary.destinationsText}`,
    `Body: ${summary.bodyText}`,
    'Accept to run it as shown; decline or cancel to refuse.',
  ].join('\n');
}

const UNSUMMARIZABLE_HINT =
  'Refused rather than ask with a confirmation that might not show the real destination. Use a curated tool for this operation instead, or restructure the call so its body is plain JSON (no undecodable raw content).';

/**
 * Gate for every escape-hatch write; returns null when the call may
 * proceed (to executeApiMethod), or a ToolResult when it must not (a
 * hard refusal, the body could not be summarized safely, or the human
 * declined/cancelled/could not be asked).
 */
export async function escapeHatchGate(
  registry: ToolRegistry,
  denyNames: readonly string[],
  primaryName: string,
  base: { service: string; cud: Cud; scopes?: readonly string[] },
  policy: Policy,
  info: EscapeHatchCallInfo,
): Promise<ReturnType<typeof jsonResult> | null> {
  const outboundActive = resolveOutboundAllowlist() !== null;
  const verdict = escapeHatchVerdict(denyNames, base, primaryName, policy, outboundActive);
  if (verdict.decision === 'allow') return null;
  if (verdict.decision === 'deny') return writeDisabledResult(verdict.ref, policy, info.account);

  const summary = buildSummary(info);
  if (!summary.ok) {
    return jsonResult(
      { error: 'write_unsummarizable', message: `This write cannot be safely summarized for confirmation: ${summary.reason}.`, hint: UNSUMMARIZABLE_HINT, retriable: false, account: info.account },
      true,
    );
  }

  const outcome = await registry.elicitConfirmation(buildPrompt(info, summary));
  if (outcome.action === 'accept') return null;
  if (outcome.action === 'unsupported') {
    // Owner decision: over HTTP this covers BOTH a self-hosted HTTP
    // deployment and an EE hosted tenant, which this server cannot tell
    // apart, so the hint must not instruct the caller to set
    // GOOGLE_PROFILE (a hosted tenant cannot). stdio's causes ARE the
    // operator, so naming the env var there is safe, actionable advice.
    if (outcome.cause === 'http_transport') {
      return jsonResult(
        {
          error: 'elicitation_unsupported',
          message: 'This write needs a human confirmation that this server cannot show yet over this connection.',
          hint: 'Use a curated tool for this operation instead.',
          retriable: false,
          account: info.account,
        },
        true,
      );
    }
    return jsonResult(
      {
        error: 'elicitation_unsupported',
        message: `This write needs human confirmation, but the connected client could not be asked (${outcome.reason}).`,
        hint: 'Either set GOOGLE_PROFILE=full-writes (with GOOGLE_OUTBOUND_ALLOWLIST unset) to allow escape-hatch writes without asking, or use a curated tool for this operation instead.',
        retriable: false,
        account: info.account,
      },
      true,
    );
  }
  return jsonResult(
    {
      error: 'write_declined',
      message: `The human ${outcome.action === 'decline' ? 'declined' : 'cancelled'} this write via the Google API escape hatch.`,
      hint: 'Ask again if this should go through, or use GOOGLE_PROFILE=full-writes (with GOOGLE_OUTBOUND_ALLOWLIST unset) if escape-hatch writes should not need confirmation at all.',
      retriable: false,
      account: info.account,
    },
    true,
  );
}
