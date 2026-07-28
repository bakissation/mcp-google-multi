import type { Account } from './accounts.js';
import { getClient } from './client.js';
import { expandPath, isGoogleApiUrl } from './discovery-client.js';
import { handleGoogleApiError } from './tools/_errors.js';

export const MAX_RESPONSE_CHARS = 100_000;

export type QueryValue = string | number | boolean;
export type QueryParams = Record<string, QueryValue | QueryValue[]>;

export interface ApiMethodRef {
  id: string;
  httpMethod: string;
  path: string;
  baseUrl: string;
  requiredParams: string[];
}

export interface ExecuteDeps {
  getClientFn?: typeof getClient;
}

export interface ExecuteArgs {
  account: string;
  pathParams?: Record<string, string | number>;
  queryParams?: QueryParams;
  body?: unknown;
}

export function jsonResult(payload: unknown, isError = false) {
  const base = { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
  return isError ? { ...base, isError: true as const } : base;
}

export function buildQueryString(queryParams: QueryParams | undefined): string {
  const usp = new URLSearchParams();
  const merged: QueryParams = { alt: 'json', ...queryParams };
  for (const [key, value] of Object.entries(merged)) {
    if (Array.isArray(value)) {
      for (const v of value) usp.append(key, String(v));
    } else {
      usp.append(key, String(value));
    }
  }
  return usp.toString();
}

// GET/HEAD must never carry a request body: no Google Discovery GET/HEAD method
// declares a request schema, and undici/fetch throw ("Request with GET/HEAD method
// cannot have body") if one is attached. gaxios stringifies any object `data`
// without checking the verb, so a caller-supplied `{}` on a read would otherwise
// crash the request. Write verbs keep prior semantics: null/undefined -> no body.
export function resolveRequestBody(httpMethod: string, body: unknown): unknown {
  const verb = httpMethod.toUpperCase();
  if (verb === 'GET' || verb === 'HEAD') return undefined;
  return body ?? undefined;
}

export async function executeApiMethod(method: ApiMethodRef, args: ExecuteArgs, deps: ExecuteDeps = {}) {
  if (args.queryParams?.alt === 'media') {
    return jsonResult(
      {
        error: 'binary_unsupported',
        message: 'Binary media download (alt=media) returns no usable JSON through this tool.',
        hint: 'Use drive_download / drive_export for file content.',
        retriable: false,
        account: args.account,
      },
      true,
    );
  }

  // drive.files.export streams binary and, without alt=media, Google returns a confusing
  // "Export requires alt=media" — either way the escape hatch can't surface the content.
  if (method.id === 'drive.files.export') {
    return jsonResult(
      {
        error: 'binary_unsupported',
        message: 'drive.files.export returns binary content, not JSON, through this tool.',
        hint: 'Use drive_export to export a Google Workspace file to disk.',
        retriable: false,
        account: args.account,
      },
      true,
    );
  }

  let url: string;
  try {
    url = method.baseUrl + expandPath(method.path, (args.pathParams as Record<string, string> | undefined) ?? {});
  } catch (err) {
    return jsonResult(
      {
        error: 'invalid_params',
        message: (err as Error).message,
        hint: `Required params for ${method.id}: ${method.requiredParams.join(', ') || '(none)'}`,
        retriable: false,
        account: args.account,
      },
      true,
    );
  }

  if (!isGoogleApiUrl(url)) {
    return jsonResult(
      {
        error: 'untrusted_host',
        message: `Refusing to send credentials to a non-googleapis.com host for "${method.id}".`,
        hint: 'The discovery cache may be corrupt; delete DISCOVERY_CACHE_PATH and retry.',
        retriable: false,
        account: args.account,
      },
      true,
    );
  }

  try {
    const getClientFn = deps.getClientFn ?? getClient;
    const auth = await getClientFn(args.account as Account);
    const res = await auth.request<unknown>({
      // query string built by hand: gaxios comma-joins arrays, Google needs repeated keys
      url: `${url}?${buildQueryString(args.queryParams)}`,
      method: method.httpMethod as 'GET',
      data: resolveRequestBody(method.httpMethod, args.body),
    });
    const text = JSON.stringify(res.data ?? null);
    if (text.length > MAX_RESPONSE_CHARS) {
      return jsonResult({
        truncated: true,
        totalChars: text.length,
        head: text.slice(0, MAX_RESPONSE_CHARS),
        hint: 'Narrow the request (fields mask, pageSize) to get complete JSON.',
      });
    }
    return { content: [{ type: 'text' as const, text }] };
  } catch (error) {
    return handleGoogleApiError(error, args.account as Account);
  }
}
