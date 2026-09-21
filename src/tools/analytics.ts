import type { ToolRegistry } from '../registry.js';
import { z } from 'zod';
import { coerceArray, coerceBoolean, coerceJson } from './_coerce.js';
import { analyticsdata as analyticsdataClient } from '@googleapis/analyticsdata';
import { analyticsadmin as analyticsadminClient } from '@googleapis/analyticsadmin';
import { accountAliasSchema } from '../accounts.js';
import type { Account } from '../accounts.js';
import { getClient } from '../client.js';
import { handleGoogleApiError } from './_errors.js';

const accountEnum = accountAliasSchema.optional();

/** Accepts "213025502" or "properties/213025502"; rejects the identifiers
 * people paste by mistake (G-… measurement IDs, UA-… properties) with a
 * pointer to the right one. */
export function normalizeProperty(input: string): { name: string } | { hint: string } {
  const t = input.trim();
  if (/^properties\/\d+$/.test(t)) return { name: t };
  if (/^\d+$/.test(t)) return { name: `properties/${t}` };
  if (/^G-[A-Z0-9]+$/i.test(t)) {
    return {
      hint:
        `"${t}" is a measurement ID (a web data-stream tag), not a GA4 property ID. ` +
        'Use the numeric property ID from GA Admin > Property settings, or find it with analytics_account_summaries.',
    };
  }
  if (/^UA-/i.test(t)) {
    return {
      hint:
        `"${t}" is a Universal Analytics property, which the GA4 APIs cannot query. ` +
        'Use the numeric ID of a GA4 property (find yours with analytics_account_summaries).',
    };
  }
  return {
    hint:
      `"${t}" is not a GA4 property reference. Pass the numeric property ID ` +
      '(e.g. "213025502" or "properties/213025502"); find yours with analytics_account_summaries.',
  };
}

/** GA4 report rows ({dimensionValues:[{value}], metricValues:[{value}]}) are
 * verbose; merge each row into one {name: value} object (dimension and metric
 * API names never collide). Shared by runReport and runRealtimeReport. */
export function shapeReport(data: any): Record<string, unknown> {
  const dimensionHeaders: string[] = (data.dimensionHeaders ?? []).map((h: any) => h.name);
  const metricHeaders = (data.metricHeaders ?? []).map((h: any) => ({ name: h.name, type: h.type }));
  const mergeRow = (r: any): Record<string, string> => {
    const out: Record<string, string> = {};
    dimensionHeaders.forEach((name, i) => {
      out[name] = r.dimensionValues?.[i]?.value ?? '';
    });
    metricHeaders.forEach((h: { name: string }, i: number) => {
      out[h.name] = r.metricValues?.[i]?.value ?? '';
    });
    return out;
  };
  const shaped: Record<string, unknown> = {
    rowCount: data.rowCount ?? data.rows?.length ?? 0,
    dimensionHeaders,
    metricHeaders,
    rows: (data.rows ?? []).map(mergeRow),
  };
  if (data.totals?.length) shaped.totals = data.totals.map(mergeRow);
  if (data.maximums?.length) shaped.maximums = data.maximums.map(mergeRow);
  if (data.minimums?.length) shaped.minimums = data.minimums.map(mergeRow);
  if (data.metadata) shaped.metadata = data.metadata;
  if (data.propertyQuota) shaped.propertyQuota = data.propertyQuota;
  return shaped;
}

export function shapeAccountSummaries(data: any): Record<string, unknown> {
  const accounts = (data.accountSummaries ?? []).map((a: any) => ({
    account: a.account,
    displayName: a.displayName,
    properties: (a.propertySummaries ?? []).map((p: any) => ({
      property: p.property,
      displayName: p.displayName,
      ...(p.propertyType && p.propertyType !== 'PROPERTY_TYPE_ORDINARY' ? { propertyType: p.propertyType } : {}),
    })),
  }));
  return { accounts, ...(data.nextPageToken ? { nextPageToken: data.nextPageToken } : {}) };
}

const DESCRIPTION_CAP = 160;

/** Full metadata descriptions run to paragraphs; the first ~160 chars carry
 * the disambiguation the model needs without bloating a ~300-entry list. */
export function shapeMetadata(data: any): Record<string, unknown> {
  const cap = (s: unknown) =>
    typeof s === 'string' && s.length > DESCRIPTION_CAP ? `${s.slice(0, DESCRIPTION_CAP - 3)}...` : s || undefined;
  return {
    dimensions: (data.dimensions ?? []).map((d: any) => ({
      apiName: d.apiName,
      uiName: d.uiName,
      category: d.category,
      ...(d.customDefinition ? { custom: true } : {}),
      description: cap(d.description),
    })),
    metrics: (data.metrics ?? []).map((m: any) => ({
      apiName: m.apiName,
      uiName: m.uiName,
      category: m.category,
      ...(m.type ? { type: m.type } : {}),
      ...(m.expression ? { expression: m.expression } : {}),
      ...(m.customDefinition ? { custom: true } : {}),
      description: cap(m.description),
    })),
  };
}

