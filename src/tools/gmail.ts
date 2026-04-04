import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { google } from 'googleapis';
import { ACCOUNTS } from '../accounts.js';
import type { Account } from '../accounts.js';
import { getClient } from '../client.js';
import type { GmailMessageHeader, GmailMessageFull } from '../types.js';

const accountEnum = z.enum(ACCOUNTS);

function getHeader(
  headers: { name?: string | null; value?: string | null }[] | undefined,
  name: string,
): string {
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '';
}

function decodeBody(
  payload: any,
): string {
  // Try direct body
  if (payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf-8');
  }

  // Recurse into parts — prefer text/plain
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return Buffer.from(part.body.data, 'base64url').toString('utf-8');
      }
    }
    // Fallback to text/html
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body?.data) {
        return Buffer.from(part.body.data, 'base64url').toString('utf-8');
      }
    }
    // Recurse into nested multipart
    for (const part of payload.parts) {
      if (part.parts) {
        const result = decodeBody(part);
        if (result) return result;
      }
    }
  }

  return '';
}

function getAttachmentNames(payload: any): string[] {
  const names: string[] = [];
  if (payload.filename && payload.body?.attachmentId) {
    names.push(payload.filename);
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      names.push(...getAttachmentNames(part));
    }
  }
  return names;
}

function parseMessage(msg: any): GmailMessageFull {
  const headers = msg.payload?.headers ?? [];
  return {
    id: msg.id ?? '',
    threadId: msg.threadId ?? '',
    subject: getHeader(headers, 'Subject'),
    from: getHeader(headers, 'From'),
    to: getHeader(headers, 'To'),
    cc: getHeader(headers, 'Cc'),
    date: getHeader(headers, 'Date'),
    body: decodeBody(msg.payload),
    attachments: getAttachmentNames(msg.payload),
  };
}

