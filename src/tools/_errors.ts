import type { Account } from '../accounts.js';

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

export function mapGoogleError(
  error: any,
  account: Account,
  forbiddenHint?: string,
): ErrorEnvelope {
  const status = statusOf(error);
  const reason = reasonOf(error);
  const message = messageOf(error);

  if (status === 401) {
    return {
      error: 'auth_required',
      message: `Authentication failed for account "${account}".`,
      hint: `Run: npx mcp-google-multi auth --account ${account}`,
      retriable: false,
      account,
    };
  }
  if (status === 403) {
    const scopeIssue =
      reason === 'insufficientPermissions' ||
      reason === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' ||
      /insufficient.*scope/i.test(message);
    if (scopeIssue) {
      return {
        error: 'insufficient_scope',
        message,
        hint: forbiddenHint ?? `Re-auth "${account}" with the scope this operation needs.`,
        retriable: false,
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

export function handleGoogleApiError(error: any, account: Account, forbiddenHint?: string) {
  const envelope = mapGoogleError(error, account, forbiddenHint);
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(envelope) }],
    isError: true as const,
  };
}
