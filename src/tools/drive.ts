import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { google } from 'googleapis';
import { ACCOUNTS } from '../accounts.js';
import type { Account } from '../accounts.js';
import { getClient } from '../client.js';
import * as fs from 'fs';
import * as path from 'path';
import mime from 'mime-types';

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

  // --- New tools below ---

  // drive_upload
  server.registerTool(
    'drive_upload',
    {
      description: 'Upload a local file to Google Drive',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        localPath: z.string().describe('Absolute path to file on disk'),
        filename: z.string().describe('Name as it appears in Drive'),
        mimeType: z.string().optional().describe('MIME type (inferred from extension if omitted)'),
        parentFolderId: z.string().optional().describe('Parent folder ID (defaults to My Drive root)'),
      },
    },
    async ({ account, localPath, filename, mimeType: mimeTypeArg, parentFolderId }) => {
      try {
        const auth = await getClient(account as Account);
        const drive = google.drive({ version: 'v3', auth });

        const resolvedMime = mimeTypeArg ?? (mime.lookup(localPath) || 'application/octet-stream');
        const fileStream = fs.createReadStream(localPath);

        const res = await drive.files.create({
          requestBody: {
            name: filename,
            parents: parentFolderId ? [parentFolderId] : undefined,
          },
          media: {
            mimeType: resolvedMime,
            body: fileStream,
          },
          fields: 'id,name,mimeType,webViewLink,size',
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        return handleDriveError(error, account as Account);
      }
    },
  );

  // drive_download
  server.registerTool(
    'drive_download',
    {
      description: 'Download a binary file from Drive to local disk. For Google Workspace formats (Docs, Sheets, Slides), use drive_export instead.',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        fileId: z.string().describe('Google Drive file ID'),
        savePath: z.string().describe('Absolute directory path to save into'),
        filename: z.string().describe('Filename to save as'),
      },
    },
    async ({ account, fileId, savePath, filename }) => {
      try {
        const auth = await getClient(account as Account);
        const drive = google.drive({ version: 'v3', auth });

        // Strip path components so callers can't escape savePath via "../".
        const dest = path.join(savePath, path.basename(filename));
        const res = await drive.files.get(
          { fileId, alt: 'media' },
          { responseType: 'stream' },
        );

        await new Promise<void>((resolve, reject) => {
          const writer = fs.createWriteStream(dest);
          (res.data as NodeJS.ReadableStream).pipe(writer);
          writer.on('finish', resolve);
          writer.on('error', reject);
        });

        const { size } = fs.statSync(dest);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ savedPath: dest, bytes: size }, null, 2) }],
        };
      } catch (error: any) {
        return handleDriveError(error, account as Account);
      }
    },
  );

  // drive_export
  server.registerTool(
    'drive_export',
    {
      description: 'Export a Google Workspace document (Doc, Sheet, Slide) to a standard format and save to disk. Supported: PDF, DOCX, XLSX, PPTX, TXT, CSV, Markdown (text/markdown for Docs).',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        fileId: z.string().describe('Google Drive file ID'),
        mimeType: z.string().describe('Target export MIME type (e.g. "application/pdf", "text/markdown", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")'),
        savePath: z.string().describe('Absolute directory path to save into'),
        filename: z.string().describe('Filename to save as'),
      },
    },
    async ({ account, fileId, mimeType: exportMime, savePath, filename }) => {
      try {
        const auth = await getClient(account as Account);
        const drive = google.drive({ version: 'v3', auth });

        // Strip path components so callers can't escape savePath via "../".
        const dest = path.join(savePath, path.basename(filename));
        const res = await drive.files.export(
          { fileId, mimeType: exportMime },
          { responseType: 'stream' },
        );

        await new Promise<void>((resolve, reject) => {
          const writer = fs.createWriteStream(dest);
          (res.data as NodeJS.ReadableStream).pipe(writer);
          writer.on('finish', resolve);
          writer.on('error', reject);
        });

        const { size } = fs.statSync(dest);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ savedPath: dest, bytes: size }, null, 2) }],
        };
      } catch (error: any) {
        return handleDriveError(error, account as Account);
      }
    },
  );

  // drive_create_folder
  server.registerTool(
    'drive_create_folder',
    {
      description: 'Create a new folder in Google Drive',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        name: z.string().describe('Folder name'),
        parentFolderId: z.string().optional().describe('Parent folder ID (defaults to My Drive root)'),
      },
    },
    async ({ account, name, parentFolderId }) => {
      try {
        const auth = await getClient(account as Account);
        const drive = google.drive({ version: 'v3', auth });
        const res = await drive.files.create({
          requestBody: {
            name,
            mimeType: 'application/vnd.google-apps.folder',
            parents: parentFolderId ? [parentFolderId] : undefined,
          },
          fields: 'id,name,webViewLink',
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        return handleDriveError(error, account as Account);
      }
    },
  );

  // drive_update
  server.registerTool(
    'drive_update',
    {
      description: 'Rename, move, or replace content of a Drive file. Any combination in one call.',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        fileId: z.string().describe('Google Drive file ID'),
        newName: z.string().optional().describe('New filename'),
        newParentFolderId: z.string().optional().describe('Move to this folder'),
        localPath: z.string().optional().describe('Replace file content with this local file'),
        mimeType: z.string().optional().describe('MIME type of the replacement file (required if localPath is provided)'),
      },
    },
    async ({ account, fileId, newName, newParentFolderId, localPath: localPathArg, mimeType: mimeTypeArg }) => {
      try {
        const auth = await getClient(account as Account);
        const drive = google.drive({ version: 'v3', auth });

        const requestBody: any = {};
        if (newName) requestBody.name = newName;

        const params: any = {
          fileId,
          requestBody,
          fields: 'id,name,parents,modifiedTime',
        };

        if (newParentFolderId) {
          const current = await drive.files.get({ fileId, fields: 'parents' });
          params.removeParents = (current.data.parents ?? []).join(',');
          params.addParents = newParentFolderId;
        }

        if (localPathArg) {
          params.media = {
            mimeType: mimeTypeArg ?? (mime.lookup(localPathArg) || 'application/octet-stream'),
            body: fs.createReadStream(localPathArg),
          };
        }

        const res = await drive.files.update(params);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        return handleDriveError(error, account as Account);
      }
    },
  );

  // drive_delete
  server.registerTool(
    'drive_delete',
    {
      description: 'Permanently delete a file or folder from Google Drive. Irreversible. Use drive_trash for recoverable deletion.',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        fileId: z.string().describe('Google Drive file ID'),
      },
    },
    async ({ account, fileId }) => {
      try {
        const auth = await getClient(account as Account);
        const drive = google.drive({ version: 'v3', auth });
        await drive.files.delete({ fileId });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ deleted: true, fileId }, null, 2) }],
        };
      } catch (error: any) {
        return handleDriveError(error, account as Account);
      }
    },
  );

  // drive_trash
  server.registerTool(
    'drive_trash',
    {
      description: 'Move a file to Google Drive trash. Recoverable from Drive UI.',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        fileId: z.string().describe('Google Drive file ID'),
      },
    },
    async ({ account, fileId }) => {
      try {
        const auth = await getClient(account as Account);
        const drive = google.drive({ version: 'v3', auth });
        await drive.files.update({
          fileId,
          requestBody: { trashed: true },
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ trashed: true, fileId }, null, 2) }],
        };
      } catch (error: any) {
        return handleDriveError(error, account as Account);
      }
    },
  );

  // drive_copy
  server.registerTool(
    'drive_copy',
    {
      description: 'Duplicate a file in Google Drive (does not work on folders)',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        fileId: z.string().describe('Google Drive file ID to copy'),
        newName: z.string().optional().describe('Name for the copy (default: "Copy of <original>")'),
        parentFolderId: z.string().optional().describe('Where to put the copy (default: same folder)'),
      },
    },
    async ({ account, fileId, newName, parentFolderId }) => {
      try {
        const auth = await getClient(account as Account);
        const drive = google.drive({ version: 'v3', auth });
        const res = await drive.files.copy({
          fileId,
          requestBody: {
            name: newName,
            parents: parentFolderId ? [parentFolderId] : undefined,
          },
          fields: 'id,name,webViewLink',
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        return handleDriveError(error, account as Account);
      }
    },
  );

  // drive_share
  server.registerTool(
    'drive_share',
    {
      description: 'Share a file or folder with a user, group, domain, or anyone with the link',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        fileId: z.string().describe('Google Drive file ID'),
        type: z.enum(['user', 'group', 'domain', 'anyone']).describe('Permission type'),
        role: z.enum(['reader', 'commenter', 'writer', 'owner']).describe('Permission role'),
        emailAddress: z.string().optional().describe('Required when type is "user" or "group"'),
        domain: z.string().optional().describe('Required when type is "domain"'),
        sendNotification: z.boolean().optional().describe('Send notification email (default: true)'),
        emailMessage: z.string().optional().describe('Custom message in notification email'),
      },
    },
    async ({ account, fileId, type, role, emailAddress, domain, sendNotification, emailMessage }) => {
      try {
        const auth = await getClient(account as Account);
        const drive = google.drive({ version: 'v3', auth });
        const res = await drive.permissions.create({
          fileId,
          sendNotificationEmail: sendNotification ?? true,
          emailMessage,
          requestBody: {
            type,
            role,
            emailAddress,
            domain,
          },
          fields: 'id,type,role,emailAddress',
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        return handleDriveError(error, account as Account);
      }
    },
  );

  // drive_list_permissions
  server.registerTool(
    'drive_list_permissions',
    {
      description: 'List all people and groups who have access to a Drive file or folder',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        fileId: z.string().describe('Google Drive file ID'),
      },
    },
    async ({ account, fileId }) => {
      try {
        const auth = await getClient(account as Account);
        const drive = google.drive({ version: 'v3', auth });
        const res = await drive.permissions.list({
          fileId,
          fields: 'permissions(id,type,role,emailAddress,displayName)',
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data.permissions ?? [], null, 2) }],
        };
      } catch (error: any) {
        return handleDriveError(error, account as Account);
      }
    },
  );

  // drive_remove_permission
  server.registerTool(
    'drive_remove_permission',
    {
      description: 'Revoke access to a Drive file for a specific permission',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        fileId: z.string().describe('Google Drive file ID'),
        permissionId: z.string().describe('Permission ID from drive_list_permissions'),
      },
    },
    async ({ account, fileId, permissionId }) => {
      try {
        const auth = await getClient(account as Account);
        const drive = google.drive({ version: 'v3', auth });
        await drive.permissions.delete({ fileId, permissionId });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ removed: true, permissionId }, null, 2) }],
        };
      } catch (error: any) {
        return handleDriveError(error, account as Account);
      }
    },
  );

  // drive_get_about
  server.registerTool(
    'drive_get_about',
    {
      description: 'Get Drive storage quota, user display name, and email for an account',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
      },
    },
    async ({ account }) => {
      try {
        const auth = await getClient(account as Account);
        const drive = google.drive({ version: 'v3', auth });
        const res = await drive.about.get({
          fields: 'user,storageQuota',
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
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
