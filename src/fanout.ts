import { z } from 'zod';
import { ACCOUNTS } from './accounts.js';

export const CSV_RE = /^[a-zA-Z0-9_-]+(\s*,\s*[a-zA-Z0-9_-]+)+$/;

const FANOUT_CONCURRENCY = 5;

export function fanoutAccountField(description: string): z.ZodType {
  const csvExample = ACCOUNTS.length > 1 ? `; or a CSV subset like "${ACCOUNTS.slice(0, 2).join(',')}"` : '';
  return z
    .union([z.enum([...ACCOUNTS, '*'] as [string, ...string[]]), z.string().regex(CSV_RE)])
    .describe(`${description}; "*" = all accounts${csvExample}`);
}

export type AccountSelector =
  | { ok: true; fanout: boolean; aliases: string[] }
  | { ok: false; invalid: string[] };

export function parseAccountSelector(value: string, accounts: readonly string[] = ACCOUNTS): AccountSelector {
  if (value === '*') return { ok: true, fanout: true, aliases: [...accounts] };
  if (!value.includes(',')) return { ok: true, fanout: false, aliases: [value] };
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
  return { ok: true, fanout: aliases.length > 1, aliases };
}

export function invalidAccountsResult(invalid: string[], accounts: readonly string[] = ACCOUNTS) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          error: 'validation_error',
          message: `Unknown account alias(es): ${invalid.join(', ')}.`,
          hint: `Valid aliases: ${accounts.join(', ')}; or "*" for all accounts.`,
          retriable: false,
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
  const body = { results, partial: failed > 0 };
  const out = { content: [{ type: 'text' as const, text: JSON.stringify(body) }] };
  return failed === results.length ? { ...out, isError: true as const } : out;
}
