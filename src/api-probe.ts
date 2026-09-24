import { getClient } from './client.js';
import { readToken } from './token-store.js';
import { mapGoogleError } from './tools/_errors.js';
import type { Account } from './accounts.js';
import type { ApiProbeResult } from './doctor.js';

// Section-6 live probe (B9): one cheap authenticated read per service to catch
// accessNotConfigured/SERVICE_DISABLED before real work. Probes are selected
// by the GRANTED scopes on the probed account (an ungranted service would only
// 403 with insufficient_scope, which says nothing about enablement). Admin SDK
// is deliberately unprobed: it is role-dependent, so a 403 is ambiguous.

export interface ApiProbeSpec {
  service: string;
  /** console library id for the enable deep-link, e.g. "calendar-json". */
  api: string;
  url: string;
  scopePrefixes: string[];
  /** id-required APIs have no no-arg read; a 404 on a nonexistent id still
   * proves the API is enabled (accessNotConfigured wins before routing). */
  notFoundMeansEnabled?: boolean;
}

const P = 'https://www.googleapis.com/auth/';
const BOGUS_ID = 'mcp-google-multi-probe-nonexistent';

export const API_PROBES: ApiProbeSpec[] = [
  { service: 'gmail', api: 'gmail', url: 'https://gmail.googleapis.com/gmail/v1/users/me/profile', scopePrefixes: [`${P}gmail.`] },
  { service: 'drive', api: 'drive', url: 'https://www.googleapis.com/drive/v3/about?fields=user', scopePrefixes: [`${P}drive`] },
  { service: 'calendar', api: 'calendar-json', url: 'https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=1', scopePrefixes: [`${P}calendar`] },
  // people/me needs profile scopes, not contacts; connections is the read the
  // contacts grant actually authorizes.
  { service: 'contacts', api: 'people', url: 'https://people.googleapis.com/v1/people/me/connections?personFields=names&pageSize=1', scopePrefixes: [`${P}contacts`] },
  { service: 'sheets', api: 'sheets', url: `https://sheets.googleapis.com/v4/spreadsheets/${BOGUS_ID}`, scopePrefixes: [`${P}spreadsheets`], notFoundMeansEnabled: true },
  { service: 'docs', api: 'docs', url: `https://docs.googleapis.com/v1/documents/${BOGUS_ID}`, scopePrefixes: [`${P}documents`], notFoundMeansEnabled: true },
  { service: 'searchconsole', api: 'searchconsole', url: 'https://www.googleapis.com/webmasters/v3/sites', scopePrefixes: [`${P}webmasters`] },
  { service: 'tasks', api: 'tasks', url: 'https://tasks.googleapis.com/tasks/v1/users/@me/lists?maxResults=1', scopePrefixes: [`${P}tasks`] },
  { service: 'chat', api: 'chat', url: 'https://chat.googleapis.com/v1/spaces?pageSize=1', scopePrefixes: [`${P}chat.`] },
  { service: 'meet', api: 'meet', url: 'https://meet.googleapis.com/v2/conferenceRecords?pageSize=1', scopePrefixes: [`${P}meetings.`] },
  { service: 'forms', api: 'forms', url: `https://forms.googleapis.com/v1/forms/${BOGUS_ID}`, scopePrefixes: [`${P}forms.`], notFoundMeansEnabled: true },
  // Probes the Admin API only: the Data API has no no-arg read (every call
  // needs a property id), so its enablement surfaces on first report instead.
  { service: 'analytics', api: 'analyticsadmin', url: 'https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=1', scopePrefixes: [`${P}analytics`] },
];

export function planProbes(granted: string[], probes: ApiProbeSpec[] = API_PROBES): ApiProbeSpec[] {
  return probes.filter((p) => granted.some((s) => p.scopePrefixes.some((prefix) => s.startsWith(prefix))));
}

export interface ApiProbeDeps {
  grantedScopes: (alias: string) => string[];
  request: (alias: string, url: string) => Promise<void>;
}

/** Probe deps over one context's token reads and client; the module-level
 * pair is the single owner's. */
export function apiProbeDepsFor(readTokenFn: typeof readToken, getClientFn: typeof getClient): ApiProbeDeps {
  return {
    grantedScopes: (alias) => {
      try {
        const scope = readTokenFn(alias)?.scope;
        return typeof scope === 'string' ? scope.split(' ').filter(Boolean) : [];
      } catch {
        return [];
      }
    },
    request: async (alias, url) => {
      const auth = await getClientFn(alias as Account);
      await auth.request({ url, timeout: 10_000 });
    },
  };
}

const DEFAULT_DEPS: ApiProbeDeps = apiProbeDepsFor(readToken, getClient);

export async function probeApiEnablement(alias: string, deps: ApiProbeDeps = DEFAULT_DEPS): Promise<ApiProbeResult[]> {
  const results: ApiProbeResult[] = [];
  for (const spec of planProbes(deps.grantedScopes(alias))) {
    try {
      await deps.request(alias, spec.url);
      results.push({ service: spec.service, api: spec.api, ok: true });
    } catch (error: any) {
      const envelope = mapGoogleError(error, alias as Account);
      if (envelope.error === 'network_error') {
        // One connect failure means they will all fail: abort so section 6
        // reports a single WARN "Probe could not complete" with the code.
        throw new Error(envelope.message, { cause: error });
      }
      if (envelope.error === 'api_not_enabled') {
        results.push({ service: spec.service, api: spec.api, ok: false, notEnabled: true, message: envelope.message });
      } else if (spec.notFoundMeansEnabled && envelope.error === 'not_found') {
        results.push({ service: spec.service, api: spec.api, ok: true });
      } else {
        results.push({ service: spec.service, api: spec.api, ok: false, message: envelope.error });
      }
    }
  }
  return results;
}
