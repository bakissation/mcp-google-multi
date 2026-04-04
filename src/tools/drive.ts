import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { google } from 'googleapis';
import { ACCOUNTS } from '../accounts.js';
import type { Account } from '../accounts.js';
import { getClient } from '../client.js';

const accountEnum = z.enum(ACCOUNTS);

const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB

const GOOGLE_WORKSPACE_TYPES = new Set([
  'application/vnd.google-apps.document',
  'application/vnd.google-apps.spreadsheet',
  'application/vnd.google-apps.presentation',
  'application/vnd.google-apps.drawing',
]);

export function registerDriveTools(server: McpServer): void {
  // 10.1 drive_search
  server.registerTool(
    'drive_search',
    {
      description: 'Search files in a Google Drive account',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        query: z.string().describe('Drive search syntax, e.g. "name contains \'MoU\'"'),
        maxResults: z.number().min(1).max(100).default(20).optional()
          .describe('Max results to return (default: 20)'),
        driveId: z.string().optional().describe('Optional shared drive ID'),
      },
    },
    async ({ account, query, maxResults, driveId }) => {
      try {
        const auth = await getClient(account as Account);
        const drive = google.drive({ version: 'v3', auth });

        const params: any = {
          q: query,
          pageSize: maxResults ?? 20,
          fields: 'files(id,name,mimeType,modifiedTime,webViewLink,size)',
        };

        if (driveId) {
          params.driveId = driveId;
          params.includeItemsFromAllDrives = true;
          params.supportsAllDrives = true;
          params.corpora = 'drive';
        }

        const res = await drive.files.list(params);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data.files ?? [], null, 2) }],
        };
      } catch (error: any) {
        return handleDriveError(error, account as Account);
      }
    },
  );

  // 10.2 drive_read
  server.registerTool(
    'drive_read',
    {
      description: 'Read the content of a Google Drive file',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        fileId: z.string().describe('Google Drive file ID'),
      },
    },
    async ({ account, fileId }) => {
      try {
        const auth = await getClient(account as Account);
        const drive = google.drive({ version: 'v3', auth });

        // Get file metadata first
        const meta = await drive.files.get({
          fileId,
          fields: 'id,name,mimeType,size,webViewLink',
        });

        const { name, mimeType, size, webViewLink } = meta.data;

        // Google Workspace types — export as plain text
        if (mimeType && GOOGLE_WORKSPACE_TYPES.has(mimeType)) {
          const exported = await drive.files.export({
            fileId,
            mimeType: 'text/plain',
          });
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                id: fileId,
                name,
                mimeType,
                content: String(exported.data),
              }, null, 2),
            }],
          };
        }

        // PDF — can't export directly
        if (mimeType === 'application/pdf') {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                id: fileId,
                name,
                mimeType,
                error: 'binary',
                webViewLink,
              }, null, 2),
            }],
          };
        }

        // Check size limit
        const fileSize = parseInt(size ?? '0', 10);
        if (fileSize > MAX_FILE_SIZE) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                id: fileId,
                name,
                mimeType,
                error: 'too_large',
                webViewLink,
              }, null, 2),
            }],
          };
        }

        // Text files — download and return content
        if (mimeType?.startsWith('text/')) {
          const downloaded = await drive.files.get(
            { fileId, alt: 'media' },
            { responseType: 'text' },
          );
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                id: fileId,
                name,
                mimeType,
                content: String(downloaded.data),
              }, null, 2),
            }],
          };
        }

        // Other binary files
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              id: fileId,
              name,
              mimeType,
              error: 'binary',
              webViewLink,
            }, null, 2),
          }],
        };
      } catch (error: any) {
        return handleDriveError(error, account as Account);
      }
    },
  );

  // 10.3 drive_list
  server.registerTool(
    'drive_list',
    {
      description: 'List files in a Google Drive folder or root',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        folderId: z.string().optional().describe('Folder ID (omit for root)'),
        maxResults: z.number().min(1).max(100).default(50).optional()
          .describe('Max results to return (default: 50)'),
      },
    },
    async ({ account, folderId, maxResults }) => {
      try {
        const auth = await getClient(account as Account);
        const drive = google.drive({ version: 'v3', auth });

        const parent = folderId ?? 'root';
        const res = await drive.files.list({
          q: `'${parent}' in parents and trashed = false`,
          pageSize: maxResults ?? 50,
          fields: 'files(id,name,mimeType,modifiedTime,webViewLink,size)',
        });

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data.files ?? [], null, 2) }],
        };
      } catch (error: any) {
        return handleDriveError(error, account as Account);
      }
    },
  );
}

function handleDriveError(error: any, account: Account) {
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
