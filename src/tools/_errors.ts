import type { Account } from '../accounts.js';

/** Maps googleapis errors to MCP tool responses. 401 → re-auth instruction; 403 + hint → structured hint payload; 429 → retry-after; else → {error, code}. */
export function handleGoogleApiError(error: any, account: Account, forbiddenHint?: string) {
  if (error.code === 401) {
    return {
      content: [{
        type: 'text' as const,
        text: `Authentication error for account "${account}". Run: node dist/index.js auth --account ${account}`,
      }],
      isError: true as const,
    };
  }
  if (error.code === 403 && forbiddenHint) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          error: 'forbidden',
          hint: forbiddenHint,
          original: error.message ?? String(error),
        }),
      }],
      isError: true as const,
    };
  }
  if (error.code === 429) {
    const retryAfter = error.response?.headers?.['retry-after'] ?? 'unknown';
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ error: 'rate_limited', retryAfter }),
      }],
      isError: true as const,
    };
  }
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({ error: error.message ?? String(error), code: error.code }),
    }],
    isError: true as const,
  };
}
