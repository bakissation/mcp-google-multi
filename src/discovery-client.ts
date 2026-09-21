import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export const SUPPORTED_APIS: Record<string, { id: string; version: string }> = {
  gmail: { id: 'gmail', version: 'v1' },
  drive: { id: 'drive', version: 'v3' },
  calendar: { id: 'calendar', version: 'v3' },
  sheets: { id: 'sheets', version: 'v4' },
  docs: { id: 'docs', version: 'v1' },
  slides: { id: 'slides', version: 'v1' },
  forms: { id: 'forms', version: 'v1' },
  people: { id: 'people', version: 'v1' },
  searchconsole: { id: 'searchconsole', version: 'v1' },
  tasks: { id: 'tasks', version: 'v1' },
  chat: { id: 'chat', version: 'v1' },
  meet: { id: 'meet', version: 'v2' },
  driveactivity: { id: 'driveactivity', version: 'v2' },
  drivelabels: { id: 'drivelabels', version: 'v2' },
  admin_directory: { id: 'admin', version: 'directory_v1' },
  admin_reports: { id: 'admin', version: 'reports_v1' },
  admin_datatransfer: { id: 'admin', version: 'datatransfer_v1' },
  groupssettings: { id: 'groupssettings', version: 'v1' },
  analyticsadmin: { id: 'analyticsadmin', version: 'v1beta' },
  analyticsdata: { id: 'analyticsdata', version: 'v1beta' },
  appsmarket: { id: 'appsmarket', version: 'v2' },
  classroom: { id: 'classroom', version: 'v1' },
  cloudidentity: { id: 'cloudidentity', version: 'v1' },
  cloudsearch: { id: 'cloudsearch', version: 'v1' },
  groupsmigration: { id: 'groupsmigration', version: 'v1' },
  keep: { id: 'keep', version: 'v1' },
  licensing: { id: 'licensing', version: 'v1' },
  postmaster: { id: 'gmailpostmastertools', version: 'v1' },
  reseller: { id: 'reseller', version: 'v1' },
  script: { id: 'script', version: 'v1' },
  vault: { id: 'vault', version: 'v1' },
  workspaceevents: { id: 'workspaceevents', version: 'v1' },
};

// Names agents actually type for an API, mapped to real SUPPORTED_APIS keys.
// Motivated by observed escape-hatch misses ("analytics" is two Discovery
// APIs, the Admin SDK is three); keep entries plural-target only when the
// split is real.
export const API_ALIASES: Record<string, string[]> = {
  analytics: ['analyticsadmin', 'analyticsdata'],
  ga4: ['analyticsadmin', 'analyticsdata'],
  googleanalytics: ['analyticsadmin', 'analyticsdata'],
  admin: ['admin_directory', 'admin_reports', 'admin_datatransfer'],
  adminsdk: ['admin_directory', 'admin_reports', 'admin_datatransfer'],
  directory: ['admin_directory'],
  webmasters: ['searchconsole'],
  gsc: ['searchconsole'],
  contacts: ['people'],
  appsscript: ['script'],
  appscript: ['script'],
  gmailpostmastertools: ['postmaster'],
};

/**
 * Resolve an `api` argument to real SUPPORTED_APIS keys: exact match, then
 * case/punctuation-normalized ("Search-Console" -> searchconsole), then the
 * alias map. null = genuinely unknown.
 */
export function resolveApiAliases(api: string): string[] | null {
  if (SUPPORTED_APIS[api]) return [api];
  const norm = api.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  const direct = Object.keys(SUPPORTED_APIS).find((k) => k.replace(/[^a-z0-9]/g, '') === norm);
  if (direct) return [direct];
  return API_ALIASES[norm] ?? null;
}

export interface DiscoveryParam {
  location: 'path' | 'query';
  required?: boolean;
  type?: string;
  description?: string;
}

export interface DiscoveryMethod {
  id: string;
  api: string;
  httpMethod: string;
  path: string;
  baseUrl: string;
  description: string;
  params: Record<string, DiscoveryParam>;
  requiredParams: string[];
  scopes: string[];
}

interface DiscoveryDoc {
  baseUrl?: string;
  rootUrl?: string;
  servicePath?: string;
  resources?: Record<string, unknown>;
  methods?: Record<string, unknown>;
}

export interface DiscoveryDeps {
  fetchFn?: (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
  cacheDir?: string;
  now?: () => number;
}

const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const STALE_RETRY_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

export function discoveryCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.DISCOVERY_CACHE_PATH ??
    path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'mcp-google-multi', 'discovery')
  );
}

