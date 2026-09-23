import type { ToolRegistry } from '../registry.js';
import { z } from 'zod';
import { coerceArray, coerceBoolean } from './_coerce.js';
import { calendar as calendarClient } from '@googleapis/calendar';
import { accountArgLive } from '../accounts.js';
import type { Account } from '../accounts.js';
import { getClient, type CuratedToolDeps } from '../client.js';
import { checkOutbound } from '../outbound-allowlist.js';
import { handleGoogleApiError, invalidParams } from './_errors.js';
import { listResult, sliceClean } from '../trim.js';


export function registerCalendarTools(server: ToolRegistry, deps: CuratedToolDeps = {}): void {
  // Per-registry, LIVE account enum + injectable client (S1.10): the
  // schema follows the registry's account view at parse time, and the
  // custody path is the context's, not the process global.
  const accountEnum = accountArgLive(() => server.accountAliases()).optional();
  const getClientFn = deps.getClientFn ?? getClient;
  server.registerTool(
    'calendar_list_calendars',
    {
      description: 'List all calendars for a Google account',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
      },
    },
    async ({ account }) => {
      try {
        const auth = await getClientFn(account as Account);
        const cal = calendarClient({ version: 'v3', auth });

        const res = await cal.calendarList.list();
        const calendars = (res.data.items ?? []).map((c) => ({
          id: c.id,
          summary: c.summary,
          description: c.description ?? '',
          primary: c.primary ?? false,
          timeZone: c.timeZone,
          backgroundColor: c.backgroundColor,
        }));

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(calendars, null, 2) }],
        };
      } catch (error: any) {
        return handleCalendarError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'calendar_list_events',
    {
      description: 'List events from a Google Calendar (trimmed view: descriptions capped, created/updated and empty fields omitted — use calendar_get_event for a full event)',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        calendarId: z.string().default('primary').optional()
          .describe('Calendar ID (default: primary)'),
        query: z.string().optional().describe('Free-text search query'),
        timeMin: z.string().optional()
          .describe('Start of time range (ISO 8601, e.g. "2026-04-04T00:00:00Z")'),
        timeMax: z.string().optional()
          .describe('End of time range (ISO 8601)'),
        maxResults: z.number().min(1).max(250).default(25).optional()
          .describe('Max events to return (default: 25)'),
        pageToken: z.string().min(1).optional()
          .describe('Continuation token from a previous call\'s nextPageToken'),
      },
    },
    async ({ account, calendarId, query, timeMin, timeMax, maxResults, pageToken }) => {
      const rangeError = timeRangeError(timeMin, timeMax);
      if (rangeError) return invalidParams(account as Account, rangeError, TIME_RANGE_HINT);
      try {
        const auth = await getClientFn(account as Account);
        const cal = calendarClient({ version: 'v3', auth });

        const params: any = {
          calendarId: calendarId ?? 'primary',
          maxResults: maxResults ?? 25,
          singleEvents: true,
          orderBy: 'startTime',
        };

        if (query) params.q = query;
        if (timeMin) params.timeMin = timeMin;
        if (timeMax) params.timeMax = timeMax;
        if (pageToken) params.pageToken = pageToken;
        // A page token is only valid for the window that produced it, so
        // re-evaluating the "now" default would fetch page 2 of a different query.
        if (!timeMin && !timeMax && !pageToken) {
          params.timeMin = new Date().toISOString();
        }

        const res = await cal.events.list(params);
        const events = (res.data.items ?? []).map((e) => formatEvent(e, { full: false }));

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(listResult('events', events, {
            nextPageToken: res.data.nextPageToken,
          }), null, 2) }],
        };
      } catch (error: any) {
        return handleCalendarError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'calendar_get_event',
    {
      description: 'Get a single Google Calendar event by ID',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        eventId: z.string().min(1).describe('Calendar event ID'),
        calendarId: z.string().default('primary').optional()
          .describe('Calendar ID (default: primary)'),
      },
    },
    async ({ account, eventId, calendarId }) => {
      try {
        const auth = await getClientFn(account as Account);
        const cal = calendarClient({ version: 'v3', auth });

        const res = await cal.events.get({
          calendarId: calendarId ?? 'primary',
          eventId,
        });

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(formatEvent(res.data), null, 2) }],
        };
      } catch (error: any) {
        return handleCalendarError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'calendar_create_event',
    {
      description: 'Create a Google Calendar event',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        summary: z.string().describe('Event title'),
        start: z.string().describe('Start time (ISO 8601, e.g. "2026-04-05T10:00:00+01:00")'),
        end: z.string().describe('End time (ISO 8601)'),
        description: z.string().optional().describe('Event description'),
        location: z.string().optional().describe('Event location'),
        attendees: z.string().optional()
          .describe('Comma-separated email addresses of attendees'),
        calendarId: z.string().default('primary').optional()
          .describe('Calendar ID (default: primary)'),
        allDay: coerceBoolean.default(false).optional()
          .describe('If true, start/end are dates (YYYY-MM-DD) not datetimes'),
      },
    },
    async ({ account, summary, start, end, description, location, attendees, calendarId, allDay }) => {
      try {
        if (attendees) {
          const outbound = checkOutbound('calendar attendee', attendees.split(','), String(account));
          if (outbound) return outbound;
        }
        const auth = await getClientFn(account as Account);
        const cal = calendarClient({ version: 'v3', auth });

        const event: any = { summary };

        if (allDay) {
          event.start = { date: start };
          event.end = { date: end };
        } else {
          event.start = { dateTime: start };
          event.end = { dateTime: end };
        }

        if (description) event.description = description;
        if (location) event.location = location;
        if (attendees) {
          event.attendees = attendees.split(',').map((e: string) => ({ email: e.trim() }));
        }

        const res = await cal.events.insert({
          calendarId: calendarId ?? 'primary',
          requestBody: event,
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(formatEvent(res.data), null, 2),
          }],
        };
      } catch (error: any) {
        return handleCalendarError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'calendar_update_event',
    {
      description: 'Update a Google Calendar event',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        eventId: z.string().min(1).describe('Calendar event ID'),
        summary: z.string().optional().describe('New event title'),
        start: z.string().optional().describe('New start time (ISO 8601)'),
        end: z.string().optional().describe('New end time (ISO 8601)'),
        description: z.string().optional().describe('New event description'),
        location: z.string().optional().describe('New event location'),
        attendees: z.string().optional()
          .describe('Comma-separated email addresses (replaces existing attendees)'),
        calendarId: z.string().default('primary').optional()
          .describe('Calendar ID (default: primary)'),
      },
    },
    async ({ account, eventId, summary, start, end, description, location, attendees, calendarId }) => {
      try {
        if (attendees) {
          const outbound = checkOutbound('calendar attendee', attendees.split(','), String(account));
          if (outbound) return outbound;
        }
        const auth = await getClientFn(account as Account);
        const cal = calendarClient({ version: 'v3', auth });

        // Fetch the event first so a 404 surfaces before we attempt the patch.
        await cal.events.get({
          calendarId: calendarId ?? 'primary',
          eventId,
        });

        const patch: any = {};
        if (summary !== undefined) patch.summary = summary;
        if (description !== undefined) patch.description = description;
        if (location !== undefined) patch.location = location;
        if (start !== undefined) {
          patch.start = start.length === 10
            ? { date: start }
            : { dateTime: start };
        }
        if (end !== undefined) {
          patch.end = end.length === 10
            ? { date: end }
            : { dateTime: end };
        }
        if (attendees !== undefined) {
          patch.attendees = attendees.split(',').map((e: string) => ({ email: e.trim() }));
        }

        const res = await cal.events.patch({
          calendarId: calendarId ?? 'primary',
          eventId,
          requestBody: patch,
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(formatEvent(res.data), null, 2),
          }],
        };
      } catch (error: any) {
        return handleCalendarError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'calendar_delete_event',
    {
      description: 'Delete a Google Calendar event',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        eventId: z.string().min(1).describe('Calendar event ID'),
        calendarId: z.string().default('primary').optional()
          .describe('Calendar ID (default: primary)'),
      },
    },
    async ({ account, eventId, calendarId }) => {
      try {
        const auth = await getClientFn(account as Account);
        const cal = calendarClient({ version: 'v3', auth });

        await cal.events.delete({
          calendarId: calendarId ?? 'primary',
          eventId,
        });

        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ deleted: true, eventId }, null, 2) }],
        };
      } catch (error: any) {
        return handleCalendarError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'calendar_quick_add',
    {
      description: 'Create a calendar event from a natural language string. Google parses date, time, title, and guests automatically.',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        calendarId: z.string().default('primary').optional()
          .describe('Calendar ID (default: primary)'),
        text: z.string().describe('Natural language event, e.g. "Lunch with Farouk Thursday 1pm at Le Boulanger"'),
        sendNotifications: coerceBoolean.optional().describe('Send notifications to attendees (default: false)'),
      },
    },
    async ({ account, calendarId, text, sendNotifications }) => {
      try {
        const auth = await getClientFn(account as Account);
        const cal = calendarClient({ version: 'v3', auth });
        const res = await cal.events.quickAdd({
          calendarId: calendarId ?? 'primary',
          text,
          sendNotifications: sendNotifications ?? false,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(formatEvent(res.data), null, 2) }],
        };
      } catch (error: any) {
        return handleCalendarError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'calendar_move_event',
    {
      description: 'Move an event from one calendar to another',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        calendarId: z.string().min(1).describe('Source calendar ID'),
        eventId: z.string().min(1).describe('Event ID to move'),
        destinationCalendarId: z.string().min(1).describe('Destination calendar ID'),
        sendNotifications: coerceBoolean.optional().describe('Send notifications (default: false)'),
      },
    },
    async ({ account, calendarId, eventId, destinationCalendarId, sendNotifications }) => {
      try {
        const auth = await getClientFn(account as Account);
        const cal = calendarClient({ version: 'v3', auth });
        const res = await cal.events.move({
          calendarId,
          eventId,
          destination: destinationCalendarId,
          sendNotifications: sendNotifications ?? false,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(formatEvent(res.data), null, 2) }],
        };
      } catch (error: any) {
        return handleCalendarError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'calendar_list_instances',
    {
      description: 'List all occurrences of a recurring calendar event (trimmed view like calendar_list_events — use calendar_get_event for a full event)',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        calendarId: z.string().default('primary').optional()
          .describe('Calendar ID (default: primary)'),
        eventId: z.string().min(1).describe('ID of the recurring event series'),
        timeMin: z.string().optional().describe('ISO 8601 — filter instances after this time'),
        timeMax: z.string().optional().describe('ISO 8601 — filter instances before this time'),
        maxResults: z.number().min(1).max(250).default(25).optional()
          .describe('Max instances to return (default: 25)'),
        pageToken: z.string().min(1).optional()
          .describe('Continuation token from a previous call\'s nextPageToken'),
      },
    },
    async ({ account, calendarId, eventId, timeMin, timeMax, maxResults, pageToken }) => {
      const rangeError = timeRangeError(timeMin, timeMax);
      if (rangeError) return invalidParams(account as Account, rangeError, TIME_RANGE_HINT);
      try {
        const auth = await getClientFn(account as Account);
        const cal = calendarClient({ version: 'v3', auth });
        const res = await cal.events.instances({
          calendarId: calendarId ?? 'primary',
          eventId,
          timeMin,
          timeMax,
          maxResults: maxResults ?? 25,
          ...(pageToken ? { pageToken } : {}),
        });
        const events = (res.data.items ?? []).map((e) => formatEvent(e, { full: false }));
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(listResult('instances', events, {
            nextPageToken: res.data.nextPageToken,
          }), null, 2) }],
        };
      } catch (error: any) {
        return handleCalendarError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'calendar_get_freebusy',
    {
      description: 'Check free/busy times for one or more calendars within a time window. Returns only busy blocks, not event details.',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        calendarIds: coerceArray(z.string()).describe('Calendar IDs to check, e.g. ["primary", "user@example.com"]'),
        timeMin: z.string().describe('ISO 8601 start of window'),
        timeMax: z.string().describe('ISO 8601 end of window'),
        timeZone: z.string().optional().describe('Timezone (default: UTC)'),
      },
    },
    async ({ account, calendarIds, timeMin, timeMax, timeZone }) => {
      try {
        if (calendarIds.length === 0) {
          return invalidParams(
            account as Account,
            '`calendarIds` is empty, so there is nothing to check.',
            'Pass at least one calendar ID, e.g. ["primary"]. Use calendar_list_calendars to see the IDs this account can read.',
          );
        }
        const rangeError = timeRangeError(timeMin, timeMax);
        if (rangeError) return invalidParams(account as Account, rangeError, TIME_RANGE_HINT);
        const auth = await getClientFn(account as Account);
        const cal = calendarClient({ version: 'v3', auth });
        const res = await cal.freebusy.query({
          requestBody: {
            timeMin,
            timeMax,
            timeZone: timeZone ?? 'UTC',
            items: calendarIds.map((id: string) => ({ id })),
          },
        });
        return {
          // freebusy answers 200 with NO `calendars` key on an empty items
          // list, and JSON.stringify(undefined) returns undefined, not a
          // string: the SDK then rejected our own result with -32602. The
          // value is a map keyed by calendar id, so the fallback is {}.
          content: [{ type: 'text' as const, text: JSON.stringify(res.data.calendars ?? {}, null, 2) }],
        };
      } catch (error: any) {
        return handleCalendarError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'calendar_create_calendar',
    {
      description: 'Create a new calendar under the account',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        summary: z.string().describe('Calendar name'),
        description: z.string().optional().describe('Calendar description'),
        timeZone: z.string().optional().describe('Timezone (default: UTC)'),
      },
    },
    async ({ account, summary, description, timeZone }) => {
      try {
        const auth = await getClientFn(account as Account);
        const cal = calendarClient({ version: 'v3', auth });
        const res = await cal.calendars.insert({
          requestBody: {
            summary,
            description,
            timeZone: timeZone ?? 'UTC',
          },
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        return handleCalendarError(error, account as Account);
      }
    },
  );
}

const LIST_DESCRIPTION_CAP = 300;
const TRUNCATION_MARKER = '… [truncated, use calendar_get_event]';

/** Google disagrees with itself on a backwards window: events.list answers 200
 * with [], which reads as "nothing scheduled", while freebusy.query 400s on the
 * identical input. Decide locally so an empty list always means empty. Returns
 * null when either bound is absent or unparseable: those stay Google's call.
 * Date.parse is lenient, so it is used only to SKIP the check, never to accept. */
export function timeRangeError(timeMin: string | undefined, timeMax: string | undefined): string | null {
  if (timeMin === undefined || timeMax === undefined) return null;
  const min = Date.parse(timeMin);
  const max = Date.parse(timeMax);
  if (Number.isNaN(min) || Number.isNaN(max)) return null;
  if (min < max) return null;
  return min === max
    ? `timeMin and timeMax are the same instant (${timeMin}), so the window contains nothing.`
    : `timeMin (${timeMin}) is after timeMax (${timeMax}).`;
}

export const TIME_RANGE_HINT =
  'Swap the two values or widen the window: timeMin must be strictly earlier than timeMax. ' +
  'An empty result from this tool then always means "nothing scheduled", never "bad range".';

export function formatEvent(event: any, opts: { full?: boolean } = {}) {
  const full = opts.full ?? true;
  const description: string = event.description ?? '';
  // Slack margin: truncating a 301-char description to 300 + 37-char marker would GROW it.
  const cappedDescription =
    full || description.length <= LIST_DESCRIPTION_CAP + TRUNCATION_MARKER.length
      ? description
      : `${sliceClean(description, LIST_DESCRIPTION_CAP)}${TRUNCATION_MARKER}`;
  const base = {
    id: event.id,
    summary: event.summary ?? '',
    description: cappedDescription,
    location: event.location ?? '',
    start: event.start?.dateTime ?? event.start?.date ?? '',
    end: event.end?.dateTime ?? event.end?.date ?? '',
    status: event.status,
    htmlLink: event.htmlLink,
    organizer: event.organizer?.email ?? '',
    attendees: (event.attendees ?? []).map((a: any) => ({
      email: a.email,
      responseStatus: a.responseStatus,
    })),
    recurringEventId: event.recurringEventId,
    hangoutLink: event.hangoutLink,
    created: full ? event.created : undefined,
    updated: full ? event.updated : undefined,
  };
  if (full) return base;
  return Object.fromEntries(
    Object.entries(base).filter(
      ([, v]) => v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0),
    ),
  );
}

function handleCalendarError(error: any, account: Account) {
  return handleGoogleApiError(error, account);
}
