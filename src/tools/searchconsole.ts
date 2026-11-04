import type { ToolRegistry } from '../registry.js';
import { z } from 'zod';
import { coerceArray, coerceJson } from './_coerce.js';
import { searchconsole as searchconsoleClient } from '@googleapis/searchconsole';
import { webmasters as webmastersClient } from '@googleapis/webmasters';
import { accountArgLive } from '../accounts.js';
import type { Account } from '../accounts.js';
import { getClient, type CuratedToolDeps } from '../client.js';
import { handleGoogleApiError, invalidParams, mapGoogleError } from './_errors.js';

// The URL Inspection API allows 600 queries a minute per site, so a batch stays small and gently parallel.
const INSPECT_BATCH_MAX = 20;
const INSPECT_CONCURRENCY = 3;


export function registerSearchConsoleTools(server: ToolRegistry, deps: CuratedToolDeps = {}): void {
  // Per-registry, live account enum + injectable client: the schema follows
  // the registry's account view at parse time, not a process-global default.
  const accountEnum = accountArgLive(() => server.accountAliases()).optional();
  const getClientFn = deps.getClientFn ?? getClient;
  // ─── Sites ───────────────────────────────────────────────

  server.registerTool(
    'searchconsole_sites_list',
    {
      description: 'List all sites (properties) the account has access to in Google Search Console',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
      },
    },
    async ({ account }) => {
      try {
        const auth = await getClientFn(account as Account);
        const wm = webmastersClient({ version: 'v3', auth });
        const res = await wm.sites.list();
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data.siteEntry ?? [], null, 2) }],
        };
      } catch (error: any) {
        return handleSearchConsoleError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'searchconsole_sites_get',
    {
      description: 'Get details for a specific site (property) in Google Search Console',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        siteUrl: z.string().min(1).describe('Site URL exactly as it appears in Search Console (e.g. "https://example.com/" or "sc-domain:example.com")'),
      },
    },
    async ({ account, siteUrl }) => {
      try {
        const auth = await getClientFn(account as Account);
        const wm = webmastersClient({ version: 'v3', auth });
        const res = await wm.sites.get({ siteUrl });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        return handleSearchConsoleError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'searchconsole_sites_add',
    {
      description: 'Add a site (property) to Google Search Console. You still need to verify ownership separately.',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        siteUrl: z.string().min(1).describe('Site URL to add (e.g. "https://example.com/" or "sc-domain:example.com")'),
      },
    },
    async ({ account, siteUrl }) => {
      try {
        const auth = await getClientFn(account as Account);
        const wm = webmastersClient({ version: 'v3', auth });
        await wm.sites.add({ siteUrl });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: true, siteUrl }, null, 2) }],
        };
      } catch (error: any) {
        return handleSearchConsoleError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'searchconsole_sites_delete',
    {
      description: 'Remove a site (property) from Google Search Console',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        siteUrl: z.string().min(1).describe('Site URL to remove'),
      },
    },
    async ({ account, siteUrl }) => {
      try {
        const auth = await getClientFn(account as Account);
        const wm = webmastersClient({ version: 'v3', auth });
        await wm.sites.delete({ siteUrl });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: true, deleted: siteUrl }, null, 2) }],
        };
      } catch (error: any) {
        return handleSearchConsoleError(error, account as Account);
      }
    },
  );

  // ─── Sitemaps ────────────────────────────────────────────

  server.registerTool(
    'searchconsole_sitemaps_list',
    {
      description: 'List all sitemaps submitted for a site in Google Search Console',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        siteUrl: z.string().min(1).describe('Site URL (e.g. "https://example.com/" or "sc-domain:example.com")'),
      },
    },
    async ({ account, siteUrl }) => {
      try {
        const auth = await getClientFn(account as Account);
        const wm = webmastersClient({ version: 'v3', auth });
        const res = await wm.sitemaps.list({ siteUrl });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data.sitemap ?? [], null, 2) }],
        };
      } catch (error: any) {
        return handleSearchConsoleError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'searchconsole_sitemaps_get',
    {
      description: 'Get details for a specific sitemap submitted to Google Search Console',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        siteUrl: z.string().min(1).describe('Site URL'),
        feedpath: z.string().describe('Full URL of the sitemap (e.g. "https://example.com/sitemap.xml")'),
      },
    },
    async ({ account, siteUrl, feedpath }) => {
      try {
        const auth = await getClientFn(account as Account);
        const wm = webmastersClient({ version: 'v3', auth });
        const res = await wm.sitemaps.get({ siteUrl, feedpath });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        return handleSearchConsoleError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'searchconsole_sitemaps_submit',
    {
      description: 'Submit a sitemap to Google Search Console for a site',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        siteUrl: z.string().min(1).describe('Site URL'),
        feedpath: z.string().describe('Full URL of the sitemap to submit (e.g. "https://example.com/sitemap.xml")'),
      },
    },
    async ({ account, siteUrl, feedpath }) => {
      try {
        const auth = await getClientFn(account as Account);
        const wm = webmastersClient({ version: 'v3', auth });
        await wm.sitemaps.submit({ siteUrl, feedpath });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: true, siteUrl, feedpath }, null, 2) }],
        };
      } catch (error: any) {
        return handleSearchConsoleError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'searchconsole_sitemaps_delete',
    {
      description: 'Delete a sitemap from Google Search Console',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        siteUrl: z.string().min(1).describe('Site URL'),
        feedpath: z.string().describe('Full URL of the sitemap to delete'),
      },
    },
    async ({ account, siteUrl, feedpath }) => {
      try {
        const auth = await getClientFn(account as Account);
        const wm = webmastersClient({ version: 'v3', auth });
        await wm.sitemaps.delete({ siteUrl, feedpath });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: true, deleted: feedpath }, null, 2) }],
        };
      } catch (error: any) {
        return handleSearchConsoleError(error, account as Account);
      }
    },
  );

  // ─── Search Analytics ────────────────────────────────────

  server.registerTool(
    'searchconsole_searchanalytics_query',
    {
      description: 'Query Google Search Console search analytics data. Returns clicks, impressions, CTR, and position for your site. Supports filtering by query, page, country, device, search type, and date range.',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        siteUrl: z.string().min(1).describe('Site URL (e.g. "https://example.com/" or "sc-domain:example.com")'),
        startDate: z.string().describe('Start date (YYYY-MM-DD). Data is available starting ~3 days ago.'),
        endDate: z.string().describe('End date (YYYY-MM-DD)'),
        dimensions: coerceArray(z.enum(['query', 'page', 'country', 'device', 'searchAppearance', 'date'])).optional()
          .describe('Dimensions to group by. Common: ["query", "page"], ["date"], ["query", "date"]'),
        type: z.enum(['web', 'image', 'video', 'news', 'discover', 'googleNews']).optional()
          .describe('Search type filter (default: web)'),
        dimensionFilterGroups: coerceJson(z.array(z.object({
          groupType: z.enum(['and']).optional(),
          filters: z.array(z.object({
            dimension: z.enum(['query', 'page', 'country', 'device', 'searchAppearance']),
            operator: z.enum(['contains', 'equals', 'notContains', 'notEquals', 'includingRegex', 'excludingRegex']),
            expression: z.string(),
          })),
        }))).optional()
          .describe('Filters to narrow results. Example: filter by page containing "/blog/" or query containing "keyword"'),
        rowLimit: z.number().min(1).max(25000).optional()
          .describe('Max rows to return (default: 1000, max: 25000)'),
        startRow: z.number().min(0).optional()
          .describe('Zero-based row offset for pagination (default: 0)'),
        aggregationType: z.enum(['auto', 'byPage', 'byProperty']).optional()
          .describe('How to aggregate data (default: auto)'),
        dataState: z.enum(['all', 'final']).optional()
          .describe('"all" includes fresh (not finalized) data; "final" only finalized data'),
      },
    },
    async ({ account, siteUrl, startDate, endDate, dimensions, type, dimensionFilterGroups, rowLimit, startRow, aggregationType, dataState }) => {
      try {
        const auth = await getClientFn(account as Account);
        const wm = webmastersClient({ version: 'v3', auth });

        const requestBody: any = { startDate, endDate };
        if (dimensions) requestBody.dimensions = dimensions;
        if (type) requestBody.type = type;
        if (dimensionFilterGroups) requestBody.dimensionFilterGroups = dimensionFilterGroups;
        if (rowLimit) requestBody.rowLimit = rowLimit;
        if (startRow !== undefined) requestBody.startRow = startRow;
        if (aggregationType) requestBody.aggregationType = aggregationType;
        if (dataState) requestBody.dataState = dataState;

        const res = await wm.searchanalytics.query({ siteUrl, requestBody });

        const summary = {
          rowCount: res.data.rows?.length ?? 0,
          responseAggregationType: res.data.responseAggregationType,
          rows: res.data.rows ?? [],
        };

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(summary, null, 2) }],
        };
      } catch (error: any) {
        return handleSearchConsoleError(error, account as Account);
      }
    },
  );

  // ─── URL Inspection ──────────────────────────────────────

  server.registerTool(
    'searchconsole_url_inspect',
    {
      description: 'Inspect a URL using the Google Search Console URL Inspection API. Returns indexing status, crawl info, rich results, AMP status, and mobile usability for a specific URL. Pass `inspectionUrls` instead to inspect up to ' + INSPECT_BATCH_MAX + ' URLs of the same property in one call (one result per URL; a failing URL does not stop the others).',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        siteUrl: z.string().min(1).describe('Site URL as registered in Search Console (e.g. "https://example.com/" or "sc-domain:example.com")'),
        inspectionUrl: z.string().min(1).optional().describe('The fully-qualified URL to inspect (must be under the siteUrl property). Pass this or inspectionUrls.'),
        inspectionUrls: coerceArray(z.string().min(1)).optional().describe(`Several fully-qualified URLs to inspect, all under the siteUrl property, up to ${INSPECT_BATCH_MAX}. Pass this or inspectionUrl.`),
        languageCode: z.string().optional().describe('BCP-47 language code for localized results (e.g. "en-US", "fr")'),
      },
    },
    async ({ account, siteUrl, inspectionUrl, inspectionUrls, languageCode }) => {
      const urls = [...new Set([...(inspectionUrl ? [inspectionUrl] : []), ...(inspectionUrls ?? [])])];
      if (urls.length === 0) {
        return invalidParams(account as Account, 'Pass inspectionUrl or inspectionUrls.', `Give the URL to inspect, or a list of up to ${INSPECT_BATCH_MAX} URLs under the siteUrl property.`);
      }
      if (urls.length > INSPECT_BATCH_MAX) {
        return invalidParams(
          account as Account,
          `${urls.length} URLs given; one call inspects at most ${INSPECT_BATCH_MAX}.`,
          `Split inspectionUrls into calls of ${INSPECT_BATCH_MAX} or fewer.`,
        );
      }
      try {
        const auth = await getClientFn(account as Account);
        const searchconsole = searchconsoleClient({ version: 'v1', auth });
        const inspectOne = async (url: string) => (await searchconsole.urlInspection.index.inspect({
          requestBody: { inspectionUrl: url, siteUrl, languageCode: languageCode ?? 'en' },
        })).data;

        // One URL through the single-URL field keeps the original response shape.
        if (inspectionUrl && !inspectionUrls) {
          return { content: [{ type: 'text' as const, text: JSON.stringify(await inspectOne(inspectionUrl), null, 2) }] };
        }

        const results = new Array<Record<string, unknown>>(urls.length);
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(INSPECT_CONCURRENCY, urls.length) }, async () => {
          while (next < urls.length) {
            const i = next++;
            try {
              results[i] = { inspectionUrl: urls[i], ok: true, ...(await inspectOne(urls[i])) };
            } catch (e: any) {
              const env = mapGoogleError(e, account as Account);
              results[i] = { inspectionUrl: urls[i], ok: false, error: env.error, message: env.message, ...(env.hint ? { hint: env.hint } : {}) };
            }
          }
        }));
        const inspected = results.filter((r) => r.ok).length;
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ inspected, failed: results.length - inspected, results }, null, 2) }],
          // Only a call that inspected nothing is an error; a partial result is reported as data.
          ...(inspected === 0 ? { isError: true as const } : {}),
        };
      } catch (error: any) {
        return handleSearchConsoleError(error, account as Account);
      }
    },
  );
}

function handleSearchConsoleError(error: any, account: Account) {
  return handleGoogleApiError(error, account);
}
