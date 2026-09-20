import type { Account } from '../accounts.js';
import { reauthHint } from '../reauth-hint.js';

export interface ErrorEnvelope {
  error: string;
  message: string;
  hint?: string;
  retriable: boolean;
  account: string;
}

function statusOf(error: any): number | undefined {
  const c = error?.code ?? error?.status ?? error?.response?.status;
  const n = typeof c === 'string' ? Number(c) : c;
  return Number.isFinite(n) ? n : undefined;
}

function reasonOf(error: any): string | undefined {
  return (
    error?.errors?.[0]?.reason ??
    error?.response?.data?.error?.errors?.[0]?.reason ??
    error?.response?.data?.error?.status
  );
}

function messageOf(error: any): string {
  return error?.response?.data?.error?.message ?? error?.message ?? String(error);
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

export function mapGoogleError(
  error: any,
  account: Account,
  forbiddenHint?: string,
  scopeContext?: () => { hint: string; retriable: boolean } | null,
): ErrorEnvelope {
  const status = statusOf(error);
  const reason = reasonOf(error);
  const message = messageOf(error);

  // 7-day Testing-mode trap: a BYO OAuth client in "Testing" status expires
  // refresh tokens weekly; the dead token surfaces as invalid_grant. Name the
  // real fix (publish to production) so the agent stops looping on re-auth.
  // Checked before the generic 401 so it wins on either 400 or 401.
  const rawError = error?.response?.data?.error;
  const grantHaystack = [message, reason, typeof rawError === 'string' ? rawError : '', error?.response?.data?.error_description]
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
    // API not enabled for the project: a distinct, self-serve fix (enable the
    // API) rather than a scope/permission dead-end.
    const notEnabled =
      reason === 'accessNotConfigured' ||
      reason === 'SERVICE_DISABLED' ||
      /has not been used in project|accessNotConfigured|SERVICE_DISABLED|it is disabled/i.test(message);
    if (notEnabled) {
      const api = disabledApiId(message);
      return {
        error: 'api_not_enabled',
        message,
        hint: api
          ? `Enable this API for your project: ${apiEnableLink(api)}`
          : 'Enable the API for your project at https://console.cloud.google.com/apis/library',
        retriable: false,
        account,
      };
    }
    const scopeIssue =
      reason === 'insufficientPermissions' ||
      reason === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' ||
      /insufficient.*scope/i.test(message);
    if (scopeIssue) {
      // #114 three-state enrichment when the method's required scopes are
      // known (escape hatch / generated tools): state-specific remediation and
      // an honest retriable so agents stop retrying dead ends.
      const enriched = scopeContext?.() ?? null;
      return {
        error: 'insufficient_scope',
        message,
        hint: enriched?.hint ?? forbiddenHint ?? `Re-auth "${account}" with the scope this operation needs.`,
        retriable: enriched?.retriable ?? false,
        account,
      };
    }
    return {
      error: 'forbidden',
      message,
      hint:
        forbiddenHint ??
        `Google denied access at the resource level (not a scope problem): check that "${account}" actually has access to this item, e.g. it is shared with that account, and that you picked the right account alias.`,
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
  if (status === 429) {
    const retryAfter = error?.response?.headers?.['retry-after'];
    // GA4 quota exhaustion ("Exhausted property tokens ...") is a per-property
    // token bucket, not a transient rate spike: shrinking the request is the
    // lever that helps, and a blind immediate retry only burns more tokens.
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
    return {
      error: 'rate_limited',
      message,
      hint: retryAfter ? `Retry after ${retryAfter}s.` : 'Back off and retry.',
      retriable: true,
      account,
    };
  }
  if (status !== undefined && status >= 500) {
    return {
      error: 'upstream_error',
      message,
      hint: 'Google-side server error, usually transient: retry, with backoff if it repeats.',
      retriable: true,
      account,
    };
  }
  if (status === undefined) {
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
  // Passthrough floor: still emit a hint so no envelope leaves the mapper
  // without a next step. A 400 here is a request Google parsed and rejected.
  return {
    error: 'upstream_error',
    message,
    hint:
      status === 400
        ? 'Google rejected the request as malformed: an argument is likely wrong or missing. Check IDs, enum values and formats against the tool description before retrying.'
        : 'Unclassified error: the message above is the best signal. Retry only if it reads as transient; otherwise change the request rather than repeating it.',
    retriable: false,
    account,
  };
}

export function handleGoogleApiError(error: any, account: Account, forbiddenHint?: string, scopeContext?: () => { hint: string; retriable: boolean } | null) {
  const envelope = mapGoogleError(error, account, forbiddenHint, scopeContext);
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(envelope) }],
    isError: true as const,
  };
}