// A poisoned cache file could repoint baseUrl off-Google; refuse to send the
// user's Bearer token anywhere but a googleapis.com host.
export function isGoogleApiUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (u.hostname === 'googleapis.com' || u.hostname.endsWith('.googleapis.com'));
  } catch {
    return false;
  }
}

const memoryCache = new Map<string, { index: DiscoveryMethod[]; refreshAfter: number }>();

export function buildMethodIndex(doc: DiscoveryDoc, api: string): DiscoveryMethod[] {
  const baseUrl = doc.baseUrl ?? `${doc.rootUrl ?? ''}${doc.servicePath ?? ''}`;
  const out: DiscoveryMethod[] = [];
  const walk = (node: { resources?: Record<string, unknown>; methods?: Record<string, unknown> }) => {
    for (const m of Object.values(node.methods ?? {})) {
      const method = m as {
        id?: string;
        httpMethod?: string;
        path?: string;
        flatPath?: string;
        description?: string;
        parameters?: Record<string, DiscoveryParam>;
        parameterOrder?: string[];
        scopes?: string[];
      };
      if (!method.id || !method.httpMethod || !method.path) continue;
      const params = method.parameters ?? {};
      // Google serves parameters{} with unstable key order between fetches;
      // parameterOrder is the canonical sequence, so sort by it (alphabetical
      // tie-break) to keep gen-tools output deterministic.
      const order = method.parameterOrder ?? [];
      const pos = (n: string) => {
        const i = order.indexOf(n);
        return i === -1 ? order.length : i;
      };
      out.push({
        id: method.id,
        api,
        httpMethod: method.httpMethod.toUpperCase(),
        path: method.path,
        baseUrl,
        description: (method.description ?? '').split('\n')[0].slice(0, 160),
        params,
        requiredParams: Object.entries(params)
          .filter(([, p]) => p.required)
          .map(([name]) => name)
          .sort((a, b) => pos(a) - pos(b) || a.localeCompare(b)),
        scopes: method.scopes ?? [],
      });
    }
    for (const r of Object.values(node.resources ?? {})) {
      walk(r as { resources?: Record<string, unknown>; methods?: Record<string, unknown> });
    }
  };
  walk(doc);
  return out;
}

export async function loadMethodIndex(api: string, deps: DiscoveryDeps = {}): Promise<DiscoveryMethod[]> {
  const now = deps.now ?? Date.now;
  const cached = memoryCache.get(api);
  if (cached && now() < cached.refreshAfter) return cached.index;

  const spec = SUPPORTED_APIS[api];
  if (!spec) {
    throw new Error(`Unknown api "${api}". Known: ${Object.keys(SUPPORTED_APIS).join(', ')}`);
  }
  const fetchFn = deps.fetchFn ?? ((url: string) => fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }));
  const cacheDir = deps.cacheDir ?? discoveryCacheDir();
  const cacheFile = path.join(cacheDir, `${api}.json`);

  const readCache = (): DiscoveryDoc | undefined => {
    try {
      return JSON.parse(fs.readFileSync(cacheFile, 'utf-8')) as DiscoveryDoc;
    } catch {
      return undefined;
    }
  };
  const cacheFresh = (): boolean => {
    try {
      return now() - fs.statSync(cacheFile).mtimeMs < TTL_MS;
    } catch {
      return false;
    }
  };

  let doc: DiscoveryDoc | undefined;
  let staleFallback = false;
  if (cacheFresh()) doc = readCache();
  if (!doc) {
    // Newer APIs (analyticsadmin/analyticsdata) are absent from the central
    // discovery directory (404); each service's own $discovery endpoint is
    // authoritative, so try both — same fallback as scripts/fetch-discovery.
    const urls = [
      `https://www.googleapis.com/discovery/v1/apis/${spec.id}/${spec.version}/rest`,
      `https://${spec.id}.googleapis.com/$discovery/rest?version=${spec.version}`,
    ];
    let fetchError: Error | undefined;
    for (const url of urls) {
      try {
        const res = await fetchFn(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        doc = (await res.json()) as DiscoveryDoc;
        fs.mkdirSync(cacheDir, { recursive: true });
        fs.writeFileSync(cacheFile, JSON.stringify(doc), { mode: 0o600 });
        break;
      } catch (err) {
        fetchError = err as Error;
        doc = undefined;
      }
    }
    if (!doc) {
      doc = readCache();
      staleFallback = true;
      if (!doc) {
        throw new Error(
          `Could not fetch the Google API Discovery document for "${api}" and no local cache exists (${fetchError?.message ?? 'fetch failed'}). Retry when online.`,
          { cause: fetchError },
        );
      }
    }
  }
  const index = buildMethodIndex(doc, api);
  memoryCache.set(api, { index, refreshAfter: now() + (staleFallback ? STALE_RETRY_MS : TTL_MS) });
  return index;
}

