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
  methodId: string;
  httpMethod: string;
  pathParams?: Record<string, unknown>;
  body?: unknown;
}

const TOKEN_LIKE = /"[A-Za-z0-9_-]{20,}"/g;

/** A compact, bounded, token-value-free summary of a request body for the
 * human confirmation prompt: a value that merely LOOKS like a bearer
 * token / API key / long opaque id is redacted outright, since the prompt
 * surface (a client's UI, logs) is not somewhere a real secret should land. */
function summarizeBody(body: unknown): string {
  if (body === undefined) return '(none)';
  let text: string;
  try {
    text = JSON.stringify(body);
  } catch {
    return '(unserializable)';
  }
  text = text.replace(TOKEN_LIKE, '"[redacted]"');
  const MAX = 500;
  return text.length > MAX ? `${text.slice(0, MAX)}... (truncated, ${text.length} chars total)` : text;
}

function buildPrompt(info: EscapeHatchCallInfo): string {
  return [
    'A write via the Google API escape hatch needs your confirmation.',
    `Account: ${info.account}`,
    `Method: ${info.methodId}`,
    `HTTP verb: ${info.httpMethod}`,
    `Path params: ${JSON.stringify(info.pathParams ?? {})}`,
    `Body: ${summarizeBody(info.body)}`,
    'Accept to run it as shown; decline or cancel to refuse.',
  ].join('\n');
}

/**
 * Gate for every escape-hatch write; returns null when the call may
 * proceed (to executeApiMethod), or a ToolResult when it must not (a
 * hard refusal, or the human declined/cancelled/could not be asked).
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

  const outcome = await registry.elicitConfirmation(buildPrompt(info));
  if (outcome.action === 'accept') return null;
  if (outcome.action === 'unsupported') {
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
