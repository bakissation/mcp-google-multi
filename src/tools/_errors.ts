import type { Account } from '../accounts.js';
import { reauthHint } from '../reauth-hint.js';
import { sliceClean, sliceEncoded } from '../trim.js';

const MAX_ERROR_MESSAGE_CHARS = 1000;
const MAX_ERROR_ENVELOPE_CHARS = 4000;
const MAX_BODY_PARSE_CHARS = 64_000;

/** A 403 means "missing scope" and "you cannot touch this resource" alike, and
 * a single hint slot for both is what told callers to add a bundle they had
 * already granted. Services now supply one hint per meaning. A bare string
 * stays accepted and keeps its old meaning, the scope one. */
export interface ServiceHints {
  scope?: string;
  resource?: string;
}

function normalizeHints(h: string | ServiceHints | undefined): ServiceHints {
  return typeof h === 'string' ? { scope: h } : (h ?? {});
}

export interface ErrorEnvelope {
  error: string;
  message: string;
  hint?: string;
  retriable: boolean;
  /** Optional because some failures genuinely precede account resolution (an
   * undeclared argument, a wizard step before the alias is known). Every
   * producer that HAS an account must still pass it. */
  account?: string;
}

function statusOf(error: any): number | undefined {
  const c = error?.code ?? error?.status ?? error?.response?.status;
  const n = typeof c === 'string' ? Number(c) : c;
  return Number.isFinite(n) ? n : undefined;
}

/** gaxios 7 is fetch-based, so response.headers is a Headers instance with no
 * index signature; the plain-object form still appears in tests and in mocks. */
function headerOf(error: any, name: string): string | undefined {
  const h = error?.response?.headers;
  if (!h) return undefined;
  if (typeof h.get === 'function') {
    const v = h.get(name);
    return typeof v === 'string' ? v : undefined;
  }
  const key = Object.keys(h).find((k) => k.toLowerCase() === name);
  return key === undefined ? undefined : String((h as Record<string, unknown>)[key]);
}

/** gaxios hands `response.data` back as a STRING whenever it could not parse
 * JSON, and on every non-2xx of a responseType:'stream' call (drive_download,
 * drive_export), where it buffers the whole body to utf8 before throwing. So
 * the JSON error of a failed download is invisible to a plain property read. */
