import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { google } from 'googleapis';
import { ACCOUNTS } from '../accounts.js';
import type { Account } from '../accounts.js';
import { getClient } from '../client.js';

const accountEnum = z.enum(ACCOUNTS);

export function registerSearchConsoleTools(server: McpServer): void {
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
        const auth = await getClient(account as Account);
        const wm = google.webmasters({ version: 'v3', auth });
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
        siteUrl: z.string().describe('Site URL exactly as it appears in Search Console (e.g. "https://example.com/" or "sc-domain:example.com")'),
      },
    },
    async ({ account, siteUrl }) => {
      try {
        const auth = await getClient(account as Account);
        const wm = google.webmasters({ version: 'v3', auth });
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
        siteUrl: z.string().describe('Site URL to add (e.g. "https://example.com/" or "sc-domain:example.com")'),
      },
    },
    async ({ account, siteUrl }) => {
      try {
        const auth = await getClient(account as Account);
        const wm = google.webmasters({ version: 'v3', auth });
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
        siteUrl: z.string().describe('Site URL to remove'),
      },
    },
    async ({ account, siteUrl }) => {
      try {
        const auth = await getClient(account as Account);
        const wm = google.webmasters({ version: 'v3', auth });
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
        siteUrl: z.string().describe('Site URL (e.g. "https://example.com/" or "sc-domain:example.com")'),
      },
    },
    async ({ account, siteUrl }) => {
      try {
        const auth = await getClient(account as Account);
        const wm = google.webmasters({ version: 'v3', auth });
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
        siteUrl: z.string().describe('Site URL'),
        feedpath: z.string().describe('Full URL of the sitemap (e.g. "https://example.com/sitemap.xml")'),
      },
    },
    async ({ account, siteUrl, feedpath }) => {
      try {
        const auth = await getClient(account as Account);
        const wm = google.webmasters({ version: 'v3', auth });
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
        siteUrl: z.string().describe('Site URL'),
        feedpath: z.string().describe('Full URL of the sitemap to submit (e.g. "https://example.com/sitemap.xml")'),
      },
    },
    async ({ account, siteUrl, feedpath }) => {
      try {
        const auth = await getClient(account as Account);
        const wm = google.webmasters({ version: 'v3', auth });
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
        siteUrl: z.string().describe('Site URL'),
        feedpath: z.string().describe('Full URL of the sitemap to delete'),
      },
    },
    async ({ account, siteUrl, feedpath }) => {
      try {
        const auth = await getClient(account as Account);
        const wm = google.webmasters({ version: 'v3', auth });
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
        siteUrl: z.string().describe('Site URL (e.g. "https://example.com/" or "sc-domain:example.com")'),
        startDate: z.string().describe('Start date (YYYY-MM-DD). Data is available starting ~3 days ago.'),
        endDate: z.string().describe('End date (YYYY-MM-DD)'),
        dimensions: z.array(z.enum(['query', 'page', 'country', 'device', 'searchAppearance', 'date'])).optional()
          .describe('Dimensions to group by. Common: ["query", "page"], ["date"], ["query", "date"]'),
        type: z.enum(['web', 'image', 'video', 'news', 'discover', 'googleNews']).optional()
          .describe('Search type filter (default: web)'),
        dimensionFilterGroups: z.array(z.object({
          groupType: z.enum(['and']).optional(),
          filters: z.array(z.object({
            dimension: z.enum(['query', 'page', 'country', 'device', 'searchAppearance']),
            operator: z.enum(['contains', 'equals', 'notContains', 'notEquals', 'includingRegex', 'excludingRegex']),
            expression: z.string(),
          })),
        })).optional()
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
        const auth = await getClient(account as Account);
        const wm = google.webmasters({ version: 'v3', auth });

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
      description: 'Inspect a URL using the Google Search Console URL Inspection API. Returns indexing status, crawl info, rich results, AMP status, and mobile usability for a specific URL.',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        siteUrl: z.string().describe('Site URL as registered in Search Console (e.g. "https://example.com/" or "sc-domain:example.com")'),
        inspectionUrl: z.string().describe('The fully-qualified URL to inspect (must be under the siteUrl property)'),
        languageCode: z.string().optional().describe('BCP-47 language code for localized results (e.g. "en-US", "fr")'),
      },
    },
    async ({ account, siteUrl, inspectionUrl, languageCode }) => {
      try {
        const auth = await getClient(account as Account);
        const searchconsole = google.searchconsole({ version: 'v1', auth });

        const res = await searchconsole.urlInspection.index.inspect({
          requestBody: {
            inspectionUrl,
            siteUrl,
            languageCode: languageCode ?? 'en',
          },
        });

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        return handleSearchConsoleError(error, account as Account);
      }
    },
  );
}

function handleSearchConsoleError(error: any, account: Account) {
  if (error.code === 401) {
    return {
      content: [{
        type: 'text' as const,
        text: `Authentication error for account "${account}". The "webmasters" scope may be missing. Re-run: node dist/index.js auth --account ${account}`,
      }],
      isError: true,
    };
  }
  if (error.code === 403) {
    return {
      content: [{
        type: 'text' as const,
        text: `Permission denied for account "${account}". Ensure the account has access to this Search Console property and the "webmasters" OAuth scope is granted.`,
      }],
      isError: true,
    };
  }
  if (error.code === 429) {
    const retryAfter = error.response?.headers?.['retry-after'] ?? 'unknown';
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ error: 'rate_limited', retryAfter }),
      }],
      isError: true,
    };
  }
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({ error: error.message ?? String(error), code: error.code }),
    }],
    isError: true,
  };
}
