import type { ToolRegistry } from '../registry.js';
import { z } from 'zod';
import { coerceJson } from './_coerce.js';
import { chat as chatClient } from '@googleapis/chat';
import { accountArgLive } from '../accounts.js';
import type { Account } from '../accounts.js';
import { getClient, type CuratedToolDeps } from '../client.js';
import { handleGoogleApiError, invalidParams } from './_errors.js';


export function registerChatTools(server: ToolRegistry, deps: CuratedToolDeps = {}): void {
  // Per-registry, LIVE account enum + injectable client (S1.10): the
  // schema follows the registry's account view at parse time, and the
  // custody path is the context's, not the process global.
  const accountEnum = accountArgLive(() => server.accountAliases()).optional();
  const getClientFn = deps.getClientFn ?? getClient;
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
        const auth = await getClientFn(account as Account);
        const chat = chatClient({ version: 'v1', auth });
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
        name: z.string().min(1).describe('Space resource name, format: spaces/{space}'),
      },
    },
    async ({ account, name }) => {
      try {
        const auth = await getClientFn(account as Account);
        const chat = chatClient({ version: 'v1', auth });
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
        cardsV2: coerceJson(z.array(z.record(z.string(), z.any()))).optional().describe('Optional Card v2 payloads'),
        threadKey: z.string().optional().describe('Thread key to group messages'),
        messageReplyOption: z.enum(['MESSAGE_REPLY_OPTION_UNSPECIFIED', 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD', 'REPLY_MESSAGE_OR_FAIL']).optional(),
      },
    },
    async ({ account, parent, text, cardsV2, threadKey, messageReplyOption }) => {
      try {
        if (!text && (!cardsV2 || cardsV2.length === 0)) {
          return invalidParams(
            account as Account,
            'A message needs content: neither text nor cardsV2 was supplied.',
            'Pass text for a plain message, or cardsV2 for a Card v2 payload. Both may be sent together.',
          );
        }
        const auth = await getClientFn(account as Account);
        const chat = chatClient({ version: 'v1', auth });
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
        const auth = await getClientFn(account as Account);
        const chat = chatClient({ version: 'v1', auth });
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
  return handleGoogleApiError(error, account, {
    scope: 'Chat tools require the optional "chat" scope bundle: add it to this account\'s scope profile, then re-auth.',
    resource: `Google Chat denied this space or message to "${account}". The scope is not the problem: check that the account is a member of the space, and that Chat is turned on for the Workspace.`,
  });
}
