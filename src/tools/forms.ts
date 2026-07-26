import type { ToolRegistry } from '../registry.js';
import { z } from 'zod';
import { google } from 'googleapis';
import { ACCOUNTS } from '../accounts.js';
import type { Account } from '../accounts.js';
import { getClient } from '../client.js';
import { handleGoogleApiError } from './_errors.js';
import { coerceArray, coerceBoolean, coerceJson } from './_coerce.js';

const accountEnum = z.enum(ACCOUNTS);

export function registerFormsTools(server: ToolRegistry): void {
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

  server.registerTool(
    'forms_create',
    {
      description: 'Create a new Google Form with a title (add questions with forms_batch_update)',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        title: z.string().describe('Form title shown to responders'),
        documentTitle: z.string().optional().describe('Drive file name (default: the title)'),
      },
    },
    async ({ account, title, documentTitle }) => {
      try {
        const auth = await getClient(account as Account);
        const forms = google.forms({ version: 'v1', auth });
        const res = await forms.forms.create({
          requestBody: { info: { title, documentTitle } },
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            formId: res.data.formId,
            title: res.data.info?.title,
            responderUri: res.data.responderUri,
            revisionId: res.data.revisionId,
          }, null, 2) }],
        };
      } catch (error: any) {
        return handleFormsError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'forms_batch_update',
    {
      description: 'Generic forms.batchUpdate pass-through: add/edit/delete questions, update form info and settings. See https://developers.google.com/workspace/forms/api/reference/rest/v1/forms/request',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        formId: z.string().describe('Form ID'),
        requests: coerceArray(coerceJson(z.record(z.string(), z.unknown())))
          .describe('Array of Request objects, each with one request-type key like {createItem: {...}}'),
        includeFormInResponse: coerceBoolean.optional().describe('Return the updated form in the response'),
        writeControl: coerceJson(z.object({
          requiredRevisionId: z.string().optional(),
          targetRevisionId: z.string().optional(),
        }).optional()).describe('Optional optimistic concurrency control'),
      },
    },
    async ({ account, formId, requests, includeFormInResponse, writeControl }) => {
      try {
        const auth = await getClient(account as Account);
        const forms = google.forms({ version: 'v1', auth });
        const res = await forms.forms.batchUpdate({
          formId,
          requestBody: {
            requests: requests as any,
            includeFormInResponse,
            writeControl,
          },
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
    'forms_set_publish_settings',
    {
      description: 'Publish/unpublish a form and toggle whether it accepts responses (legacy forms without publish state are not supported)',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        formId: z.string().describe('Form ID'),
        isPublished: coerceBoolean.describe('Form is published and reachable by responders'),
        isAcceptingResponses: coerceBoolean.optional().describe('Form accepts responses (requires published; default: follows isPublished)'),
      },
    },
    async ({ account, formId, isPublished, isAcceptingResponses }) => {
      try {
        const auth = await getClient(account as Account);
        const forms = google.forms({ version: 'v1', auth });
        const updateMask = ['publishState.isPublished'];
        if (isAcceptingResponses !== undefined) updateMask.push('publishState.isAcceptingResponses');
        const res = await forms.forms.setPublishSettings({
          formId,
          requestBody: {
            publishSettings: {
              publishState: { isPublished, isAcceptingResponses },
            },
            updateMask: updateMask.join(','),
          },
        });
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
