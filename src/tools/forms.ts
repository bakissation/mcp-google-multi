import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { google } from 'googleapis';
import { ACCOUNTS } from '../accounts.js';
import type { Account } from '../accounts.js';
import { getClient } from '../client.js';
import { handleGoogleApiError } from './_errors.js';

const accountEnum = z.enum(ACCOUNTS);

export function registerFormsTools(server: McpServer): void {
  server.registerTool(
    'forms_get',
    {
      description: 'Get a Google Form (definition: questions, sections, settings). Requires forms.body scope.',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        formId: z.string().describe('Form ID'),
      },
    },
    async ({ account, formId }) => {
      try {
        const auth = await getClient(account as Account);
        const forms = google.forms({ version: 'v1', auth });
        const res = await forms.forms.get({ formId });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        return handleFormsError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'forms_responses_list',
    {
      description: 'List form responses. Requires forms.responses.readonly scope.',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        formId: z.string().describe('Form ID'),
        pageSize: z.number().min(1).max(1000).optional().describe('Default: 100; max 1000. Responses can be large.'),
        pageToken: z.string().optional(),
        filter: z.string().optional().describe('Filter expression (e.g. "timestamp > 2026-01-01T00:00:00Z")'),
      },
    },
    async ({ account, formId, pageSize, pageToken, filter }) => {
      try {
        const auth = await getClient(account as Account);
        const forms = google.forms({ version: 'v1', auth });
        const res = await forms.forms.responses.list({
          formId,
          pageSize: pageSize ?? 100,
          pageToken,
          filter,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        return handleFormsError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'forms_response_get',
    {
      description: 'Get a single form response by ID',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        formId: z.string().describe('Form ID'),
        responseId: z.string().describe('Response ID'),
      },
    },
    async ({ account, formId, responseId }) => {
      try {
        const auth = await getClient(account as Account);
        const forms = google.forms({ version: 'v1', auth });
        const res = await forms.forms.responses.get({ formId, responseId });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        return handleFormsError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'forms_watches_list',
    {
      description: 'List Pub/Sub watches on a form (notifications for new responses or schema changes)',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        formId: z.string().describe('Form ID'),
      },
    },
    async ({ account, formId }) => {
      try {
        const auth = await getClient(account as Account);
        const forms = google.forms({ version: 'v1', auth });
        const res = await forms.forms.watches.list({ formId });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        return handleFormsError(error, account as Account);
      }
    },
  );
}

function handleFormsError(error: any, account: Account) {
  return handleGoogleApiError(error, account, "Forms tools require the optional \"forms\" scope bundle. Add GOOGLE_OPTIONAL_SCOPES=forms (or include \"forms\" in the list) and re-auth.");
}