const propertySchema = z
  .string()
  .describe(
    'GA4 property: numeric ID like "213025502" or "properties/213025502" — NOT a "G-..." measurement ID and not "UA-...". Find yours with analytics_account_summaries.',
  );

export function registerAnalyticsTools(server: ToolRegistry): void {
  server.registerTool(
    'analytics_account_summaries',
    {
      description:
        'List every Google Analytics (GA4) account and property this Google account can access, with their numeric property IDs. The starting point for any Analytics question ("what properties do I have?").',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        pageSize: z.number().min(1).max(200).optional().describe('Summaries per page (default 50, max 200)'),
        pageToken: z.string().optional().describe('Token from a previous page'),
      },
    },
    async ({ account, pageSize, pageToken }) => {
      try {
        const auth = await getClient(account as Account);
        const admin = analyticsadminClient({ version: 'v1beta', auth });
        const res = await admin.accountSummaries.list({ pageSize, pageToken });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(shapeAccountSummaries(res.data), null, 2) }],
        };
      } catch (error: any) {
        return handleAnalyticsError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'analytics_run_report',
    {
      description:
        'Run a Google Analytics (GA4) report: metrics over a date range, optionally grouped by dimensions — the workhorse for questions like "how many users last week, by country". Dates accept YYYY-MM-DD or relative forms ("today", "yesterday", "28daysAgo"). Unsure which dimension/metric names are valid? Call analytics_get_metadata first.',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        property: propertySchema,
        startDate: z.string().describe('Start date: YYYY-MM-DD or relative ("today", "yesterday", "NdaysAgo" e.g. "28daysAgo")'),
        endDate: z.string().describe('End date: YYYY-MM-DD or relative ("today", "yesterday", "NdaysAgo")'),
        metrics: coerceArray(z.string()).describe(
          'Metric API names, e.g. ["activeUsers","sessions","screenPageViews"]. Max 10. Valid names (including custom ones) come from analytics_get_metadata.',
        ),
        dimensions: coerceArray(z.string())
          .optional()
          .describe('Dimension API names to group by, e.g. ["date"] or ["country","deviceCategory"]. Max 9. Omit for a single total row.'),
        dimensionFilter: coerceJson(z.record(z.string(), z.unknown()))
          .optional()
          .describe(
            'FilterExpression on dimensions (applies independently of metricFilter). Simple: {"filter":{"fieldName":"country","stringFilter":{"matchType":"EXACT","value":"France"}}}. AND of two: {"andGroup":{"expressions":[{"filter":{"fieldName":"country","stringFilter":{"matchType":"EXACT","value":"France"}}},{"filter":{"fieldName":"deviceCategory","stringFilter":{"matchType":"EXACT","value":"mobile"}}}]}}. matchType: EXACT | BEGINS_WITH | ENDS_WITH | CONTAINS | FULL_REGEXP (add "caseSensitive":true for case-sensitive). Also available: inListFilter, notExpression, orGroup.',
          ),
        metricFilter: coerceJson(z.record(z.string(), z.unknown()))
          .optional()
          .describe(
            'FilterExpression on metric values, e.g. {"filter":{"fieldName":"sessions","numericFilter":{"operation":"GREATER_THAN","value":{"int64Value":"100"}}}}. operation: EQUAL | LESS_THAN | LESS_THAN_OR_EQUAL | GREATER_THAN | GREATER_THAN_OR_EQUAL; betweenFilter takes fromValue/toValue.',
          ),
        orderBys: coerceJson(z.array(z.record(z.string(), z.unknown())))
          .optional()
          .describe('Sort order, e.g. [{"metric":{"metricName":"sessions"},"desc":true}] or [{"dimension":{"dimensionName":"date"}}]. Default: unordered.'),
        limit: z.number().min(1).max(250000).optional().describe('Max rows to return (API default 10000). Keep small for readable output.'),
        offset: z.number().min(0).optional().describe('Zero-based row offset for pagination'),
        metricAggregations: coerceArray(z.enum(['TOTAL', 'MINIMUM', 'MAXIMUM', 'COUNT']))
          .optional()
          .describe('Also return aggregate rows across all matching data (surfaced as totals/maximums/minimums)'),
        keepEmptyRows: coerceBoolean.optional().describe('Include rows whose metrics are all zero (default false)'),
        returnPropertyQuota: coerceBoolean.optional().describe("Include this property's remaining quota tokens in the response"),
      },
    },
    async ({ account, property, startDate, endDate, metrics, dimensions, dimensionFilter, metricFilter, orderBys, limit, offset, metricAggregations, keepEmptyRows, returnPropertyQuota }) => {
      const prop = normalizeProperty(property);
      if ('hint' in prop) return invalidProperty(prop.hint, account);
      try {
        const auth = await getClient(account as Account);
        const dataApi = analyticsdataClient({ version: 'v1beta', auth });
        const requestBody: any = {
          dateRanges: [{ startDate, endDate }],
          metrics: metrics.map((name) => ({ name })),
        };
        if (dimensions?.length) requestBody.dimensions = dimensions.map((name) => ({ name }));
        if (dimensionFilter) requestBody.dimensionFilter = dimensionFilter;
        if (metricFilter) requestBody.metricFilter = metricFilter;
        if (orderBys?.length) requestBody.orderBys = orderBys;
        if (limit !== undefined) requestBody.limit = limit;
        if (offset !== undefined) requestBody.offset = offset;
        if (metricAggregations?.length) requestBody.metricAggregations = metricAggregations;
        if (keepEmptyRows !== undefined) requestBody.keepEmptyRows = keepEmptyRows;
        if (returnPropertyQuota !== undefined) requestBody.returnPropertyQuota = returnPropertyQuota;
        const res = await dataApi.properties.runReport({ property: prop.name, requestBody });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(shapeReport(res.data), null, 2) }],
        };
      } catch (error: any) {
        return handleAnalyticsError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'analytics_run_realtime_report',
    {
      description:
        'Run a GA4 realtime report: who is on the site right now (last 30 minutes). Realtime supports a restricted set of names, e.g. metrics activeUsers, screenPageViews, eventCount, keyEvents; dimensions country, city, deviceCategory, unifiedScreenName, eventName.',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        property: propertySchema,
        metrics: coerceArray(z.string()).describe('Realtime metric API names, e.g. ["activeUsers"]'),
        dimensions: coerceArray(z.string()).optional().describe('Realtime dimension API names, e.g. ["country"] or ["unifiedScreenName"]'),
        dimensionFilter: coerceJson(z.record(z.string(), z.unknown()))
          .optional()
          .describe('FilterExpression on dimensions — same shape as analytics_run_report'),
        metricFilter: coerceJson(z.record(z.string(), z.unknown()))
          .optional()
          .describe('FilterExpression on metric values — same shape as analytics_run_report'),
        minuteRanges: coerceJson(z.array(z.record(z.string(), z.unknown())))
          .optional()
          .describe('Up to 2 ranges of minutes-ago, e.g. [{"startMinutesAgo":29,"endMinutesAgo":0}] (default: last 30 minutes)'),
        limit: z.number().min(1).max(250000).optional().describe('Max rows to return'),
        returnPropertyQuota: coerceBoolean.optional().describe("Include this property's remaining realtime quota tokens"),
      },
    },
    async ({ account, property, metrics, dimensions, dimensionFilter, metricFilter, minuteRanges, limit, returnPropertyQuota }) => {
      const prop = normalizeProperty(property);
      if ('hint' in prop) return invalidProperty(prop.hint, account);
      try {
        const auth = await getClient(account as Account);
        const dataApi = analyticsdataClient({ version: 'v1beta', auth });
        const requestBody: any = { metrics: metrics.map((name) => ({ name })) };
        if (dimensions?.length) requestBody.dimensions = dimensions.map((name) => ({ name }));
        if (dimensionFilter) requestBody.dimensionFilter = dimensionFilter;
        if (metricFilter) requestBody.metricFilter = metricFilter;
        if (minuteRanges?.length) requestBody.minuteRanges = minuteRanges;
        if (limit !== undefined) requestBody.limit = limit;
        if (returnPropertyQuota !== undefined) requestBody.returnPropertyQuota = returnPropertyQuota;
        const res = await dataApi.properties.runRealtimeReport({ property: prop.name, requestBody });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(shapeReport(res.data), null, 2) }],
        };
      } catch (error: any) {
        return handleAnalyticsError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'analytics_get_metadata',
    {
      description:
        'List every valid dimension and metric API name for a GA4 property, including its custom definitions. Call this before analytics_run_report when unsure which names exist. Property "0" returns the standard set without property access.',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        property: propertySchema,
      },
    },
    async ({ account, property }) => {
      const prop = normalizeProperty(property);
      if ('hint' in prop) return invalidProperty(prop.hint, account);
      try {
        const auth = await getClient(account as Account);
        const dataApi = analyticsdataClient({ version: 'v1beta', auth });
        const res = await dataApi.properties.getMetadata({ name: `${prop.name}/metadata` });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(shapeMetadata(res.data), null, 2) }],
        };
      } catch (error: any) {
        return handleAnalyticsError(error, account as Account);
      }
    },
  );
}

function invalidProperty(hint: string, account: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ error: 'invalid_params', message: 'Invalid GA4 property reference.', hint, retriable: false, account }),
      },
    ],
    isError: true as const,
  };
}

function handleAnalyticsError(error: any, account: Account) {
  return handleGoogleApiError(
    error,
    account,
    {
      scope: 'Needs the "analytics" bundle on this account: add it to the scope profile, then re-auth.',
      // GA4 answers PERMISSION_DENIED for a property ACL too, and the old
      // combined hint sent those callers to re-auth a scope they already had.
      resource: 'The scope is not the problem: this Google account has no access to that GA4 property. Grant it in GA4 Admin > Property Access Management, or call analytics_account_summaries to see the properties it can read.',
    },
  );
}