function errorPayload(error: any): any {
  const data = error?.response?.data;
  if (data && typeof data === 'object') return data;
  if (typeof data !== 'string') return undefined;
  const ct = headerOf(error, 'content-type')?.toLowerCase();
  if (ct && !ct.includes('json')) return undefined;
  if (data.length > MAX_BODY_PARSE_CHARS) return undefined;
  try {
    const parsed = JSON.parse(data);
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

interface RpcErrorInfo { reason?: string; domain?: string; metadata?: Record<string, string> }

/** AIP-193 google.rpc.ErrorInfo. Modern Workspace APIs (Chat, Meet, Workspace
 * Events, Analytics Data, People) put the machine-readable reason here and
 * leave errors[0].reason empty, which is why their 403s used to fall through. */
function errorInfoOf(payload: any): RpcErrorInfo | undefined {
  const details = payload?.error?.details;
  if (!Array.isArray(details)) return undefined;
  const info = details.find(
    (d: any) => typeof d?.['@type'] === 'string' && d['@type'].endsWith('/google.rpc.ErrorInfo'),
  );
  if (!info) return undefined;
  return {
    reason: typeof info.reason === 'string' ? info.reason : undefined,
    domain: typeof info.domain === 'string' ? info.domain : undefined,
    metadata: info.metadata && typeof info.metadata === 'object' ? info.metadata : undefined,
  };
}

function reasonOf(error: any, payload: any): string | undefined {
  return (
    errorInfoOf(payload)?.reason ??
    error?.errors?.[0]?.reason ??
    payload?.error?.errors?.[0]?.reason ??
    payload?.error?.status
  );
}

const MARKUP_START_RE =
  /^\uFEFF?\s*(?:<!--|<!\s*doctype\b|<\?xml\b|<\/?(?:html|head|body|meta|title|style|script|h[1-6]|div|p|pre|center|table|font)\b)/i;

/** True when error.message is a response BODY rather than an error sentence.
 * Content-Type first, shape second, markup sniff last, anchored at the start.
 * NEVER matches page TEXT: the same URL answers "Page introuvable" to a
 * French-locale account and "Page not found" to anonymous curl. */
function isRawBody(error: any, message: string): boolean {
  const ct = headerOf(error, 'content-type')?.toLowerCase();
  if (ct) return !ct.includes('json');
  if (typeof error?.response?.data === 'string') return true;
  return MARKUP_START_RE.test(message);
}

function capMessage(text: string): string {
  return text.length <= MAX_ERROR_MESSAGE_CHARS
    ? text
    : `${sliceClean(text, MAX_ERROR_MESSAGE_CHARS)} [truncated, ${text.length} chars total]`;
}

function bodyPlaceholder(error: any, status: number | undefined, length: number): string {
  const ct = headerOf(error, 'content-type')?.toLowerCase();
  const kind = ct
    ? ct.includes('html')
      ? 'an HTML error page'
      : `a non-JSON error body (${ct.split(';')[0].trim()})`
    : 'a non-JSON error body';
  const where = status === undefined ? '' : ` (HTTP ${status})`;
  return `Google returned ${kind} instead of a JSON error${where}; ${length} chars suppressed.`;
}

/** The ONE extraction point for every Google-originated message. Without the
 * raw-body guard, gaxios copies the entire response body into error.message,
 * which put 8.5 KB of Google's HTML front-end page inside a JSON envelope. */
export function safeMessage(
  error: any,
  payload: any = errorPayload(error),
  status: number | undefined = statusOf(error),
): string {
  const structured = payload?.error?.message;
  if (typeof structured === 'string' && structured.trim() !== '') return capMessage(structured);
  const raw = typeof error?.message === 'string' ? error.message : String(error);
  return isRawBody(error, raw) ? bodyPlaceholder(error, status, raw.length) : capMessage(raw);
}

// Connect/DNS syscall codes. ENOTFOUND (no such name) is the one non-transient
// member. node-fetch flattens the happy-eyeballs AggregateError to a bare code
// with an empty message, so the code is the only surviving signal to surface.
const RETRIABLE_NET_CODES = new Set([
  'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ENETUNREACH',
  'EHOSTUNREACH', 'EPIPE', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
]);
const NET_CODES = new Set([...RETRIABLE_NET_CODES, 'ENOTFOUND']);

// Local-filesystem syscall codes from caller-supplied paths (localPath/savePath).
// String codes, so they never collide with Google's numeric statuses; the
// network codes above are deliberately excluded.
const LOCAL_FS_CODES = new Set(['ENOENT', 'EACCES', 'EISDIR', 'ENOTDIR', 'EPERM', 'ELOOP', 'ENAMETOOLONG', 'ENOSPC']);

/** First known network code on the error or its cause chain (GaxiosError.cause
 * -> FetchError; undici TypeError.cause -> AggregateError.errors). */
function netCodeOf(error: any): string | undefined {
  for (let e = error, depth = 0; e && depth < 5; e = e.cause ?? e.error, depth++) {
    if (typeof e.code === 'string' && NET_CODES.has(e.code)) return e.code;
    if (Array.isArray(e.errors)) {
      const sub = e.errors.find((x: any) => typeof x?.code === 'string' && NET_CODES.has(x.code));
      if (sub) return sub.code;
    }
  }
  return undefined;
}

/** Console deep-link to enable one API (noob-proofing hint, B10). */
function apiEnableLink(api: string): string {
  return `https://console.cloud.google.com/apis/library/${api}.googleapis.com`;
}

/** Extract the disabled API id from an accessNotConfigured / SERVICE_DISABLED
 * error so the hint can deep-link straight to its enable page. */
function disabledApiId(message: string): string | null {
  const url = message.match(/\/apis\/api\/([a-z0-9-]+)\.googleapis\.com/i);
  if (url) return url[1].toLowerCase();
  const named = message.match(/\b([A-Za-z][A-Za-z0-9 ]*?) API has not been used/);
  if (named) return named[1].trim().toLowerCase().replace(/\s+/g, '');
  return null;
}

// Several APIs report quota as a 403 with a quota reason (Drive, Calendar).
// Answering 'forbidden' with a sharing hint sends the agent the wrong way.
const FORBIDDEN_RATE_REASONS = new Set([
  'rateLimitExceeded', 'userRateLimitExceeded', 'dailyLimitExceeded',
  'sharingRateLimitExceeded', 'quotaExceeded', 'RATE_LIMIT_EXCEEDED', 'RESOURCE_EXHAUSTED',
]);

// Google already answered correctly: the file type is wrong for the tool, not
// the permissions. The escape hatch has said this for years (executor.ts); the
// curated pair used to discard it and blame sharing instead.
const WRONG_TOOL_HINTS: Record<string, string> = {
  fileNotDownloadable:
    'This is a Google Workspace native file (Doc, Sheet, Slides): it has no binary content to download. Use drive_export with a target mimeType such as application/pdf.',
  fileNotExportable:
    'Export only works on Google Workspace native files. This one already has binary content: use drive_download to save it as is.',
};

function rateLimited(error: any, message: string, account: Account, reason?: string): ErrorEnvelope {
  // GA4 quota is a per-property token bucket, not a transient spike: shrinking
  // the request is the lever, and a blind retry only burns more tokens.
  if (/property tokens/i.test(message)) {
    return {
      error: 'rate_limited',
      message,
      hint:
        'GA4 quotas are per-property token buckets that refill over the hour/day. ' +
        'Narrow the date range, request fewer dimensions/metrics/rows, and pass returnPropertyQuota to see the remaining tokens before retrying.',
      retriable: true,
      account,
    };
  }
  if (reason === 'dailyLimitExceeded') {
    return {
      error: 'rate_limited',
      message,
      hint: 'A per-day project quota, not a burst limit: it resets at midnight Pacific. Reduce call volume or raise the quota in the Cloud Console; a tight retry loop will not clear it.',
      retriable: true,
      account,
    };
  }
  const retryAfter = headerOf(error, 'retry-after');
  return {
    error: 'rate_limited',
    message,
    hint: retryAfter ? `Retry after ${retryAfter}s.` : 'A short-window rate limit. Back off and retry.',
    retriable: true,
    account,
  };
}

/** Prefer AIP metadata (service + consumer) over scraping the message: the
 * scrape stays as the fallback because Google's JSON error text is English
 * only, unlike its localized HTML pages. */
function enableHint(info: RpcErrorInfo | undefined, message: string): string {
  const service = info?.metadata?.service;
  const project = info?.metadata?.consumer?.replace(/^projects\//, '');
  if (service) {
    const q = project ? `?project=${encodeURIComponent(project)}` : '';
    return `Enable this API for your project: https://console.cloud.google.com/apis/library/${service}${q}`;
  }
  const api = disabledApiId(message);
  return api
    ? `Enable this API for your project: ${apiEnableLink(api)}`
    : 'Enable the API for your project at https://console.cloud.google.com/apis/library';
}

export function mapGoogleError(
  error: any,
  account: Account,
  serviceHints?: string | ServiceHints,
  scopeContext?: () => { hint: string; retriable: boolean } | null,
): ErrorEnvelope {
  const status = statusOf(error);
  const payload = errorPayload(error);
  const reason = reasonOf(error, payload);
  const message = safeMessage(error, payload, status);
  const hints = normalizeHints(serviceHints);

  // 7-day Testing-mode trap: a BYO OAuth client in "Testing" status expires
  // refresh tokens weekly; the dead token surfaces as invalid_grant. Name the
  // real fix (publish to production) so the agent stops looping on re-auth.
  // Checked before the generic 401 so it wins on either 400 or 401.
  const rawError = payload?.error;
  const grantHaystack = [message, reason, typeof rawError === 'string' ? rawError : '', payload?.error_description]
    .filter(Boolean)
    .join(' ');
  if ((status === 400 || status === 401) && /invalid_grant/i.test(grantHaystack)) {
    return {
      error: 'reauth_required',
      message,
      hint:
        `Refresh token for "${account}" is dead (often the 7-day Testing-mode trap). ` +
        'Set Publishing status to In production at https://console.cloud.google.com/auth/audience, ' +
        `then ${reauthHint(account)}`,
      retriable: false,
      account,
    };
  }
  if (status === 401) {
    return {
      error: 'auth_required',
      message: `Authentication failed for account "${account}".`,
      hint: reauthHint(account),
      retriable: false,
      account,
    };
  }
  if (status === 403) {
    const info = errorInfoOf(payload);
    if (reason && FORBIDDEN_RATE_REASONS.has(reason)) return rateLimited(error, message, account, reason);

    const wrongTool = WRONG_TOOL_HINTS[reason ?? ''];
    if (wrongTool) return { error: 'binary_unsupported', message, hint: wrongTool, retriable: false, account };

    const notEnabled =
      reason === 'accessNotConfigured' ||
      reason === 'SERVICE_DISABLED' ||
      /has not been used in project|accessNotConfigured|SERVICE_DISABLED|it is disabled/i.test(message);
    if (notEnabled) {
      return { error: 'api_not_enabled', message, hint: enableHint(info, message), retriable: false, account };
    }

    // The scope hint fires ONLY on the machine-readable token. A coarse AIP
    // status of PERMISSION_DENIED is equally true of a resource denial, and
    // branching on it is what told callers to add a bundle they already had.
    const scopeIssue =
      reason === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' ||
      reason === 'insufficientPermissions' ||
      /\bACCESS_TOKEN_SCOPE_INSUFFICIENT\b/.test(message);
    if (scopeIssue) {
      const enriched = scopeContext?.() ?? null;
      return {
        error: 'insufficient_scope',
        message,
        hint: enriched?.hint ?? hints.scope ?? `Re-auth "${account}" with the scope this operation needs. ${reauthHint(account)}`,
        retriable: enriched?.retriable ?? false,
        account,
      };
    }

    if (reason === 'storageQuotaExceeded') {
      return { error: 'forbidden', message, hint: `Drive storage for "${account}" is full. Free space or use another account; retrying will not help.`, retriable: false, account };
    }
    if (reason === 'CONSUMER_SUSPENDED' || reason === 'accountSuspended') {
      return { error: 'forbidden', message, hint: `Google has suspended the project or the account behind "${account}". Check the Cloud Console notifications; no change to the request will fix this.`, retriable: false, account };
    }
    if (reason === 'domainPolicy' || reason === 'ORG_RESTRICTION_VIOLATION') {
      return { error: 'forbidden', message, hint: `A Workspace admin policy blocks this operation for the domain of "${account}". A super-admin has to allow the app or the feature; re-auth will not change it.`, retriable: false, account };
    }

    return {
      error: 'forbidden',
      message,
      hint:
        hints.resource ??
        `Google denied access to this resource for "${account}". Check that the item exists and is shared with this account, that you picked the right account alias, and for Workspace items that no admin policy blocks it. If a missing scope is also possible, run diagnose.`,
      retriable: false,
      account,
    };
  }
  if (status === 400 && /invalid[_ ]scope/i.test(message)) {
    return {
      error: 'invalid_scope',
      message,
      hint: 'One of the requested OAuth scopes is malformed or unavailable to this client. Run `config check` to review the account scope profile, fix it, then re-auth.',
      retriable: false,
      account,
    };
  }
  if (status === 404) {
    return {
      error: 'not_found',
      message,
      hint: `The ID does not exist or is not visible to "${account}". IDs are account-specific: re-fetch it with the matching list/search tool, and check the account alias is the one that owns the resource.`,
      retriable: false,
      account,
    };
  }
  if (status === 429) return rateLimited(error, message, account, reason);
  if (status !== undefined && status >= 500) {
    return {
      error: 'upstream_error',
      message,
      hint: 'Google-side server error, usually transient: retry, with backoff if it repeats.',
      retriable: true,
      account,
    };
  }
  // A caller-side 4xx and a Google outage used to share `upstream_error`, so a
  // consumer keying on the slug could not tell "your request is wrong, never
  // retry" from "Google is having a bad minute, do retry".
  if (status !== undefined && status >= 400) {
    return {
      error: 'bad_request',
      message,
      hint:
        status === 400
          ? 'Google parsed the request and rejected it: an argument is likely wrong or missing. Check IDs, enum values and formats against the tool description before retrying.'
          : `Google rejected the request with HTTP ${status}: a conflict, a failed precondition or an unsupported operation. Change the request rather than repeating it.`,
      retriable: false,
      account,
    };
  }
  if (status === undefined) {
    // The server's own preconditions, tagged at the throw site in client.ts.
    // Untagged they reached the floor and were reported as Google failures.
    if (error?.code === 'E_NO_TOKEN') {
      return { error: 'auth_required', message, hint: reauthHint(account), retriable: false, account };
    }
    if (error?.code === 'E_NO_OAUTH_CLIENT') {
      return {
        error: 'invalid_client',
        message,
        hint: 'Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (see docs/google-cloud-setup.md), then restart the server.',
        retriable: false,
        account,
      };
    }
    if (error?.code === 'E_UNKNOWN_ACCOUNT') {
      return {
        error: 'validation_error',
        message,
        hint: 'Pass one of the configured aliases, or omit account to use the default. Call account_list to see them.',
        retriable: false,
        account,
      };
    }
    const fsCode = typeof error?.code === 'string' && LOCAL_FS_CODES.has(error.code) ? error.code : undefined;
    if (fsCode) {
      const p = typeof error?.path === 'string' ? ` "${error.path}"` : '';
      return {
        error: 'invalid_params',
        message: `Cannot access local path${p}: ${fsCode}`,
        hint:
          'The path must exist on the machine running this server and be accessible to it. ' +
          'When the server runs remotely (HTTP transport), paths on your own machine are not visible to it.',
        retriable: false,
        account,
      };
    }
    const netCode = netCodeOf(error);
    if (netCode) {
      return {
        error: 'network_error',
        message: message.includes(netCode) ? message : message.endsWith('reason: ') ? `${message}${netCode}` : `${message} (${netCode})`,
        hint:
          `Network failure (${netCode}) before reaching Google - not an auth or API problem. Usually transient: retry. ` +
          'If it persists on a high-latency or broken-IPv6 link, raise the happy-eyeballs budget: NODE_OPTIONS=--network-family-autoselection-attempt-timeout=4000 (server default 2000ms), and check connectivity with curl.',
        retriable: RETRIABLE_NET_CODES.has(netCode),
        account,
      };
    }
  }
  // A gaxios-shaped error carries `response` or `config`, so the request left
  // this process. Anything else threw INSIDE the server (a TypeError in a
  // handler, a missing key), and calling that `upstream_error` blamed Google
  // for our own bug: an empty messageId used to surface exactly that way.
  if (error?.response !== undefined || error?.config !== undefined) {
    return {
      error: 'upstream_error',
      message,
      hint: 'The request left this server but no HTTP status came back. Retry once; if it repeats, check connectivity and the Google status dashboard.',
      retriable: false,
      account,
    };
  }
  return {
    error: 'internal',
    message,
    hint: 'This failed inside the MCP server, before any request was sent. The message above is the signal: it is most often a configuration problem such as a missing key or credential. Retrying the same call will fail the same way.',
    retriable: false,
    account,
  };
}

/** Bound the SERIALIZED envelope, not just the message: an authored hint can
 * be long too, and the error path had no cap at all before this. */
export function stringifyEnvelope(envelope: ErrorEnvelope): string {
  let out = { ...envelope };
  let text = JSON.stringify(out);
  if (text.length <= MAX_ERROR_ENVELOPE_CHARS) return text;

  const msgBudget = JSON.stringify(out.message).length - (text.length - MAX_ERROR_ENVELOPE_CHARS);
  out = {
    ...out,
    message: msgBudget < 40 ? '(message dropped: envelope size cap)' : sliceEncoded(out.message, msgBudget),
  };
  text = JSON.stringify(out);
  if (text.length <= MAX_ERROR_ENVELOPE_CHARS || typeof out.hint !== 'string') return text;

  const hintBudget = JSON.stringify(out.hint).length - (text.length - MAX_ERROR_ENVELOPE_CHARS);
  out = { ...out, hint: hintBudget < 40 ? '(hint dropped: envelope size cap)' : sliceEncoded(out.hint, hintBudget) };
  return JSON.stringify(out);
}

export function handleGoogleApiError(
  error: any,
  account: Account,
  serviceHints?: string | ServiceHints,
  scopeContext?: () => { hint: string; retriable: boolean } | null,
) {
  const envelope = mapGoogleError(error, account, serviceHints, scopeContext);
  return {
    content: [{ type: 'text' as const, text: stringifyEnvelope(envelope) }],
    isError: true as const,
  };
}

/** Local argument rejection, before any Google call. Same envelope as
 * mapGoogleError so a caller parses one shape. The slug literal stays inline
 * because the KNOWN_ERROR_SLUGS honesty test greps for `error: '<slug>'`. */
export function invalidParams(account: Account | undefined, message: string, hint: string) {
  return {
    content: [{
      type: 'text' as const,
      text: stringifyEnvelope({ error: 'invalid_params', message, hint, retriable: false, account }),
    }],
    isError: true as const,
  };
}
