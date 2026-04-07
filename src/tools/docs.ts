import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { google } from 'googleapis';
import { ACCOUNTS } from '../accounts.js';
import type { Account } from '../accounts.js';
import { getClient } from '../client.js';

const accountEnum = z.enum(ACCOUNTS);

function extractPlainText(body: any): string {
  if (!body?.content) return '';
  let text = '';
  for (const element of body.content) {
    if (element.paragraph) {
      for (const pe of element.paragraph.elements ?? []) {
        if (pe.textRun?.content) {
          text += pe.textRun.content;
        }
      }
    } else if (element.table) {
      for (const row of element.table.tableRows ?? []) {
        for (const cell of row.tableCells ?? []) {
          text += extractPlainText(cell);
        }
      }
    }
  }
  return text;
}

export function registerDocsTools(server: McpServer): void {
  // docs_create
  server.registerTool(
    'docs_create',
    {
      description: 'Create a new Google Docs document',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        title: z.string().describe('Document title'),
      },
    },
    async ({ account, title }) => {
      try {
        const auth = await getClient(account as Account);
        const docs = google.docs({ version: 'v1', auth });
        const res = await docs.documents.create({
          requestBody: { title },
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            documentId: res.data.documentId,
            title: res.data.title,
          }, null, 2) }],
        };
      } catch (error: any) {
        return handleDocsError(error, account as Account);
      }
    },
  );

  // docs_get
  server.registerTool(
    'docs_get',
    {
      description: 'Get document metadata (title, revision, named ranges)',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        documentId: z.string().describe('Google Docs document ID'),
      },
    },
    async ({ account, documentId }) => {
      try {
        const auth = await getClient(account as Account);
        const docs = google.docs({ version: 'v1', auth });
        const res = await docs.documents.get({ documentId });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            documentId: res.data.documentId,
            title: res.data.title,
            revisionId: res.data.revisionId,
            namedRanges: res.data.namedRanges ?? {},
          }, null, 2) }],
        };
      } catch (error: any) {
        return handleDocsError(error, account as Account);
      }
    },
  );

  // docs_read
  server.registerTool(
    'docs_read',
    {
      description: 'Read document content as plain text',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        documentId: z.string().describe('Google Docs document ID'),
      },
    },
    async ({ account, documentId }) => {
      try {
        const auth = await getClient(account as Account);
        const docs = google.docs({ version: 'v1', auth });
        const res = await docs.documents.get({ documentId });
        const text = extractPlainText(res.data.body);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            documentId: res.data.documentId,
            title: res.data.title,
            text,
          }, null, 2) }],
        };
      } catch (error: any) {
        return handleDocsError(error, account as Account);
      }
    },
  );

  // docs_insert_text
  server.registerTool(
    'docs_insert_text',
    {
      description: 'Insert text into a document at a specific position or at the end',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        documentId: z.string().describe('Google Docs document ID'),
        text: z.string().describe('Text to insert'),
        index: z.number().min(1).optional()
          .describe('Character index to insert at (1-based). Omit to append at the end'),
      },
    },
    async ({ account, documentId, text, index }) => {
      try {
        const auth = await getClient(account as Account);
        const docs = google.docs({ version: 'v1', auth });

        const request: any = { insertText: { text } };
        if (index !== undefined) {
          request.insertText.location = { index };
        } else {
          request.insertText.endOfSegmentLocation = { segmentId: '' };
        }

        const res = await docs.documents.batchUpdate({
          documentId,
          requestBody: { requests: [request] },
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            documentId: res.data.documentId,
            insertedAt: index ?? 'end',
          }, null, 2) }],
        };
      } catch (error: any) {
        return handleDocsError(error, account as Account);
      }
    },
  );

  // docs_replace_text
  server.registerTool(
    'docs_replace_text',
    {
      description: 'Find and replace all occurrences of text in a document',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        documentId: z.string().describe('Google Docs document ID'),
        findText: z.string().describe('Text to search for'),
        replaceText: z.string().describe('Replacement text'),
        matchCase: z.boolean().default(true).optional()
          .describe('Case-sensitive match (default: true)'),
      },
    },
    async ({ account, documentId, findText, replaceText, matchCase }) => {
      try {
        const auth = await getClient(account as Account);
        const docs = google.docs({ version: 'v1', auth });
        const res = await docs.documents.batchUpdate({
          documentId,
          requestBody: {
            requests: [{
              replaceAllText: {
                containsText: { text: findText, matchCase: matchCase ?? true },
                replaceText,
              },
            }],
          },
        });
        const occurrences = (res.data.replies?.[0] as any)?.replaceAllText?.occurrencesChanged ?? 0;
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            documentId: res.data.documentId,
            occurrencesReplaced: occurrences,
          }, null, 2) }],
        };
      } catch (error: any) {
        return handleDocsError(error, account as Account);
      }
    },
  );

  // docs_delete_range
  server.registerTool(
    'docs_delete_range',
    {
      description: 'Delete content in a character index range within a document',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        documentId: z.string().describe('Google Docs document ID'),
        startIndex: z.number().min(1).describe('Start index (inclusive, 1-based)'),
        endIndex: z.number().min(2).describe('End index (exclusive)'),
      },
    },
    async ({ account, documentId, startIndex, endIndex }) => {
      try {
        const auth = await getClient(account as Account);
        const docs = google.docs({ version: 'v1', auth });
        const res = await docs.documents.batchUpdate({
          documentId,
          requestBody: {
            requests: [{
              deleteContentRange: {
                range: { startIndex, endIndex, segmentId: '' },
              },
            }],
          },
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            documentId: res.data.documentId,
            deletedRange: { startIndex, endIndex },
          }, null, 2) }],
        };
      } catch (error: any) {
        return handleDocsError(error, account as Account);
      }
    },
  );

  // docs_update_style
  server.registerTool(
    'docs_update_style',
    {
      description: 'Update text formatting (bold, italic, underline, font, size) for a range',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        documentId: z.string().describe('Google Docs document ID'),
        startIndex: z.number().min(1).describe('Start index (inclusive, 1-based)'),
        endIndex: z.number().min(2).describe('End index (exclusive)'),
        bold: z.boolean().optional().describe('Set bold'),
        italic: z.boolean().optional().describe('Set italic'),
        underline: z.boolean().optional().describe('Set underline'),
        fontSize: z.number().min(1).optional().describe('Font size in points'),
        fontFamily: z.string().optional().describe('Font family name (e.g. "Arial", "Times New Roman")'),
      },
    },
    async ({ account, documentId, startIndex, endIndex, bold, italic, underline, fontSize, fontFamily }) => {
      try {
        const auth = await getClient(account as Account);
        const docs = google.docs({ version: 'v1', auth });

        const textStyle: any = {};
        const fields: string[] = [];

        if (bold !== undefined) { textStyle.bold = bold; fields.push('bold'); }
        if (italic !== undefined) { textStyle.italic = italic; fields.push('italic'); }
        if (underline !== undefined) { textStyle.underline = underline; fields.push('underline'); }
        if (fontSize !== undefined) {
          textStyle.fontSize = { magnitude: fontSize, unit: 'PT' };
          fields.push('fontSize');
        }
        if (fontFamily !== undefined) {
          textStyle.weightedFontFamily = { fontFamily };
          fields.push('weightedFontFamily');
        }

        if (fields.length === 0) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({
              error: 'No style properties provided. Set at least one of: bold, italic, underline, fontSize, fontFamily',
            }, null, 2) }],
            isError: true,
          };
        }

        const res = await docs.documents.batchUpdate({
          documentId,
          requestBody: {
            requests: [{
              updateTextStyle: {
                range: { startIndex, endIndex, segmentId: '' },
                textStyle,
                fields: fields.join(','),
              },
            }],
          },
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            documentId: res.data.documentId,
            styledRange: { startIndex, endIndex },
            appliedStyles: fields,
          }, null, 2) }],
        };
      } catch (error: any) {
        return handleDocsError(error, account as Account);
      }
    },
  );

  // docs_insert_table
  server.registerTool(
    'docs_insert_table',
    {
      description: 'Insert a table into a document at a specific position',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        documentId: z.string().describe('Google Docs document ID'),
        rows: z.number().min(1).describe('Number of rows'),
        columns: z.number().min(1).describe('Number of columns'),
        index: z.number().min(1).optional()
          .describe('Character index to insert at. Omit to append at the end'),
      },
    },
    async ({ account, documentId, rows, columns, index }) => {
      try {
        const auth = await getClient(account as Account);
        const docs = google.docs({ version: 'v1', auth });

        const request: any = { insertTable: { rows, columns } };
        if (index !== undefined) {
          request.insertTable.location = { index };
        } else {
          request.insertTable.endOfSegmentLocation = { segmentId: '' };
        }

        const res = await docs.documents.batchUpdate({
          documentId,
          requestBody: { requests: [request] },
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            documentId: res.data.documentId,
            insertedTable: { rows, columns, at: index ?? 'end' },
          }, null, 2) }],
        };
      } catch (error: any) {
        return handleDocsError(error, account as Account);
      }
    },
  );
}

function handleDocsError(error: any, account: Account) {
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
