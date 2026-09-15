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
    return { error: 'forbidden', message, hint: forbiddenHint, retriable: false, account };
  }
  if (status === 400 && /invalid[_ ]scope/i.test(message)) {
    return { error: 'invalid_scope', message, retriable: false, account };
  }
  if (status === 404) {
    return { error: 'not_found', message, retriable: false, account };
  }
  if (status === 429) {
    const retryAfter = error?.response?.headers?.['retry-after'];
    return {
      error: 'rate_limited',
      message,
      hint: retryAfter ? `Retry after ${retryAfter}s.` : 'Back off and retry.',
      retriable: true,
      account,
    };
  }
  if (status !== undefined && status >= 500) {
    return { error: 'upstream_error', message, retriable: true, account };
  }
  return { error: 'upstream_error', message, retriable: false, account };
}

export function handleGoogleApiError(error: any, account: Account, forbiddenHint?: string, scopeContext?: () => { hint: string; retriable: boolean } | null) {
  const envelope = mapGoogleError(error, account, forbiddenHint, scopeContext);
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(envelope) }],
    isError: true as const,
  };
}
