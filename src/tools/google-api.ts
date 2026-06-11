import { z } from 'zod';
import type { ToolRegistry } from '../registry.js';
import { isAllowed, writeDisabledResult, type Policy } from '../write-control.js';
import { ACCOUNTS } from '../accounts.js';
import type { Account } from '../accounts.js';
import { getClient } from '../client.js';
import { handleGoogleApiError } from './_errors.js';
import { coerceJson } from './_coerce.js';
import { getToolsets, toolsetEnabled, type Toolsets } from '../toolsets.js';
import {
  WORKSPACE_APIS,
  type DiscoveryDeps,
  type DiscoveryMethod,
  cudFromMethod,
  expandPath,
  isGoogleApiUrl,
  loadMethodIndex,
  searchMethods,
} from '../discovery-client.js';

const accountEnum = z.enum(ACCOUNTS);
const MAX_RESPONSE_CHARS = 100_000;

// Policy/toolset namespace for each API alias must match the NAMED tools' service
// names, or user deny globs and GOOGLE_TOOLSETS silently miss escape-hatch calls.
const SERVICE_FOR_ALIAS: Record<string, string | null> = {
  gmail: 'gmail',
  drive: 'drive',
  calendar: 'calendar',
  sheets: 'sheets',
  docs: 'docs',
  slides: null,
  forms: 'forms',
  people: 'contacts',
  searchconsole: 'searchconsole',
  tasks: 'tasks',
  chat: 'chat',
  meet: 'meet',
  driveactivity: null,
  drivelabels: null,
  admin_directory: 'admin',
  admin_reports: 'admin',
  groupssettings: null,
};

export interface EscapeDeps extends DiscoveryDeps {
  getClientFn?: typeof getClient;
  toolsets?: Toolsets;
}

type QueryValue = string | number | boolean;

function buildQueryString(queryParams: Record<string, QueryValue | QueryValue[]> | undefined): string {
  const usp = new URLSearchParams();
  const merged: Record<string, QueryValue | QueryValue[]> = { alt: 'json', ...queryParams };
  for (const [key, value] of Object.entries(merged)) {
    if (Array.isArray(value)) {
      for (const v of value) usp.append(key, String(v));
    } else {
      usp.append(key, String(value));
    }
  }
  return usp.toString();
}

