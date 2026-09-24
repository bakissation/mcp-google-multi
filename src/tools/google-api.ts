import { z } from 'zod';
import type { ToolRegistry } from '../registry.js';
import { isAllowed, writeDisabledResult, type Policy } from '../write-control.js';
import { accountArgLive } from '../accounts.js';
import { getClient } from '../client.js';
import { coerceJson } from './_coerce.js';
import { getToolsets, toolsetEnabled, type Toolsets } from '../toolsets.js';
import { editDistance } from '../scope-catalog.js';
import { executeApiMethod, jsonResult, type ExecuteDeps, type QueryParams } from '../executor.js';
import {
  SUPPORTED_APIS,
  resolveApiAliases,
  type DiscoveryDeps,
  type DiscoveryMethod,
  cudFromMethod,
  loadMethodIndex,
  searchMethods,
} from '../discovery-client.js';


// Policy/toolset namespace for each API alias must match the NAMED tools' service
// names, or user deny globs and GOOGLE_TOOLSETS silently miss escape-hatch calls.
const SERVICE_FOR_ALIAS: Record<string, string> = {
  gmail: 'gmail',
  drive: 'drive',
  calendar: 'calendar',
  sheets: 'sheets',
  docs: 'docs',
  slides: 'slides',
  forms: 'forms',
  people: 'contacts',
  searchconsole: 'searchconsole',
  tasks: 'tasks',
  chat: 'chat',
  meet: 'meet',
  driveactivity: 'driveactivity',
  drivelabels: 'drivelabels',
  admin_directory: 'admin',
  admin_reports: 'admin',
  admin_datatransfer: 'admin',
  groupssettings: 'groupssettings',
  analyticsadmin: 'analytics',
  analyticsdata: 'analytics',
};

export interface EscapeDeps extends DiscoveryDeps, ExecuteDeps {
  toolsets?: Toolsets;
}

/** Up to three closest known ids for the unknown_method did-you-mean hint;
 * bounded distance so unrelated ids never masquerade as suggestions. */
