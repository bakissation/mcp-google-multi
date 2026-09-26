// B13 in-call re-auth (BV-1): a dead/missing per-account Google token is a
// leg-C failure. Over stdio the fix is the `auth --account` CLI; over HTTP the
// user cannot run a CLI, so the hint becomes a clickable, server-signed link
// into the AS's clientless alias_reauth flow (AuthServer.reauthLink). The HTTP
// bootstrap installs the linker when the AS starts; stdio never does.

let httpReauthLink: ((alias: string) => string) | null = null;

export function setHttpReauthLink(linker: ((alias: string) => string) | null): void {
  httpReauthLink = linker;
}

export function reauthHint(account: string): string {
  if (httpReauthLink) {
    return `Re-authenticate "${account}" in your browser, then retry: ${httpReauthLink(account)}`;
  }
  return `Run: npx mcp-google-multi auth --account ${account}`;
}
