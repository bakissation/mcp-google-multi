import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { google } from 'googleapis';
import { ACCOUNTS } from '../accounts.js';
import type { Account } from '../accounts.js';
import { getClient } from '../client.js';
import { handleGoogleApiError } from './_errors.js';

const accountEnum = z.enum(ACCOUNTS);

export function registerChatTools(server: McpServer): void {
  server.registerTool(
    'chat_spaces_list',
    {
      description: 'List Google Chat spaces the user is a member of',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        pageSize: z.number().min(1).max(1000).optional(),
        pageToken: z.string().optional(),
        filter: z.string().optional().describe('Filter expression, e.g. "spaceType = \\"DIRECT_MESSAGE\\""'),
      },
    },
    async ({ account, pageSize, pageToken, filter }) => {
      try {
        const auth = await getClient(account as Account);
        const chat = google.chat({ version: 'v1', auth });
        const res = await chat.spaces.list({
          pageSize: pageSize ?? 100,
          pageToken,
          filter,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        return handleChatError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'chat_spaces_get',
    {
      description: 'Get details about a single Chat space',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        name: z.string().describe('Space resource name, format: spaces/{space}'),
      },
    },
    async ({ account, name }) => {
      try {
        const auth = await getClient(account as Account);
        const chat = google.chat({ version: 'v1', auth });
        const res = await chat.spaces.get({ name });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        return handleChatError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'chat_messages_create',
    {
      description: 'Send a message into a Chat space. Supply plain text or a Card v2 in cardsV2.',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        parent: z.string().describe('Space resource name, format: spaces/{space}'),
        text: z.string().optional().describe('Plain message text'),
        cardsV2: z.array(z.record(z.string(), z.any())).optional().describe('Optional Card v2 payloads'),
        threadKey: z.string().optional().describe('Thread key to group messages'),
        messageReplyOption: z.enum(['MESSAGE_REPLY_OPTION_UNSPECIFIED', 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD', 'REPLY_MESSAGE_OR_FAIL']).optional(),
      },
    },
    async ({ account, parent, text, cardsV2, threadKey, messageReplyOption }) => {
      try {
        if (!text && (!cardsV2 || cardsV2.length === 0)) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Either text or cardsV2 must be provided' }) }], isError: true };
        }
        const auth = await getClient(account as Account);
        const chat = google.chat({ version: 'v1', auth });
        const requestBody: any = {};
        if (text) requestBody.text = text;
        if (cardsV2) requestBody.cardsV2 = cardsV2;
        if (threadKey) requestBody.thread = { threadKey };

        const res = await chat.spaces.messages.create({
          parent,
          messageReplyOption,
          requestBody,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        return handleChatError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'chat_messages_list',
    {
      description: 'List messages in a Chat space',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        parent: z.string().describe('Space resource name, format: spaces/{space}'),
        pageSize: z.number().min(1).max(1000).optional(),
        pageToken: z.string().optional(),
        filter: z.string().optional().describe('Filter expression, e.g. "createTime > \\"2026-01-01T00:00:00Z\\""'),
        orderBy: z.string().optional().describe('e.g. "createTime DESC"'),
      },
    },
    async ({ account, parent, pageSize, pageToken, filter, orderBy }) => {
      try {
        const auth = await getClient(account as Account);
        const chat = google.chat({ version: 'v1', auth });
        const res = await chat.spaces.messages.list({
          parent,
          pageSize: pageSize ?? 100,
          pageToken,
          filter,
          orderBy,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        return handleChatError(error, account as Account);
      }
    },
  );
}

function handleChatError(error: any, account: Account) {
  return handleGoogleApiError(error, account, "Chat tools require the optional \"chat\" scope bundle. Add GOOGLE_OPTIONAL_SCOPES=chat and re-auth.");
}
