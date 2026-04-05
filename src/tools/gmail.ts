import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { google } from 'googleapis';
import { ACCOUNTS } from '../accounts.js';
import type { Account } from '../accounts.js';
import { getClient } from '../client.js';
import type { GmailMessageHeader, GmailMessageFull, GmailAttachment } from '../types.js';
import * as path from 'path';
import * as fs from 'fs';

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

function getAttachments(payload: any): GmailAttachment[] {
  const attachments: GmailAttachment[] = [];
  if (payload.filename && payload.body?.attachmentId) {
    attachments.push({
      filename: payload.filename,
      attachmentId: payload.body.attachmentId,
      mimeType: payload.mimeType ?? 'application/octet-stream',
    });
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      attachments.push(...getAttachments(part));
    }
  }
  return attachments;
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
    attachments: getAttachments(msg.payload),
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

  // 9.5 gmail_download_attachment
  server.registerTool(
    'gmail_download_attachment',
    {
      description: 'Download an email attachment to local disk. Use gmail_read first to get the attachmentId.',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        messageId: z.string().describe('The Gmail message ID'),
        attachmentId: z.string().describe('The attachment ID from gmail_read response'),
        filename: z.string().describe('Filename to save as (e.g. report.xlsx)'),
        savePath: z.string().describe('Absolute directory path to save into, e.g. /home/user/Downloads'),
      },
    },
    async ({ account, messageId, attachmentId, filename, savePath }) => {
      try {
        const auth = await getClient(account as Account);
        const gmail = google.gmail({ version: 'v1', auth });

        const res = await gmail.users.messages.attachments.get({
          userId: 'me',
          messageId,
          id: attachmentId,
        });

        const data = res.data.data;
        if (!data) throw new Error('No attachment data returned');

        const buffer = Buffer.from(data, 'base64url');
        const fullPath = path.join(savePath, filename);
        await fs.promises.writeFile(fullPath, buffer);

        return {
          content: [{ type: 'text' as const, text: `Saved to ${fullPath} (${buffer.length} bytes)` }],
        };
      } catch (error: any) {
        return handleGmailError(error, account as Account);
      }
    },
  );

  // 9.6 gmail_create_draft
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

  // --- New tools below ---

  // gmail_modify_labels
  server.registerTool(
    'gmail_modify_labels',
    {
      description: 'Add or remove labels on a Gmail message. Use system label IDs like STARRED, UNREAD, INBOX, TRASH, or custom label IDs from gmail_list_labels.',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        messageId: z.string().describe('Gmail message ID'),
        addLabelIds: z.array(z.string()).optional().describe('Label IDs to add'),
        removeLabelIds: z.array(z.string()).optional().describe('Label IDs to remove'),
      },
    },
    async ({ account, messageId, addLabelIds, removeLabelIds }) => {
      try {
        const auth = await getClient(account as Account);
        const gmail = google.gmail({ version: 'v1', auth });
        const res = await gmail.users.messages.modify({
          userId: 'me',
          id: messageId,
          requestBody: {
            addLabelIds: addLabelIds ?? [],
            removeLabelIds: removeLabelIds ?? [],
          },
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        return handleGmailError(error, account as Account);
      }
    },
  );

  // gmail_trash
  server.registerTool(
    'gmail_trash',
    {
      description: 'Move a Gmail message to Trash (recoverable)',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        messageId: z.string().describe('Gmail message ID'),
      },
    },
    async ({ account, messageId }) => {
      try {
        const auth = await getClient(account as Account);
        const gmail = google.gmail({ version: 'v1', auth });
        const res = await gmail.users.messages.trash({ userId: 'me', id: messageId });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        return handleGmailError(error, account as Account);
      }
    },
  );

  // gmail_delete
  server.registerTool(
    'gmail_delete',
    {
      description: 'Permanently and irreversibly delete a Gmail message. No recovery possible.',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        messageId: z.string().describe('Gmail message ID'),
      },
    },
    async ({ account, messageId }) => {
      try {
        const auth = await getClient(account as Account);
        const gmail = google.gmail({ version: 'v1', auth });
        await gmail.users.messages.delete({ userId: 'me', id: messageId });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ deleted: true, messageId }, null, 2) }],
        };
      } catch (error: any) {
        return handleGmailError(error, account as Account);
      }
    },
  );

  // gmail_batch_modify
  server.registerTool(
    'gmail_batch_modify',
    {
      description: 'Add/remove labels across up to 1000 Gmail messages at once. Useful for bulk archiving, marking as read, etc.',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        messageIds: z.array(z.string()).describe('Message IDs (up to 1000)'),
        addLabelIds: z.array(z.string()).optional().describe('Label IDs to add'),
        removeLabelIds: z.array(z.string()).optional().describe('Label IDs to remove'),
      },
    },
    async ({ account, messageIds, addLabelIds, removeLabelIds }) => {
      try {
        const auth = await getClient(account as Account);
        const gmail = google.gmail({ version: 'v1', auth });
        await gmail.users.messages.batchModify({
          userId: 'me',
          requestBody: {
            ids: messageIds,
            addLabelIds: addLabelIds ?? [],
            removeLabelIds: removeLabelIds ?? [],
          },
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ modified: messageIds.length }, null, 2) }],
        };
      } catch (error: any) {
        return handleGmailError(error, account as Account);
      }
    },
  );

  // gmail_batch_delete
  server.registerTool(
    'gmail_batch_delete',
    {
      description: 'Permanently delete multiple Gmail messages. Irreversible.',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        messageIds: z.array(z.string()).describe('Message IDs (up to 1000)'),
      },
    },
    async ({ account, messageIds }) => {
      try {
        const auth = await getClient(account as Account);
        const gmail = google.gmail({ version: 'v1', auth });
        await gmail.users.messages.batchDelete({
          userId: 'me',
          requestBody: { ids: messageIds },
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ deleted: messageIds.length }, null, 2) }],
        };
      } catch (error: any) {
        return handleGmailError(error, account as Account);
      }
    },
  );

  // gmail_list_drafts
  server.registerTool(
    'gmail_list_drafts',
    {
      description: 'List all drafts in a Gmail mailbox',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        maxResults: z.number().min(1).max(100).default(20).optional()
          .describe('Max results to return (default: 20)'),
        query: z.string().optional().describe('Gmail search syntax to filter drafts'),
      },
    },
    async ({ account, maxResults, query }) => {
      try {
        const auth = await getClient(account as Account);
        const gmail = google.gmail({ version: 'v1', auth });
        const res = await gmail.users.drafts.list({
          userId: 'me',
          maxResults: maxResults ?? 20,
          q: query,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data.drafts ?? [], null, 2) }],
        };
      } catch (error: any) {
        return handleGmailError(error, account as Account);
      }
    },
  );

  // gmail_get_draft
  server.registerTool(
    'gmail_get_draft',
    {
      description: 'Read the full content of a specific Gmail draft',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        draftId: z.string().describe('Draft ID'),
      },
    },
    async ({ account, draftId }) => {
      try {
        const auth = await getClient(account as Account);
        const gmail = google.gmail({ version: 'v1', auth });
        const res = await gmail.users.drafts.get({
          userId: 'me',
          id: draftId,
          format: 'full',
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        return handleGmailError(error, account as Account);
      }
    },
  );

  // gmail_send_draft
  server.registerTool(
    'gmail_send_draft',
    {
      description: 'Send an existing Gmail draft by its draft ID',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        draftId: z.string().describe('Draft ID to send'),
      },
    },
    async ({ account, draftId }) => {
      try {
        const auth = await getClient(account as Account);
        const gmail = google.gmail({ version: 'v1', auth });
        const res = await gmail.users.drafts.send({
          userId: 'me',
          requestBody: { id: draftId },
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        return handleGmailError(error, account as Account);
      }
    },
  );

  // gmail_list_labels
  server.registerTool(
    'gmail_list_labels',
    {
      description: 'List all Gmail labels (system and user-defined). Use to get label IDs for gmail_modify_labels.',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
      },
    },
    async ({ account }) => {
      try {
        const auth = await getClient(account as Account);
        const gmail = google.gmail({ version: 'v1', auth });
        const res = await gmail.users.labels.list({ userId: 'me' });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data.labels ?? [], null, 2) }],
        };
      } catch (error: any) {
        return handleGmailError(error, account as Account);
      }
    },
  );

  // gmail_create_label
  server.registerTool(
    'gmail_create_label',
    {
      description: 'Create a new custom Gmail label',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        name: z.string().describe('Label name, e.g. "Ideacrafters/ComptaLegal"'),
        messageListVisibility: z.enum(['show', 'hide']).optional()
          .describe('Whether messages with this label show in message list (default: show)'),
        labelListVisibility: z.enum(['labelShow', 'labelShowIfUnread', 'labelHide']).optional()
          .describe('Whether the label appears in the label list (default: labelShow)'),
      },
    },
    async ({ account, name, messageListVisibility, labelListVisibility }) => {
      try {
        const auth = await getClient(account as Account);
        const gmail = google.gmail({ version: 'v1', auth });
        const res = await gmail.users.labels.create({
          userId: 'me',
          requestBody: {
            name,
            messageListVisibility: messageListVisibility ?? 'show',
            labelListVisibility: labelListVisibility ?? 'labelShow',
          },
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        return handleGmailError(error, account as Account);
      }
    },
  );

  // gmail_delete_label
  server.registerTool(
    'gmail_delete_label',
    {
      description: 'Permanently delete a Gmail label and remove it from all messages',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        labelId: z.string().describe('Label ID to delete'),
      },
    },
    async ({ account, labelId }) => {
      try {
        const auth = await getClient(account as Account);
        const gmail = google.gmail({ version: 'v1', auth });
        await gmail.users.labels.delete({ userId: 'me', id: labelId });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ deleted: true, labelId }, null, 2) }],
        };
      } catch (error: any) {
        return handleGmailError(error, account as Account);
      }
    },
  );

  // gmail_get_profile
  server.registerTool(
    'gmail_get_profile',
    {
      description: 'Get Gmail account profile: email address, total messages, total threads, and current history ID',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
      },
    },
    async ({ account }) => {
      try {
        const auth = await getClient(account as Account);
        const gmail = google.gmail({ version: 'v1', auth });
        const res = await gmail.users.getProfile({ userId: 'me' });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        return handleGmailError(error, account as Account);
      }
    },
  );

  // gmail_list_history
  server.registerTool(
    'gmail_list_history',
    {
      description: 'Get all mailbox changes since a given historyId. Useful for detecting new emails since last check.',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        startHistoryId: z.string().describe('History ID from a previous gmail_get_profile or gmail_read response'),
        maxResults: z.number().min(1).max(500).default(100).optional()
          .describe('Max results to return (default: 100)'),
        historyTypes: z.array(z.enum(['messageAdded', 'messageDeleted', 'labelAdded', 'labelRemoved'])).optional()
          .describe('Filter by history event types'),
      },
    },
    async ({ account, startHistoryId, maxResults, historyTypes }) => {
      try {
        const auth = await getClient(account as Account);
        const gmail = google.gmail({ version: 'v1', auth });
        const res = await gmail.users.history.list({
          userId: 'me',
          startHistoryId,
          maxResults: maxResults ?? 100,
          historyTypes: historyTypes as any,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        return handleGmailError(error, account as Account);
      }
    },
  );

  // gmail_get_vacation
  server.registerTool(
    'gmail_get_vacation',
    {
      description: 'Read current Gmail vacation responder settings',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
      },
    },
    async ({ account }) => {
      try {
        const auth = await getClient(account as Account);
        const gmail = google.gmail({ version: 'v1', auth });
        const res = await gmail.users.settings.getVacation({ userId: 'me' });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        return handleGmailError(error, account as Account);
      }
    },
  );

  // gmail_set_vacation
  server.registerTool(
    'gmail_set_vacation',
    {
      description: 'Enable or disable Gmail vacation responder with a custom message',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        enableAutoReply: z.boolean().describe('Whether to enable the vacation responder'),
        responseSubject: z.string().optional().describe('Subject line for auto-reply'),
        responseBodyPlainText: z.string().optional().describe('Plain text body for auto-reply'),
        startTime: z.string().optional().describe('Start time as Unix timestamp in ms'),
        endTime: z.string().optional().describe('End time as Unix timestamp in ms'),
        restrictToContacts: z.boolean().optional().describe('Only reply to contacts (default: false)'),
        restrictToDomain: z.boolean().optional().describe('Only reply to same domain (default: false)'),
      },
    },
    async ({ account, enableAutoReply, responseSubject, responseBodyPlainText, startTime, endTime, restrictToContacts, restrictToDomain }) => {
      try {
        const auth = await getClient(account as Account);
        const gmail = google.gmail({ version: 'v1', auth });
        const res = await gmail.users.settings.updateVacation({
          userId: 'me',
          requestBody: {
            enableAutoReply,
            responseSubject,
            responseBodyPlainText,
            startTime,
            endTime,
            restrictToContacts: restrictToContacts ?? false,
            restrictToDomain: restrictToDomain ?? false,
          },
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
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