export function nearestMethodIds(methodId: string, index: DiscoveryMethod[]): string[] {
  const maxDist = Math.max(3, Math.floor(methodId.length / 3));
  return index
    .map((m) => ({ id: m.id, d: editDistance(methodId.toLowerCase(), m.id.toLowerCase()) }))
    .filter((x) => x.d <= maxDist)
    .sort((a, b) => a.d - b.d)
    .slice(0, 3)
    .map((x) => x.id);
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
  // Live per-registry account validation (S1.10), same as the curated files.
  const accountEnum = accountArgLive(() => registry.accountAliases()).optional();
  const getClientFn = deps.getClientFn ?? getClient;
  const toolsets = deps.toolsets ?? getToolsets();
  const serviceForAlias = (alias: string): string => SERVICE_FOR_ALIAS[alias] ?? alias;
  const apiEnabled = (alias: string): boolean => {
    return toolsetEnabled(toolsets, serviceForAlias(alias));
  };
  const enabledApis = Object.keys(SUPPORTED_APIS).filter(apiEnabled);
  const apiList = enabledApis.join(', ');
  const toolsetDisabled = (alias: string) =>
    jsonResult(
      {
        error: 'toolset_disabled',
        message: `API "${alias}" maps to service "${serviceForAlias(alias)}", which is excluded by GOOGLE_TOOLSETS.`,
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
      // Alias resolution: "analytics" fans out to both GA4 Discovery APIs
      // instead of dead-ending on unknown_api.
      let requested: string[] | null = null;
      if (api) {
        requested = resolveApiAliases(api);
        if (!requested) {
          registry.usageMetrics?.recordSearchApi(null);
          return jsonResult({ error: 'unknown_api', message: `Unknown api "${api}".`, hint: `Known APIs: ${apiList}`, retriable: false }, true);
        }
        const enabled = requested.filter(apiEnabled);
        if (enabled.length === 0) return toolsetDisabled(requested[0]);
        requested = enabled;
        // Post-resolution SUPPORTED_APIS keys only (closed vocabulary).
        registry.usageMetrics?.recordSearchApi(requested);
      }
      const apis = requested ?? enabledApis;
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
        // Teach the resolved keys whenever the input wasn't already one, so the
        // follow-up google_api_call uses a real key.
        ...(requested && (requested.length > 1 || requested[0] !== api) ? { resolvedApi: requested } : {}),
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
        'policy as named tools. On reads, pass a `fields` query param (Google partial response) to keep ' +
        'the payload small. Returns JSON only — for binary/file content (media downloads, ' +
        'drive.files.export) use drive_download / drive_export instead.',
      inputSchema: {
        account: accountEnum.describe('Google account alias (omit for the default account)'),
        api: z.string().describe(`API alias: ${apiList}`),
        methodId: z.string().min(1).describe('Discovery method id, e.g. "drive.revisions.list"'),
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
      // idempotentHint:false is load-bearing: the computed default (cud=read)
      // would invite retries that duplicate sends through the escape hatch.
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      _meta: { 'anthropic/maxResultSizeChars': 100_000 },
    },
    async ({ account, api, methodId, pathParams, queryParams, body }) => {
      const resolved = resolveApiAliases(api as string);
      if (!resolved) {
        return jsonResult({ error: 'unknown_api', message: `Unknown api "${api}".`, hint: `Known APIs: ${apiList}`, retriable: false, account }, true);
      }
      if (resolved.length > 1) {
        // A call targets exactly one Discovery doc; only search can fan out.
        return jsonResult({ error: 'unknown_api', message: `"${api}" maps to ${resolved.length} APIs.`, hint: `Pass one of: ${resolved.join(', ')} (method ids differ per API; google_api_search({query, api: "${api}"}) finds the right one).`, retriable: false, account }, true);
      }
      const apiKey = resolved[0];
      if (!apiEnabled(apiKey)) return toolsetDisabled(apiKey);
      let index: DiscoveryMethod[];
      try {
        index = await loadMethodIndex(apiKey, deps);
      } catch (err) {
        return jsonResult({ error: 'discovery_unavailable', message: (err as Error).message, retriable: true, account }, true);
      }
      let method = index.find((m) => m.id === methodId);
      if (!method) {
        // Some discovery docs keep a legacy id prefix (the searchconsole doc's
        // methods are webmasters.*): when the caller prefixed with our api
        // alias, retry under the doc's own prefix before failing.
        const docPrefix = index[0]?.id.split('.')[0];
        const [head, ...rest] = String(methodId).split('.');
        if (docPrefix && (head === apiKey || head === api) && head !== docPrefix && rest.length > 0) {
          const swapped = [docPrefix, ...rest].join('.');
          method = index.find((m) => m.id === swapped);
        }
      }
      if (!method) {
        registry.usageMetrics?.recordEscapeMethod(null);
        const near = nearestMethodIds(String(methodId), index);
        return jsonResult(
          {
            error: 'unknown_method',
            message: `No method "${methodId}" in ${apiKey}.`,
            hint:
              `${near.length ? `Did you mean: ${near.join(', ')}? ` : ''}` +
              `Use google_api_search({query: "...", api: "${apiKey}"}) to find the right method id.`,
            retriable: false,
            account,
          },
          true,
        );
      }

      // The RESOLVED index id only, never the caller's methodId argument.
      registry.usageMetrics?.recordEscapeMethod(method.id);
      const cud = cudFromMethod(method);
      const policyService = serviceForAlias(apiKey);
      const lastSegment = method.id.split('.').pop() ?? method.id;
      // The escape hatch self-gates, so it needs the same scope signal the
      // registry wrapper gets; without it a privileged method would slip past
      // safe-writes here while its generated twin is refused.
      const toolRef = { name: `${policyService}_${lastSegment}`, service: policyService, cud, scopes: method.scopes };
      if (cud !== 'read' && !isAllowed(toolRef, policy)) {
        return writeDisabledResult(toolRef, policy, account as string);
      }

      return executeApiMethod(
        method,
        {
          account: account as string,
          pathParams: pathParams as Record<string, string | number> | undefined,
          queryParams: queryParams as QueryParams | undefined,
          body,
        },
        { getClientFn, scopeDeps: deps.scopeDeps },
      );
    },
  );
}