export function clearDiscoveryMemoryCache(): void {
  memoryCache.clear();
}

// GA4-style report execution (runReport, batchRunPivotReports, runAccessReport)
// and check* predicates are POSTs purely for the request-body size — reads.
const POST_READ_VERB = /^(get|list|search|query|lookup|count|batchGet|generateIds|export|download|inspect|check|suggest|(batch)?run\w*report)/i;
// `cancelWipe` must be matched here, BEFORE `cancel` reaches the delete list:
// it calls off a pending wipe, which is the opposite of one. Update is tested
// before delete for exactly that reason.
// State transitions on something that already exists: reversible, and none of
// them creates anything, so `create` was both wrong and the most permissive
// class available. `(batch)?` mirrors the delete list, without which every
// `batchUpdate*` POST fell through to `create`.
const POST_UPDATE_VERB = /^(cancelWipe|(batch)?(untrash|undelete|restore|modify|move|set|sort|merge|unmerge|replace|resize|publish|resolve|update|patch|write|format|change|close|reopen|enable|disable|hide|unhide|accept|approve|decline|reassign|reactivate|renew|mark|turn|suspend|activate|make|return|reclaim|complete))/i;
// archive sits with the deletes: in GA4 archiving a custom dimension/metric is
// permanent, so the most restrictive write class is the safe classification.
// So do the teardown verbs: `stop` and `cancel` tear down a push channel or a
// long-running operation, `wipe`/`invalidate`/`signOut` destroy device data,
// codes and sessions, `reset` discards a configuration, and `end` terminates a
// live conference. Each removes something that existed.
const POST_DELETE_VERB = /^(batch)?(delete|remove|trash|clear|empty|obliterate|purge|revoke|wipeout|archive|wipe|invalidate|signOut|stop|cancel|unregister|unreserve|reset|end)/i;

export function cudFromMethod(method: Pick<DiscoveryMethod, 'httpMethod' | 'id'>): 'read' | 'create' | 'update' | 'delete' {
  switch (method.httpMethod) {
    case 'GET':
    case 'HEAD':
      return 'read';
    case 'DELETE':
      return 'delete';
    case 'PUT':
    case 'PATCH':
      return 'update';
    default: {
      // POST carries reads (batchGet), updates (modify) and permanent deletes
      // (batchDelete, clear, obliterate) — classify by verb or write-control misfires.
      const lastSegment = method.id.split('.').pop() ?? '';
      if (POST_READ_VERB.test(lastSegment)) return 'read';
      if (POST_UPDATE_VERB.test(lastSegment)) return 'update';
      if (POST_DELETE_VERB.test(lastSegment)) return 'delete';
      return 'create';
    }
  }
}

export function expandPath(template: string, pathParams: Record<string, string>): string {
  return template.replace(/\{(\+?)([^}]+)\}/g, (_match, plus: string, name: string) => {
    const value = pathParams[name];
    if (value === undefined) {
      throw new Error(`Missing required path parameter "${name}"`);
    }
    // A blank segment collapses the path and Google routes the resulting
    // trailing-slash URL to the COLLECTION: `sites.get` with siteUrl:"" came
    // back as the whole site LIST, reported as success. Dot segments resolve
    // at URL-parse time, so `../v1/contactGroups` retargets the call at a
    // different endpoint and returns ITS response as success. Both are
    // silent-wrong, so refuse locally rather than send a different request.
    // `{+param}` keeps its slashes, so every segment has to be checked.
    const segments = plus ? String(value).split('/') : [String(value)];
    for (const segment of segments) {
      if (segment.trim() === '') {
        throw new Error(
          `Path parameter "${name}" is empty. An empty value addresses the collection, not one resource, so nothing was sent to Google.`,
        );
      }
      if (segment === '.' || segment === '..') {
        throw new Error(
          `Path parameter "${name}" contains a "${segment}" path segment, which would retarget the request at a different endpoint. Nothing was sent to Google.`,
        );
      }
    }
    return segments.map(encodeURIComponent).join('/');
  });
}

export function searchMethods(index: DiscoveryMethod[], query: string, limit = 10): DiscoveryMethod[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return index.slice(0, limit);
  const scored = index
    .map((m) => {
      const id = m.id.toLowerCase();
      const desc = m.description.toLowerCase();
      let score = 0;
      for (const t of tokens) {
        if (id.includes(t)) score += 3;
        if (desc.includes(t)) score += 1;
      }
      return { m, score };
    })
    .filter((s) => s.score > 0);
  scored.sort((a, b) => b.score - a.score || a.m.id.localeCompare(b.m.id));
  return scored.slice(0, limit).map((s) => s.m);
}
