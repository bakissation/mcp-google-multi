import { z } from 'zod';
import { getAccountSet, liveAccountCheck, unknownAliasMessage } from './accounts.js';
import { echoName, echoNames, MAX_SUGGESTED_KEYS } from './arg-strict.js';
import { hints } from './hint-provider.js';

export const CSV_RE = /^[a-zA-Z0-9_-]+(\s*,\s*[a-zA-Z0-9_-]+)+$/;

const FANOUT_CONCURRENCY = 5;

// `aliases` is a getter read at parse time (not baked), so a registry only
// ever sees ITS OWN account set, and a mid-session alias (account_add) is valid on tools registered before it existed.
export function fanoutAccountField(description: string, aliases: () => readonly string[]): z.ZodType {
  const boot = aliases();
  const csvExample = boot.length > 1 ? `; or a CSV subset like "${boot.slice(0, 2).join(',')}"` : '';
  // Same message on both union branches: for a string, zod surfaces the
  // single non-aborted branch (the CSV regex) verbatim, which never named the alias.
  const bad = () => unknownAliasMessage(aliases(), true);
  return z
    // The selector branch stays first: tools/list injects the live
    // '*' + alias enum into it (registry withLiveAccountEnum).
    .union([z.string().check(liveAccountCheck(aliases, true)), z.string().regex(CSV_RE, { error: bad })], { error: bad })
    .optional()
    .describe(`${description}; "*" = all accounts${csvExample}; omit for the default account`);
}

/** '*' over an empty account set would fan out to nothing and report success. */
export function noAccountsResult() {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          error: 'validation_error',
          message: 'No Google account is configured, so "*" selects nothing.',
          hint: unknownAliasMessage([]),
          retriable: false,
          account: '*',
        }),
      },
    ],
    isError: true as const,
  };
}

export type AccountSelector =
  | { ok: true; fanout: boolean; aliases: string[] }
  | { ok: false; invalid: string[] };

export function parseAccountSelector(value: string, accounts: readonly string[] = getAccountSet().aliases): AccountSelector {
  if (value === '*') return { ok: true, fanout: true, aliases: [...accounts] };
  // A single alias used to skip validation and reach getClient, whose throw
  // landed on the mapper's floor as an unclassified upstream_error.
  if (!value.includes(',')) {
    return accounts.includes(value)
      ? { ok: true, fanout: false, aliases: [value] }
      : { ok: false, invalid: [value] };
  }
  const seen = new Set<string>();
  const aliases: string[] = [];
  const invalid: string[] = [];
  for (const token of value.split(',').map((t) => t.trim()).filter(Boolean)) {
    if (!accounts.includes(token)) {
      invalid.push(token);
    } else if (!seen.has(token)) {
      seen.add(token);
      aliases.push(token);
    }
  }
  if (invalid.length > 0) return { ok: false, invalid };
  // Keyed on the CSV FORM, not the deduped count: "a,a" asked for the merged
  // multi-account envelope and used to get a bare single-account payload.
  return { ok: true, fanout: true, aliases };
}

export function invalidAccountsResult(invalid: string[], accounts: readonly string[] = getAccountSet().aliases) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          error: 'validation_error',
          // The caller's CSV can hold any number of tokens: echo a prefix.
          message: `Unknown account alias(es): ${echoNames(invalid)}.`,
          hint: unknownAliasMessage(accounts, true),
          retriable: false,
          account: invalid.slice(0, MAX_SUGGESTED_KEYS).map(echoName).join(','),
        }),
      },
    ],
    isError: true as const,
  };
}

interface ToolResult {
  content?: { type?: string; text?: string }[];
  isError?: boolean;
}

export interface FanoutEntry {
  account: string;
  ok: boolean;
  /** The account's token does not carry the scope this tool needs, so it was
   * left out rather than counted as a failure; `error` keeps the detail. */
  skipped?: boolean;
  data?: unknown;
  error?: unknown;
}

function parsePayload(result: ToolResult | undefined): unknown {
  const text = result?.content?.[0]?.text;
  if (typeof text !== 'string') return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function runFanout(
  handler: (...a: unknown[]) => unknown,
  args: unknown[],
  aliases: string[],
): Promise<{ content: { type: 'text'; text: string }[]; isError?: true }> {
  const results: FanoutEntry[] = new Array(aliases.length);
  let next = 0;
  const worker = async () => {
    while (next < aliases.length) {
      const i = next++;
      const account = aliases[i];
      try {
        const res = (await handler({ ...(args[0] as object), account }, ...args.slice(1))) as ToolResult;
        const payload = parsePayload(res);
        const missingScope = res?.isError && (payload as { error?: string } | null)?.error === 'insufficient_scope';
        results[i] = res?.isError
          ? { account, ok: false, ...(missingScope ? { skipped: true } : {}), error: payload }
          : { account, ok: true, data: payload };
      } catch (err) {
        const rendered = hints()?.render({ kind: 'internal', account });
        results[i] = {
          account,
          ok: false,
          error: {
            error: 'internal',
            message: rendered?.message ?? (err as Error).message,
            hint: rendered?.hint,
            retriable: false,
            account,
          },
        };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(FANOUT_CONCURRENCY, aliases.length) }, () => worker()));
  const failed = results.filter((r) => !r.ok).length;
  // An account that lacks the scope is not a failure of the call when another
  // account answered: it is listed as skipped and does not mark the result partial.
  const skipped = results.filter((r) => r.skipped).map((r) => r.account);
  const failedForReal = results.filter((r) => !r.ok && !r.skipped).length;
  if (failed === results.length && results.length > 0) {
    // Every account failed, so this IS an error result: hoist a real
    // top-level envelope (error/hint/retriable), keeping the per-account detail.
    const slugs = [...new Set(results.map((r) => (r.error as { error?: string } | undefined)?.error ?? 'internal'))];
    const hints = [...new Set(results.map((r) => (r.error as { hint?: string } | undefined)?.hint).filter(Boolean))];
    const retriable = results.every((r) => (r.error as { retriable?: boolean } | undefined)?.retriable === true);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({
        error: 'fanout_failed',
        message: `All ${results.length} accounts failed: ${slugs.join(', ')}. Per-account detail is in results.`,
        hint: hints.length === 1 ? hints[0] : 'Each entry in results carries its own error and hint; they differ per account.',
        retriable,
        account: aliases.join(','),
        results,
        partial: true,
      }) }],
      isError: true as const,
    };
  }
  const body = { results, partial: failedForReal > 0, ...(skipped.length > 0 ? { skipped } : {}) };
  return { content: [{ type: 'text' as const, text: JSON.stringify(body) }] };
}
