import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { google } from 'googleapis';
import { ACCOUNTS } from '../accounts.js';
import type { Account } from '../accounts.js';
import { getClient } from '../client.js';

const accountEnum = z.enum(ACCOUNTS);

export function registerCalendarTools(server: McpServer): void {
  // calendar_list_calendars
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
        const auth = await getClient(account as Account);
        const cal = google.calendar({ version: 'v3', auth });

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

  // calendar_list_events
  server.registerTool(
    'calendar_list_events',
    {
      description: 'List events from a Google Calendar',
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
      },
    },
    async ({ account, calendarId, query, timeMin, timeMax, maxResults }) => {
      try {
        const auth = await getClient(account as Account);
        const cal = google.calendar({ version: 'v3', auth });

        const params: any = {
          calendarId: calendarId ?? 'primary',
          maxResults: maxResults ?? 25,
          singleEvents: true,
          orderBy: 'startTime',
        };

        if (query) params.q = query;
        if (timeMin) params.timeMin = timeMin;
        if (timeMax) params.timeMax = timeMax;

        // Default to upcoming events if no time range specified
        if (!timeMin && !timeMax) {
          params.timeMin = new Date().toISOString();
        }

        const res = await cal.events.list(params);
        const events = (res.data.items ?? []).map(formatEvent);

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(events, null, 2) }],
        };
      } catch (error: any) {
        return handleCalendarError(error, account as Account);
      }
    },
  );

  // calendar_get_event
  server.registerTool(
    'calendar_get_event',
    {
      description: 'Get a single Google Calendar event by ID',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        eventId: z.string().describe('Calendar event ID'),
        calendarId: z.string().default('primary').optional()
          .describe('Calendar ID (default: primary)'),
      },
    },
    async ({ account, eventId, calendarId }) => {
      try {
        const auth = await getClient(account as Account);
        const cal = google.calendar({ version: 'v3', auth });

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

  // calendar_create_event
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
        allDay: z.boolean().default(false).optional()
          .describe('If true, start/end are dates (YYYY-MM-DD) not datetimes'),
      },
    },
    async ({ account, summary, start, end, description, location, attendees, calendarId, allDay }) => {
      try {
        const auth = await getClient(account as Account);
        const cal = google.calendar({ version: 'v3', auth });

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

  // calendar_update_event
  server.registerTool(
    'calendar_update_event',
    {
      description: 'Update a Google Calendar event',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        eventId: z.string().describe('Calendar event ID'),
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
        const auth = await getClient(account as Account);
        const cal = google.calendar({ version: 'v3', auth });

        // Fetch existing event first to merge
        const existing = await cal.events.get({
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

  // calendar_delete_event
  server.registerTool(
    'calendar_delete_event',
    {
      description: 'Delete a Google Calendar event',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        eventId: z.string().describe('Calendar event ID'),
        calendarId: z.string().default('primary').optional()
          .describe('Calendar ID (default: primary)'),
      },
    },
    async ({ account, eventId, calendarId }) => {
      try {
        const auth = await getClient(account as Account);
        const cal = google.calendar({ version: 'v3', auth });

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
}

function formatEvent(event: any) {
  return {
    id: event.id,
    summary: event.summary ?? '',
    description: event.description ?? '',
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
    created: event.created,
    updated: event.updated,
  };
}

function handleCalendarError(error: any, account: Account) {
  if (error.code === 401) {
    return {
      content: [{
        type: 'text' as const,
        text: `Authentication error for account "${account}". Run: node dist/index.js auth --account ${account}`,
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
