import type { ToolRegistry } from '../registry.js';
import { z } from 'zod';
import { coerceJson } from './_coerce.js';
import { chat as chatClient } from '@googleapis/chat';
import { accountArgLive } from '../accounts.js';
import type { Account } from '../accounts.js';
import { getClient, type CuratedToolDeps } from '../client.js';
import { handleGoogleApiError, invalidParams } from './_errors.js';


export function registerChatTools(server: ToolRegistry, deps: CuratedToolDeps = {}): void {
  // Per-registry, live account enum + injectable client: the schema follows
  // the registry's account view at parse time, not a process-global default.
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

  server.registerTool(
    'chat_messages_search',
    {
      annotations: { readOnlyHint: true, openWorldHint: true },
      description:
        'Find Chat messages whose text contains a phrase. Google Chat has no search endpoint, so this reads recent messages ' +
        'newest first and matches the text here (case-insensitive). It scans one space (space) or the first spaces Google lists for the account, ' +
        'only messages newer than since (default: the last 30 days), and stops at maxMessagesPerSpace per space. ' +
        'The result says how many spaces and messages were scanned and whether a cap stopped the search, so "no matches" is never a claim about older messages. ' +
        'To go further back, pass an earlier since or a larger maxMessagesPerSpace.',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        query: z.string().min(1).describe('Text to look for (case-insensitive substring)'),
        space: z.string().optional().describe('Limit the search to one space, format: spaces/{space}'),
        since: z.string().optional().describe('Only messages created after this RFC 3339 time, e.g. 2026-10-01T00:00:00Z (default: 30 days ago)'),
        maxSpaces: z.number().int().min(1).max(25).optional().describe('How many spaces to scan when space is not given (1-25, default 10)'),
        maxMessagesPerSpace: z.number().int().min(1).max(1000).optional().describe('Newest messages to read per space (1-1000, default 200)'),
        limit: z.number().int().min(1).max(100).optional().describe('Stop after this many matches (1-100, default 20)'),
      },
    },
    async ({ account, query, space, since, maxSpaces, maxMessagesPerSpace, limit }) => {
      try {
        const needle = query.trim().toLowerCase();
        if (!needle) return invalidParams(account as Account, 'query is empty.', 'Pass the text to look for.');
        if (space !== undefined && !/^spaces\/[^/\s]+$/.test(space)) {
          return invalidParams(account as Account, `space "${space}" is not a space resource name.`, 'Use the form spaces/{space}, as returned by chat_spaces_list.');
        }
        let sinceIso: string;
        if (since === undefined) {
          sinceIso = new Date(Date.now() - 30 * 86_400_000).toISOString();
        } else {
          const t = Date.parse(since);
          if (!/^\d{4}-\d{2}-\d{2}T/.test(since) || Number.isNaN(t)) {
            return invalidParams(account as Account, `since "${since}" is not an RFC 3339 time.`, 'Use a date-time such as 2026-10-01T00:00:00Z.');
          }
          sinceIso = new Date(t).toISOString();
        }
        const perSpaceCap = maxMessagesPerSpace ?? 200;
        const matchCap = limit ?? 20;

        const auth = await getClientFn(account as Account);
        const chat = chatClient({ version: 'v1', auth });

        let spaces: Array<{ name: string; displayName?: string }>;
        let moreSpaces = false;
        if (space) {
          spaces = [{ name: space }];
        } else {
          const wanted = maxSpaces ?? 10;
          const res = await chat.spaces.list({ pageSize: Math.min(wanted, 1000) });
          const all = res.data.spaces ?? [];
          spaces = all.slice(0, wanted).map((s) => ({ name: s.name ?? '', displayName: s.displayName ?? undefined })).filter((s) => s.name);
          moreSpaces = all.length > wanted || Boolean(res.data.nextPageToken);
        }

        const matches: Array<Record<string, unknown>> = [];
        const skipped: Array<{ space: string; reason: string }> = [];
        let scanned = 0;
        let cappedSpaces = 0;
        let lastError: unknown;
        let spacesRead = 0;

        for (const sp of spaces) {
          if (matches.length >= matchCap) break;
          let seen = 0;
          let pageToken: string | undefined;
          try {
            do {
              const res = await chat.spaces.messages.list({
                parent: sp.name,
                pageSize: Math.min(100, perSpaceCap - seen),
                pageToken,
                filter: `createTime > "${sinceIso}"`,
                orderBy: 'createTime DESC',
              });
              const batch = res.data.messages ?? [];
              for (const m of batch) {
                seen++;
                const text = m.text ?? m.formattedText ?? '';
                if (text.toLowerCase().includes(needle)) {
                  matches.push({
                    space: sp.name,
                    ...(sp.displayName ? { spaceName: sp.displayName } : {}),
                    message: m.name,
                    createTime: m.createTime,
                    sender: m.sender?.displayName ?? m.sender?.name,
                    ...(m.thread?.name ? { thread: m.thread.name } : {}),
                    text: text.length > 300 ? `${text.slice(0, 300)}...` : text,
                  });
                  if (matches.length >= matchCap) break;
                }
              }
              pageToken = res.data.nextPageToken ?? undefined;
              if (matches.length >= matchCap) break;
              if (pageToken && seen >= perSpaceCap) {
                cappedSpaces++;
                break;
              }
            } while (pageToken);
            spacesRead++;
          } catch (error: any) {
            if (space) throw error;
            lastError = error;
            skipped.push({ space: sp.name, reason: error?.message ? String(error.message).slice(0, 160) : 'request failed' });
          }
          scanned += seen;
        }

        if (!space && spaces.length > 0 && spacesRead === 0) throw lastError;

        const stoppedEarly = matches.length >= matchCap;
        const partial = stoppedEarly || cappedSpaces > 0 || moreSpaces || skipped.length > 0;
        const notes: string[] = [];
        if (stoppedEarly) notes.push(`Stopped at ${matchCap} matches; raise limit for more.`);
        if (cappedSpaces > 0) notes.push(`${cappedSpaces} space(s) have older messages in range that were not read; raise maxMessagesPerSpace.`);
        if (moreSpaces) notes.push('More spaces exist than were scanned; raise maxSpaces or pass space.');
        if (skipped.length > 0) notes.push(`${skipped.length} space(s) could not be read (see skipped).`);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            matches,
            returned: matches.length,
            truncated: partial,
            scanned: { spaces: spacesRead, messages: scanned, since: sinceIso },
            ...(skipped.length > 0 ? { skipped } : {}),
            ...(partial ? { hint: notes.join(' ') } : {}),
          }, null, 2) }],
        };
      } catch (error: any) {
        return handleChatError(error, account as Account);
      }
    },
  );
}

export function handleChatError(error: any, account: Account) {
  return handleGoogleApiError(error, account, {
    scope: 'Chat tools require the optional "chat" scope bundle: add it to this account\'s scope profile, then re-auth.',
    resource: `Google Chat denied this space or message to "${account}". The scope is not the problem: check that the account is a member of the space, and that Chat is turned on for the Workspace.`,
    bundle: 'chat',
  });
}