export function registerGmailTools(server: McpServer): void {
  // 9.1 gmail_search
  server.registerTool(
    'gmail_search',
    {
      description: 'Search messages in a Gmail account',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        query: z.string().describe('Gmail search syntax, e.g. "from:monaam is:unread"'),
        maxResults: z.number().min(1).max(100).default(20).optional()
          .describe('Max results to return (default: 20, max: 100)'),
      },
    },
    async ({ account, query, maxResults }) => {
      try {
        const auth = await getClient(account as Account);
        const gmail = google.gmail({ version: 'v1', auth });

        const listRes = await gmail.users.messages.list({
          userId: 'me',
          q: query,
          maxResults: maxResults ?? 20,
        });

        const messages = listRes.data.messages ?? [];
        const results: GmailMessageHeader[] = [];

        for (const m of messages) {
          const detail = await gmail.users.messages.get({
            userId: 'me',
            id: m.id!,
            format: 'metadata',
            metadataHeaders: ['From', 'Subject', 'Date'],
          });
          results.push({
            id: detail.data.id ?? '',
            threadId: detail.data.threadId ?? '',
            subject: getHeader(detail.data.payload?.headers, 'Subject'),
            from: getHeader(detail.data.payload?.headers, 'From'),
            date: getHeader(detail.data.payload?.headers, 'Date'),
            snippet: detail.data.snippet ?? '',
          });
        }

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }],
        };
      } catch (error: any) {
        return handleGmailError(error, account as Account);
      }
    },
  );

  // 9.2 gmail_read
  server.registerTool(
    'gmail_read',
    {
      description: 'Read a full Gmail message by ID',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        messageId: z.string().describe('Gmail message ID'),
      },
    },
    async ({ account, messageId }) => {
      try {
        const auth = await getClient(account as Account);
        const gmail = google.gmail({ version: 'v1', auth });

        const res = await gmail.users.messages.get({
          userId: 'me',
          id: messageId,
          format: 'full',
        });

        const result = parseMessage(res.data);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error: any) {
        return handleGmailError(error, account as Account);
      }
    },
  );

  // 9.3 gmail_read_thread
  server.registerTool(
    'gmail_read_thread',
    {
      description: 'Read all messages in a Gmail thread',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        threadId: z.string().describe('Gmail thread ID'),
      },
    },
    async ({ account, threadId }) => {
      try {
        const auth = await getClient(account as Account);
        const gmail = google.gmail({ version: 'v1', auth });

        const res = await gmail.users.threads.get({
          userId: 'me',
          id: threadId,
          format: 'full',
        });

        const messages = (res.data.messages ?? []).map(parseMessage);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(messages, null, 2) }],
        };
      } catch (error: any) {
        return handleGmailError(error, account as Account);
      }
    },
  );

  // 9.4 gmail_send
  server.registerTool(
    'gmail_send',
    {
      description: 'Send an email from a Gmail account',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        to: z.string().describe('Recipient(s), comma-separated'),
        subject: z.string().describe('Email subject'),
        body: z.string().describe('Plain text body'),
        cc: z.string().optional().describe('CC recipients, comma-separated'),
        replyToMessageId: z.string().optional()
          .describe('Message ID to reply to (sets In-Reply-To and References headers)'),
        replyToThreadId: z.string().optional()
          .describe('Thread ID to send the message in'),
      },
    },
    async ({ account, to, subject, body, cc, replyToMessageId, replyToThreadId }) => {
      try {
        const auth = await getClient(account as Account);
        const gmail = google.gmail({ version: 'v1', auth });
        const config = (await import('../accounts.js')).ACCOUNT_CONFIG[account as Account];

        const headers = [
          `From: ${config.email}`,
          `To: ${to}`,
          `Subject: ${subject}`,
          'MIME-Version: 1.0',
          'Content-Type: text/plain; charset="UTF-8"',
        ];

        if (cc) headers.push(`Cc: ${cc}`);
        if (replyToMessageId) {
          headers.push(`In-Reply-To: ${replyToMessageId}`);
          headers.push(`References: ${replyToMessageId}`);
        }

        const rawMessage = [...headers, '', body].join('\r\n');
        const encoded = Buffer.from(rawMessage).toString('base64url');

        const sendParams: any = {
          userId: 'me',
          requestBody: { raw: encoded },
        };

        if (replyToThreadId) {
          sendParams.requestBody.threadId = replyToThreadId;
        }

        const res = await gmail.users.messages.send(sendParams);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ id: res.data.id, threadId: res.data.threadId }, null, 2),
          }],
        };
      } catch (error: any) {
        return handleGmailError(error, account as Account);
      }
    },
  );

  // 9.5 gmail_create_draft
  server.registerTool(
    'gmail_create_draft',
    {
      description: 'Create a Gmail draft without sending',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        to: z.string().describe('Recipient(s), comma-separated'),
        subject: z.string().describe('Email subject'),
        body: z.string().describe('Plain text body'),
        cc: z.string().optional().describe('CC recipients, comma-separated'),
        replyToThreadId: z.string().optional()
          .describe('Thread ID to associate the draft with'),
      },
    },
    async ({ account, to, subject, body, cc, replyToThreadId }) => {
      try {
        const auth = await getClient(account as Account);
        const gmail = google.gmail({ version: 'v1', auth });
        const config = (await import('../accounts.js')).ACCOUNT_CONFIG[account as Account];

        const headers = [
          `From: ${config.email}`,
          `To: ${to}`,
          `Subject: ${subject}`,
          'MIME-Version: 1.0',
          'Content-Type: text/plain; charset="UTF-8"',
        ];

        if (cc) headers.push(`Cc: ${cc}`);

        const rawMessage = [...headers, '', body].join('\r\n');
        const encoded = Buffer.from(rawMessage).toString('base64url');

        const draftParams: any = {
          userId: 'me',
          requestBody: {
            message: { raw: encoded },
          },
        };

        if (replyToThreadId) {
          draftParams.requestBody.message.threadId = replyToThreadId;
        }

        const res = await gmail.users.drafts.create(draftParams);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(
              { draftId: res.data.id, threadId: res.data.message?.threadId },
              null,
              2,
            ),
          }],
        };
      } catch (error: any) {
        return handleGmailError(error, account as Account);
      }
    },
  );
}

function handleGmailError(error: any, account: Account) {
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
