// B13 in-call re-auth (BV-1): a dead/missing per-account Google token is a
// leg-C failure. Over stdio the fix is the `auth --account` CLI; over HTTP the
// user cannot run a CLI, so the hint becomes a clickable link into the AS's
// clientless alias_reauth flow (${BASE}/authorize?flow=alias_reauth&alias=…).
// The HTTP bootstrap sets the base when the AS starts; stdio never does.

let httpReauthBase: string | null = null;

export function setHttpReauthBase(base: string | null): void {
  httpReauthBase = base;
}

export function reauthHint(account: string): string {
  if (httpReauthBase) {
    return `Re-authenticate "${account}" in your browser, then retry: ${httpReauthBase}/authorize?flow=alias_reauth&alias=${encodeURIComponent(account)}`;
  }
  return `Run: npx mcp-google-multi auth --account ${account}`;
}
