import { z } from 'zod';
import type { ToolRegistry } from '../registry.js';
import { isAllowed, writeDisabledResult, type Policy } from '../write-control.js';
import { ACCOUNTS } from '../accounts.js';
import { getClient } from '../client.js';
import { coerceJson } from './_coerce.js';
import { getToolsets, toolsetEnabled, type Toolsets } from '../toolsets.js';
import { executeApiMethod, jsonResult, type QueryParams } from '../executor.js';
import {
  WORKSPACE_APIS,
  type DiscoveryDeps,
  type DiscoveryMethod,
  cudFromMethod,
  loadMethodIndex,
  searchMethods,
} from '../discovery-client.js';

const accountEnum = z.enum(ACCOUNTS);

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
  groupssettings: 'groupssettings',
};

export interface EscapeDeps extends DiscoveryDeps {
  getClientFn?: typeof getClient;
  toolsets?: Toolsets;
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
  const serviceForAlias = (alias: string): string => SERVICE_FOR_ALIAS[alias] ?? alias;
  const apiEnabled = (alias: string): boolean => {
    return toolsetEnabled(toolsets, serviceForAlias(alias));
  };
  const enabledApis = Object.keys(WORKSPACE_APIS).filter(apiEnabled);
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
      const policyService = serviceForAlias(api as string);
      const lastSegment = method.id.split('.').pop() ?? method.id;
      const toolRef = { name: `${policyService}_${lastSegment}`, service: policyService, cud };
      if (cud !== 'read' && !isAllowed(toolRef, policy)) {
        return writeDisabledResult(toolRef, policy);
      }

      return executeApiMethod(
        method,
        {
          account: account as string,
          pathParams: pathParams as Record<string, string | number> | undefined,
          queryParams: queryParams as QueryParams | undefined,
          body,
        },
        { getClientFn },
      );
    },
  );
}
