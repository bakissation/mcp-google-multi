import { z } from 'zod';
import type { ToolRegistry } from '../registry.js';
import { isAllowedByAnyName, writeDisabledResult, type Policy } from '../write-control.js';
import { accountArgLive } from '../accounts.js';
import { getClient } from '../client.js';
import { coerceJson } from './_coerce.js';
import { getToolsets, toolsetEnabled, type Toolsets } from '../toolsets.js';
import { editDistance, SUGGEST_MAX_INPUT } from '../scope-catalog.js';
import { executeApiMethod, jsonResult, type ExecuteDeps, type QueryParams } from '../executor.js';
import {
  SUPPORTED_APIS,
  resolveApiAliases,
  type DiscoveryDeps,
  type DiscoveryMethod,
  cudFromMethod,
  loadMethodIndex,
  searchMethods,
  MAX_SEARCH_QUERY,
} from '../discovery-client.js';
import { hints } from '../hint-provider.js';
import { CURATED_METHOD_TOOLS, GENERATED_METHOD_TOOLS } from './generated/method-map.js';


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

/** Discovery ids are short dotted identifiers; the bound keeps a caller from
 * sending megabytes through lookup, suggestion and the echoed message. */
const MAX_METHOD_ID = 256;
const MAX_API_ALIAS = 64;

/** Up to three closest known ids for the unknown_method did-you-mean hint;
 * bounded distance so unrelated ids never masquerade as suggestions. */
export function nearestMethodIds(methodId: string, index: DiscoveryMethod[]): string[] {
  if (methodId.length > SUGGEST_MAX_INPUT) return [];
  const maxDist = Math.max(3, Math.floor(methodId.length / 3));
  const wanted = methodId.toLowerCase();
  return index
    // the distance is at least the length gap, so most ids skip the DP
    .filter((m) => Math.abs(m.id.length - wanted.length) <= maxDist)
    .map((m) => ({ id: m.id, d: editDistance(wanted, m.id.toLowerCase()) }))
    .filter((x) => x.d <= maxDist)
    .sort((a, b) => a.d - b.d)
    .slice(0, 3)
    .map((x) => x.id);
}

