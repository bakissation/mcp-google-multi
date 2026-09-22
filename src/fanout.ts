import { z } from 'zod';
import { ACCOUNTS, getAccountSet, unknownAliasMessage } from './accounts.js';

export const CSV_RE = /^[a-zA-Z0-9_-]+(\s*,\s*[a-zA-Z0-9_-]+)+$/;

const FANOUT_CONCURRENCY = 5;

export function fanoutAccountField(description: string): z.ZodType {
  const csvExample = ACCOUNTS.length > 1 ? `; or a CSV subset like "${ACCOUNTS.slice(0, 2).join(',')}"` : '';
  // The union's OWN error only fires when every branch aborts at the type
  // check (a non-string). For a string, zod surfaces the single non-aborted
  // branch verbatim, which is the CSV regex, so a mistyped alias used to read
  // as "Invalid string: must match pattern /^[a-zA-Z0-9_-]+(,...)/" and never
  // named an alias. Hence the same message on BOTH.
  const bad = () => unknownAliasMessage(ACCOUNTS, true);
  return z
    // '*' first so the tuple is statically non-empty even when ACCOUNTS is empty
    // (a fresh install): z.enum requires [string, ...string[]].
    .union([z.enum(['*', ...ACCOUNTS]), z.string().regex(CSV_RE, { error: bad })], { error: bad })
    .optional()
    .describe(`${description}; "*" = all accounts${csvExample}; omit for the default account`);
}

export type AccountSelector =
  | { ok: true; fanout: boolean; aliases: string[] }
  | { ok: false; invalid: string[] };

export function parseAccountSelector(value: string, accounts: readonly string[] = getAccountSet().aliases): AccountSelector {
  if (value === '*') return { ok: true, fanout: true, aliases: [...accounts] };
  // A single alias used to skip validation entirely and reach getClient, whose
  // throw landed on the mapper's floor as an unclassified upstream_error. Same
  // check and same envelope wherever the alias was typed.
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
          message: `Unknown account alias(es): ${invalid.join(', ')}.`,
          hint: unknownAliasMessage(accounts, true),
          retriable: false,
          account: invalid.join(','),
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
        results[i] = res?.isError ? { account, ok: false, error: payload } : { account, ok: true, data: payload };
      } catch (err) {
        results[i] = {
          account,
          ok: false,
          error: { error: 'internal', message: (err as Error).message, retriable: false, account },
        };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(FANOUT_CONCURRENCY, aliases.length) }, () => worker()));
  const failed = results.filter((r) => !r.ok).length;
  if (failed === results.length && results.length > 0) {
    // Every account failed, so this IS an error result, and used to carry
    // `isError` with no top-level error, hint or retriable: the agent saw a
    // successful-looking object flagged as an error, and metrics bucketed it
    // as `other`. Hoist a real envelope, keeping the per-account detail.
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
  const body = { results, partial: failed > 0 };
  return { content: [{ type: 'text' as const, text: JSON.stringify(body) }] };
}
