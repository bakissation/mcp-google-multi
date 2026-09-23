import type { ToolRegistry } from '../registry.js';
import { z } from 'zod';
import { meet as meetClient } from '@googleapis/meet';
import { accountArgLive } from '../accounts.js';
import type { Account } from '../accounts.js';
import { getClient, type CuratedToolDeps } from '../client.js';
import { handleGoogleApiError } from './_errors.js';


export function registerMeetTools(server: ToolRegistry, deps: CuratedToolDeps = {}): void {
  // Per-registry, LIVE account enum + injectable client (S1.10): the
  // schema follows the registry's account view at parse time, and the
  // custody path is the context's, not the process global.
  const accountEnum = accountArgLive(() => server.accountAliases()).optional();
  const getClientFn = deps.getClientFn ?? getClient;
  // ─── Conference records (past meetings) ────────────────────────────────

  server.registerTool(
    'meet_conference_records_list',
    {
      description: 'List past conference records (completed Meet sessions) the user has access to',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        pageSize: z.number().min(1).max(100).optional(),
        pageToken: z.string().optional(),
        filter: z.string().optional().describe('Filter expression, e.g. "space.meeting_code=abc-defg-hij"'),
      },
    },
    async ({ account, pageSize, pageToken, filter }) => {
      try {
        const auth = await getClientFn(account as Account);
        const meet = meetClient({ version: 'v2', auth });
        const res = await meet.conferenceRecords.list({
          pageSize: pageSize ?? 20,
          pageToken,
          filter,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        return handleMeetError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'meet_conference_record_get',
    {
      description: 'Get a single conference record by resource name (e.g. conferenceRecords/abc123)',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        name: z.string().min(1).describe('Resource name, format: conferenceRecords/{conference_record}'),
      },
    },
    async ({ account, name }) => {
      try {
        const auth = await getClientFn(account as Account);
        const meet = meetClient({ version: 'v2', auth });
        const res = await meet.conferenceRecords.get({ name });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        return handleMeetError(error, account as Account);
      }
    },
  );

  // ─── Recordings ────────────────────────────────────────────────────────

  server.registerTool(
    'meet_recordings_list',
    {
      description: 'List recordings within a conference record. Returns Drive file IDs that can be downloaded via drive_download.',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        parent: z.string().describe('Parent conference record, format: conferenceRecords/{id}'),
        pageSize: z.number().min(1).max(100).optional(),
        pageToken: z.string().optional(),
      },
    },
    async ({ account, parent, pageSize, pageToken }) => {
      try {
        const auth = await getClientFn(account as Account);
        const meet = meetClient({ version: 'v2', auth });
        const res = await meet.conferenceRecords.recordings.list({
          parent,
          pageSize: pageSize ?? 20,
          pageToken,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        return handleMeetError(error, account as Account);
      }
    },
  );

  // ─── Transcripts ───────────────────────────────────────────────────────

  server.registerTool(
    'meet_transcripts_list',
    {
      description: 'List transcripts within a conference record',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        parent: z.string().describe('Parent conference record, format: conferenceRecords/{id}'),
        pageSize: z.number().min(1).max(100).optional(),
        pageToken: z.string().optional(),
      },
    },
    async ({ account, parent, pageSize, pageToken }) => {
      try {
        const auth = await getClientFn(account as Account);
        const meet = meetClient({ version: 'v2', auth });
        const res = await meet.conferenceRecords.transcripts.list({
          parent,
          pageSize: pageSize ?? 20,
          pageToken,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        return handleMeetError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'meet_transcript_entries_list',
    {
      description: 'List entries (per-speaker text segments) within a transcript. The actual transcript content.',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        parent: z.string().describe('Parent transcript, format: conferenceRecords/{id}/transcripts/{id}'),
        pageSize: z.number().min(1).max(1000).optional(),
        pageToken: z.string().optional(),
      },
    },
    async ({ account, parent, pageSize, pageToken }) => {
      try {
        const auth = await getClientFn(account as Account);
        const meet = meetClient({ version: 'v2', auth });
        const res = await meet.conferenceRecords.transcripts.entries.list({
          parent,
          pageSize: pageSize ?? 200,
          pageToken,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        return handleMeetError(error, account as Account);
      }
    },
  );
}

function handleMeetError(error: any, account: Account) {
  return handleGoogleApiError(error, account, {
    scope: 'Meet needs the meetings.space.readonly scope and the Google Meet API enabled in Cloud Console. Confirm both for this account.',
    resource: `Meet denied this conference record to "${account}". Meet exposes records only to the organizer or a participant, so check which account hosted the meeting.`,
  });
}