function jsonResult(payload: unknown, isError = false) {
  const base = { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
  return isError ? { ...base, isError: true as const } : base;
}

function describeMethod(m: DiscoveryMethod) {
  return {
    api: m.api,
    methodId: m.id,
    httpMethod: m.httpMethod,
    path: m.path,
    description: m.description,
    requiredParams: m.requiredParams,
    cud: cudFromMethod(m),
  };
}

export function registerEscapeTools(registry: ToolRegistry, policy: Policy, deps: EscapeDeps = {}): void {
  const getClientFn = deps.getClientFn ?? getClient;
  const toolsets = deps.toolsets ?? getToolsets();
  const apiEnabled = (alias: string): boolean => {
    const service = SERVICE_FOR_ALIAS[alias];
    return service === null || service === undefined || toolsetEnabled(toolsets, service);
  };
  const enabledApis = Object.keys(WORKSPACE_APIS).filter(apiEnabled);
  const apiList = enabledApis.join(', ');
  const toolsetDisabled = (alias: string) =>
    jsonResult(
      {
        error: 'toolset_disabled',
        message: `API "${alias}" maps to service "${SERVICE_FOR_ALIAS[alias]}", which is excluded by GOOGLE_TOOLSETS.`,
        hint: 'Add the service to GOOGLE_TOOLSETS (or unset it) to use this API.',
        retriable: false,
      },
      true,
    );

  registry.registerMeta(
    'google_api_search',
    {
      description:
        'Search the Google API Discovery index for any Workspace REST method, including ones with no ' +
        'dedicated tool here. Returns method ids + parameters to invoke via google_api_call. ' +
        `APIs: ${apiList}.`,
      inputSchema: {
        query: z.string().describe('Keywords, e.g. "slides create presentation" or "drive revisions"'),
        api: z.string().optional().describe('Restrict the search to one API alias'),
        maxResults: z.number().min(1).max(25).default(10).optional(),
      },
      annotations: { openWorldHint: true },
    },
    async ({ query, api, maxResults }) => {
      if (api && !WORKSPACE_APIS[api]) {
        return jsonResult({ error: 'unknown_api', message: `Unknown api "${api}".`, hint: `Known APIs: ${apiList}`, retriable: false }, true);
      }
      if (api && !apiEnabled(api)) return toolsetDisabled(api);
      const apis = api ? [api] : enabledApis;
      const unavailable: string[] = [];
      const indexes = await Promise.all(
        apis.map(async (a) => {
          try {
            return await loadMethodIndex(a, deps);
          } catch {
            unavailable.push(a);
            return [];
          }
        }),
      );
      const matches = searchMethods(indexes.flat(), query as string, (maxResults as number | undefined) ?? 10);
      return jsonResult({
        methods: matches.map(describeMethod),
        ...(unavailable.length > 0 ? { unavailableApis: unavailable } : {}),
        next: 'Invoke with google_api_call({account, api, methodId, pathParams, queryParams, body}).',
      });
    },
  );

  registry.registerMeta(
    'google_api_call',
    {
      description:
        'Invoke any Google Workspace REST method by Discovery id (escape hatch for operations without a ' +
        'dedicated tool). Find methods with google_api_search first. Subject to the same write-control ' +
        'policy as named tools.',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        api: z.string().describe(`API alias: ${apiList}`),
        methodId: z.string().describe('Discovery method id, e.g. "drive.revisions.list"'),
        pathParams: coerceJson(z.record(z.string(), z.union([z.string(), z.number()])).optional())
          .describe('Values for {placeholders} in the method path'),
        queryParams: coerceJson(
          z
            .record(
              z.string(),
              z.union([
                z.string(),
                z.number(),
                z.boolean(),
                z.array(z.union([z.string(), z.number(), z.boolean()])),
              ]),
            )
            .optional(),
        ).describe('Query-string parameters; use an array for repeated params (e.g. resourceNames)'),
        body: coerceJson(z.record(z.string(), z.unknown()).optional()).describe('JSON request body'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ account, api, methodId, pathParams, queryParams, body }) => {
      if (!WORKSPACE_APIS[api as string]) {
        return jsonResult({ error: 'unknown_api', message: `Unknown api "${api}".`, hint: `Known APIs: ${apiList}`, retriable: false }, true);
      }
      if (!apiEnabled(api as string)) return toolsetDisabled(api as string);
      if ((queryParams as Record<string, unknown> | undefined)?.alt === 'media') {
        return jsonResult(
          {
            error: 'binary_unsupported',
            message: 'Binary media download (alt=media) returns no usable JSON through the escape hatch.',
            hint: 'Use drive_download / drive_export for file content.',
            retriable: false,
          },
          true,
        );
      }
      let index: DiscoveryMethod[];
      try {
        index = await loadMethodIndex(api as string, deps);
      } catch (err) {
        return jsonResult({ error: 'discovery_unavailable', message: (err as Error).message, retriable: true }, true);
      }
      const method = index.find((m) => m.id === methodId);
      if (!method) {
        return jsonResult(
          {
            error: 'unknown_method',
            message: `No method "${methodId}" in ${api}.`,
            hint: `Use google_api_search({query: "...", api: "${api}"}) to find the right method id.`,
            retriable: false,
          },
          true,
        );
      }

      const cud = cudFromMethod(method);
      const policyService = SERVICE_FOR_ALIAS[api as string] ?? (api as string);
      const lastSegment = method.id.split('.').pop() ?? method.id;
      const toolRef = { name: `${policyService}_${lastSegment}`, service: policyService, cud };
      if (cud !== 'read' && !isAllowed(toolRef, policy)) {
        return writeDisabledResult(toolRef, policy);
      }

      let url: string;
      try {
        url = method.baseUrl + expandPath(method.path, (pathParams as Record<string, string> | undefined) ?? {});
      } catch (err) {
        return jsonResult(
          {
            error: 'invalid_params',
            message: (err as Error).message,
            hint: `Required params for ${method.id}: ${method.requiredParams.join(', ') || '(none)'}`,
            retriable: false,
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
          },
          true,
        );
      }

      try {
        const auth = await getClientFn(account as Account);
        const res = await auth.request<unknown>({
          // query string built by hand: gaxios comma-joins arrays, Google needs repeated keys
          url: `${url}?${buildQueryString(queryParams as Record<string, QueryValue | QueryValue[]> | undefined)}`,
          method: method.httpMethod as 'GET',
          data: body ?? undefined,
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
        return handleGoogleApiError(error, account as Account);
      }
    },
  );
}