// Mirrors scripts/gen-tools.ts's snakeCase: src/ and scripts/ are separate
// compilation roots (see tsconfig.scripts.json), so the convention is
// duplicated rather than imported. A drift between the two would only widen
// the escape hatch's own full-path name, never narrow it: escapeHatchNames
// below also carries the last-segment and real-tool names, so write-control
// degrades gracefully, and the parity test below would catch a drift anyway.
function snakeSegment(segment: string): string {
  return segment.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

// A handful of Discovery methods that DO have their own generated twin
// (so they are not in CURATED_METHOD_TOOLS, which only covers methods a
// curated tool implements in place of generating one) are ALSO called, as
// a secondary step, by an unrelated curated tool: e.g. sheets_copy_sheet_to
// also calls sheets.spreadsheets.sheets.copyTo, the same method its own
// generated twin sheets_spreadsheets_sheets_copy_to wraps. Listed here so a
// deny/allow written against that curated tool's name reaches the escape
// hatch for this method too, not just its generated twin's name.
const EXTRA_METHOD_TOOLS: Record<string, string[]> = {
  'sheets.spreadsheets.sheets.copyTo': ['sheets_copy_sheet_to'],
};

// Every curated tool name (including EXTRA_METHOD_TOOLS), and every
// generated tool name, across the WHOLE surface, not just this method:
// used to detect when the generic lastSegmentName fallback below happens
// to spell some OTHER method's real tool name exactly (e.g. "drive_update"
// is the actual curated tool for drive.files.update, but is ALSO the
// generic lastSegmentName for drive.permissions.update and
// drive.revisions.update, which share none of its semantics). Computed
// once and cached: both maps are static for the life of the process.
let allCuratedNamesCache: Set<string> | undefined;
function allCuratedNames(): Set<string> {
  if (!allCuratedNamesCache) {
    allCuratedNamesCache = new Set([...Object.values(CURATED_METHOD_TOOLS).flat(), ...Object.values(EXTRA_METHOD_TOOLS).flat()]);
  }
  return allCuratedNamesCache;
}
let allGeneratedNamesCache: Set<string> | undefined;
function allGeneratedNames(): Set<string> {
  if (!allGeneratedNamesCache) allGeneratedNamesCache = new Set(Object.values(GENERATED_METHOD_TOOLS));
  return allGeneratedNamesCache;
}

export interface EscapeHatchNames {
  /** Every name a deny glob is checked against: every curated tool name
   * sharing this method, its generated twin, the full method-path name,
   * the legacy last-segment name. Denying any one of them can only narrow
   * what gets through, never widen it, so listing every curated tool here
   * (even when several share one raw method) is always safe. */
  deny: string[];
  /** Names an ALLOW glob may grant through: the generated twin, the
   * full-path name and the legacy last-segment name always; a curated
   * tool's own name only when it is the ONE AND ONLY curated tool mapped
   * to this method. An allow naming one narrow operation on a shared
   * method (e.g. "drive:trash") must not also open every OTHER operation
   * reachable through the same raw drive.files.update (a plain rename, a
   * move, drive_transfer's internals): those have no real tool name in
   * common to allow narrowly, so only the method-wide names can grant them. */
  allow: string[];
  /** The real tool name when exactly one exists (curated or generated),
   * else the full-path name: what the profile decides on when neither an
   * explicit deny nor an explicit allow matched (see isAllowedByAnyName
   * for why this must be a single real name, not "any name"). */
  primary: string;
}

/**
 * Every name write-control might reasonably know this operation by. See
 * EscapeHatchNames for which names are deny-only vs allow-eligible.
 */
export function escapeHatchNames(policyService: string, methodId: string): EscapeHatchNames {
  const curatedNames = CURATED_METHOD_TOOLS[methodId] ?? EXTRA_METHOD_TOOLS[methodId] ?? [];
  const generatedName = GENERATED_METHOD_TOOLS[methodId];
  const tail = methodId.split('.').slice(1);
  const fullPathName = tail.length > 0 ? `${policyService}_${tail.map(snakeSegment).join('_')}` : undefined;
  const lastSegment = methodId.split('.').pop() ?? methodId;
  const lastSegmentName = `${policyService}_${snakeSegment(lastSegment)}`;

  const dedupe = (list: string[]): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const n of list) {
      if (!seen.has(n)) {
        seen.add(n);
        out.push(n);
      }
    }
    return out;
  };

  // lastSegmentName is a GENERIC pattern (service + the method's last dot
  // segment), not derived from any real registration, so it can collide
  // with an unrelated method's actual tool name by coincidence. Deny
  // always includes it regardless (a deny can only narrow what gets
  // through); allow drops it whenever it spells some OTHER curated or
  // generated tool's real name, since letting it through there would
  // widen a narrow allow on that OTHER tool into this, unrelated, method.
  const lastSegmentIsForeignToolName =
    (allCuratedNames().has(lastSegmentName) && !curatedNames.includes(lastSegmentName)) ||
    (allGeneratedNames().has(lastSegmentName) && lastSegmentName !== generatedName);

  const deny = dedupe([
    ...curatedNames,
    ...(generatedName ? [generatedName] : []),
    ...(fullPathName ? [fullPathName] : []),
    lastSegmentName,
  ]);
  const allow = dedupe([
    ...(curatedNames.length === 1 ? curatedNames : []),
    ...(generatedName ? [generatedName] : []),
    ...(fullPathName ? [fullPathName] : []),
    ...(lastSegmentIsForeignToolName ? [] : [lastSegmentName]),
  ]);
  const primary = curatedNames.length === 1 ? curatedNames[0] : generatedName ?? fullPathName ?? lastSegmentName;
  return { deny, allow, primary };
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
  // Live per-registry account validation, same as the curated files.
  const accountEnum = accountArgLive(() => registry.accountAliases()).optional();
  const getClientFn = deps.getClientFn ?? getClient;
  const toolsets = deps.toolsets ?? getToolsets();
  const serviceForAlias = (alias: string): string => SERVICE_FOR_ALIAS[alias] ?? alias;
  const apiEnabled = (alias: string): boolean => {
    return toolsetEnabled(toolsets, serviceForAlias(alias));
  };
  const enabledApis = Object.keys(SUPPORTED_APIS).filter(apiEnabled);
  const apiList = enabledApis.join(', ');
  const toolsetDisabled = (alias: string) => {
    const rendered = hints()?.render({ kind: 'toolset_disabled', api: alias, service: serviceForAlias(alias) });
    return jsonResult(
      {
        error: 'toolset_disabled',
        message: rendered?.message ?? `API "${alias}" maps to service "${serviceForAlias(alias)}", which is excluded by GOOGLE_TOOLSETS.`,
        hint: rendered?.hint ?? 'Add the service to GOOGLE_TOOLSETS (or unset it) to use this API.',
        retriable: false,
      },
      true,
    );
  };

  registry.registerMeta(
    'google_api_search',
    {
      description:
        'Search the Google API Discovery index for any Workspace REST method, including ones with no ' +
        'dedicated tool here. Returns method ids + parameters to invoke via google_api_call. ' +
        `APIs: ${apiList}.`,
      inputSchema: {
        query: z.string().max(MAX_SEARCH_QUERY).describe('Keywords, e.g. "slides create presentation" or "drive revisions"'),
        api: z.string().max(MAX_API_ALIAS).optional().describe('Restrict the search to one API alias'),
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
        api: z.string().max(MAX_API_ALIAS).describe(`API alias: ${apiList}`),
        methodId: z.string().min(1).max(MAX_METHOD_ID).describe('Discovery method id, e.g. "drive.revisions.list"'),
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
        // Some discovery docs keep a legacy id prefix (searchconsole's methods are
        // webmasters.*): retry under the doc's own prefix if the caller used our api alias.
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
      // The escape hatch self-gates, so it needs the same scope signal as the registry
      // wrapper, or a privileged method would slip past safe-writes here while its generated twin is refused.
      // Checked under every name the operation can have (real tool(s), full
      // method path, legacy last-segment) because a method whose id ends in
      // a generic verb, such as drive.permissions.create or
      // gmail.users.settings.filters.create, would otherwise lose its
      // resource and collapse onto a generic drive_create / gmail_create
      // that neither the profile nor an operator's resource-scoped
      // GOOGLE_WRITE_DENY can tell apart from an ordinary write. Deny on
      // any name wins; allow only on a method-wide name (never a narrow
      // curated tool's name shared with other operations on the same raw
      // method; see EscapeHatchNames); the profile itself decides on the
      // primary (real) name alone when neither matched.
      if (cud !== 'read') {
        const names = escapeHatchNames(policyService, method.id);
        const verdict = isAllowedByAnyName(names.deny, names.allow, { service: policyService, cud, scopes: method.scopes }, names.primary, policy);
        if (!verdict.allowed) {
          return writeDisabledResult(verdict.ref, policy, account as string);
        }
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
