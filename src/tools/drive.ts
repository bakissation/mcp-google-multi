import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { google } from 'googleapis';
import { ACCOUNTS } from '../accounts.js';
import type { Account } from '../accounts.js';
import { getClient } from '../client.js';
import { handleGoogleApiError } from './_errors.js';
import * as fs from 'fs';
import * as path from 'path';
import { pipeline } from 'node:stream/promises';
import mime from 'mime-types';

const accountEnum = z.enum(ACCOUNTS);

const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB

const GOOGLE_WORKSPACE_TYPES = new Set([
  'application/vnd.google-apps.document',
  'application/vnd.google-apps.spreadsheet',
  'application/vnd.google-apps.presentation',
  'application/vnd.google-apps.drawing',
]);

// Comment/Reply fields list — Drive API requires explicit `fields` on every call.
const COMMENT_BASE_FIELDS = 'id,kind,content,htmlContent,createdTime,modifiedTime,resolved,anchor,author,deleted,quotedFileContent';
const REPLY_SUBFIELDS = 'id,content,action,createdTime,modifiedTime,author,deleted';
const COMMENT_FIELDS = `${COMMENT_BASE_FIELDS},replies(${REPLY_SUBFIELDS})`;
const COMMENT_LIST_FIELDS = `nextPageToken,comments(${COMMENT_BASE_FIELDS},replies(${REPLY_SUBFIELDS}))`;
const REPLY_FIELDS = `kind,htmlContent,${REPLY_SUBFIELDS}`;
const REPLY_LIST_FIELDS = `nextPageToken,replies(${REPLY_FIELDS})`;

export function registerDriveTools(server: McpServer): void {
  // ─── Read / search / list ──────────────────────────────────────────────

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
          fields: 'files(id,name,mimeType,modifiedTime,webViewLink,size,parents,driveId)',
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        };

        if (driveId) {
          params.driveId = driveId;
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

        const meta = await drive.files.get({
          fileId,
          fields: 'id,name,mimeType,size,webViewLink',
          supportsAllDrives: true,
        });

        const { name, mimeType, size, webViewLink } = meta.data;

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

        if (mimeType?.startsWith('text/')) {
          const downloaded = await drive.files.get(
            { fileId, alt: 'media', supportsAllDrives: true },
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

        // Escape single quotes per Drive query syntax to prevent breaking out of the literal.
        const parent = (folderId ?? 'root').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        const res = await drive.files.list({
          q: `'${parent}' in parents and trashed = false`,
          pageSize: maxResults ?? 50,
          fields: 'files(id,name,mimeType,modifiedTime,webViewLink,size,parents)',
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        });

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data.files ?? [], null, 2) }],
        };
      } catch (error: any) {
        return handleDriveError(error, account as Account);
      }
    },
  );

  // ─── Write / upload / download ─────────────────────────────────────────

  server.registerTool(
    'drive_upload',
    {
      description: 'Upload a local file to Google Drive. Pass `convertTo` to import it as a native, editable Google Doc/Sheet/Slides/Drawing instead of storing the raw bytes.',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        localPath: z.string().describe('Absolute path to file on disk'),
        filename: z.string().describe('Name as it appears in Drive'),
        mimeType: z.string().optional().describe('Source MIME type of the local file (inferred from extension if omitted). With `convertTo`, this is the format Drive imports from.'),
        convertTo: z.enum([
          'application/vnd.google-apps.document',
          'application/vnd.google-apps.spreadsheet',
          'application/vnd.google-apps.presentation',
          'application/vnd.google-apps.drawing',
        ]).optional().describe('Convert the upload into this native Google Workspace type on import (e.g. upload .md/.html/.docx/.txt with convertTo=...google-apps.document to get a real Google Doc). Source must be an importable format. Omit to store the file as-is.'),
        parentFolderId: z.string().optional().describe('Parent folder ID (defaults to My Drive root)'),
      },
    },
    async ({ account, localPath, filename, mimeType: mimeTypeArg, convertTo, parentFolderId }) => {
      try {
        const auth = await getClient(account as Account);
        const drive = google.drive({ version: 'v3', auth });

        const resolvedMime = mimeTypeArg ?? (mime.lookup(localPath) || 'application/octet-stream');
        const fileStream = fs.createReadStream(localPath);

        const res = await drive.files.create({
          requestBody: {
            name: filename,
            parents: parentFolderId ? [parentFolderId] : undefined,
            // Setting a google-apps target type makes Drive convert the media on import.
            ...(convertTo ? { mimeType: convertTo } : {}),
          },
          media: {
            mimeType: resolvedMime,
            body: fileStream,
          },
          fields: 'id,name,mimeType,webViewLink,size',
          supportsAllDrives: true,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        return handleDriveError(error, account as Account);
      }
    },
  );

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

        const dest = path.join(savePath, path.basename(filename));
        const res = await drive.files.get(
          { fileId, alt: 'media', supportsAllDrives: true },
          { responseType: 'stream' },
        );

        // pipeline destroys both streams on source/sink error; raw .pipe leaks the partial file.
        await pipeline(res.data as NodeJS.ReadableStream, fs.createWriteStream(dest));

        const { size } = fs.statSync(dest);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ savedPath: dest, bytes: size }, null, 2) }],
        };
      } catch (error: any) {
        return handleDriveError(error, account as Account);
      }
    },
  );

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

        const dest = path.join(savePath, path.basename(filename));
        const res = await drive.files.export(
          { fileId, mimeType: exportMime },
          { responseType: 'stream' },
        );

        // pipeline destroys both streams on source/sink error; raw .pipe leaks the partial file.
        await pipeline(res.data as NodeJS.ReadableStream, fs.createWriteStream(dest));

        const { size } = fs.statSync(dest);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ savedPath: dest, bytes: size }, null, 2) }],
        };
      } catch (error: any) {
        return handleDriveError(error, account as Account);
      }
    },
  );

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
          supportsAllDrives: true,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        return handleDriveError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'drive_update',
    {
      description: 'Rename, move, or replace content of a Drive file. Any combination in one call. For untrash, use drive_untrash.',
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
          supportsAllDrives: true,
        };

        if (newParentFolderId) {
          const current = await drive.files.get({ fileId, fields: 'parents', supportsAllDrives: true });
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

  // ─── Trash / delete ────────────────────────────────────────────────────

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
        await drive.files.delete({ fileId, supportsAllDrives: true });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ deleted: true, fileId }, null, 2) }],
        };
      } catch (error: any) {
        return handleDriveError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'drive_trash',
    {
      description: 'Move a file to Google Drive trash. Recoverable from Drive UI or via drive_untrash.',
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
          supportsAllDrives: true,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ trashed: true, fileId }, null, 2) }],
        };
      } catch (error: any) {
        return handleDriveError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'drive_untrash',
    {
      description: 'Restore a trashed file from Google Drive trash back to its previous location.',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        fileId: z.string().describe('Google Drive file ID'),
      },
    },
    async ({ account, fileId }) => {
      try {
        const auth = await getClient(account as Account);
        const drive = google.drive({ version: 'v3', auth });
        const res = await drive.files.update({
          fileId,
          requestBody: { trashed: false },
          fields: 'id,name,trashed,parents',
          supportsAllDrives: true,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        return handleDriveError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'drive_empty_trash',
    {
      description: 'Permanently delete every file currently in the account\'s trash. Irreversible.',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
      },
    },
    async ({ account }) => {
      try {
        const auth = await getClient(account as Account);
        const drive = google.drive({ version: 'v3', auth });
        await drive.files.emptyTrash({});
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ emptied: true }, null, 2) }],
        };
      } catch (error: any) {
        return handleDriveError(error, account as Account);
      }
    },
  );

  // ─── Copy / move ───────────────────────────────────────────────────────

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
          supportsAllDrives: true,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        return handleDriveError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'drive_move',
    {
      description: 'Move a file between folders by replacing its parents. To move to multiple parents, list all of them.',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        fileId: z.string().describe('Google Drive file ID'),
        newParentFolderId: z.string().describe('Destination folder ID'),
      },
    },
    async ({ account, fileId, newParentFolderId }) => {
      try {
        const auth = await getClient(account as Account);
        const drive = google.drive({ version: 'v3', auth });
        const current = await drive.files.get({ fileId, fields: 'parents', supportsAllDrives: true });
        const res = await drive.files.update({
          fileId,
          addParents: newParentFolderId,
          removeParents: (current.data.parents ?? []).join(','),
          fields: 'id,name,parents,modifiedTime',
          supportsAllDrives: true,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        return handleDriveError(error, account as Account);
      }
    },
  );

  // ─── Permissions / sharing ─────────────────────────────────────────────

  server.registerTool(
    'drive_share',
    {
      description: 'Share a file or folder with a user, group, domain, or anyone with the link',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        fileId: z.string().describe('Google Drive file ID'),
        type: z.enum(['user', 'group', 'domain', 'anyone']).describe('Permission type'),
        role: z.enum(['reader', 'commenter', 'writer', 'fileOrganizer', 'organizer', 'owner']).describe('Permission role'),
        emailAddress: z.string().optional().describe('Required when type is "user" or "group"'),
        domain: z.string().optional().describe('Required when type is "domain"'),
        sendNotification: z.boolean().optional().describe('Send notification email (default: true)'),
        emailMessage: z.string().optional().describe('Custom message in notification email'),
        transferOwnership: z.boolean().optional().describe('Transfer ownership to the recipient. Requires role="owner". Recipient must accept ownership.'),
        expirationTime: z.string().optional().describe('RFC 3339 timestamp when access expires. Only valid for role="reader" or "commenter".'),
      },
    },
    async ({ account, fileId, type, role, emailAddress, domain, sendNotification, emailMessage, transferOwnership, expirationTime }) => {
      try {
        const auth = await getClient(account as Account);
        const drive = google.drive({ version: 'v3', auth });
        const requestBody: any = { type, role, emailAddress, domain };
        if (expirationTime) requestBody.expirationTime = expirationTime;

        const res = await drive.permissions.create({
          fileId,
          sendNotificationEmail: sendNotification ?? true,
          emailMessage,
          transferOwnership: transferOwnership ?? false,
          supportsAllDrives: true,
          requestBody,
          fields: 'id,type,role,emailAddress,domain,expirationTime',
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        return handleDriveError(error, account as Account);
      }
    },
  );

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
          fields: 'permissions(id,type,role,emailAddress,domain,displayName,expirationTime)',
          supportsAllDrives: true,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data.permissions ?? [], null, 2) }],
        };
      } catch (error: any) {
        return handleDriveError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'drive_permission_update',
    {
      description: 'Change the role and/or expirationTime of an existing permission without removing it. Use "removeExpiration=true" to clear an existing expirationTime.',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        fileId: z.string().describe('Google Drive file ID'),
        permissionId: z.string().describe('Permission ID from drive_list_permissions'),
        role: z.enum(['reader', 'commenter', 'writer', 'fileOrganizer', 'organizer', 'owner']).optional()
          .describe('New role'),
        expirationTime: z.string().optional()
          .describe('New RFC 3339 expiration timestamp. Only valid for role "reader" or "commenter".'),
        removeExpiration: z.boolean().optional()
          .describe('Clear the existing expirationTime'),
        transferOwnership: z.boolean().optional()
          .describe('Promote to owner. Requires role="owner".'),
      },
    },
    async ({ account, fileId, permissionId, role, expirationTime, removeExpiration, transferOwnership }) => {
      try {
        const auth = await getClient(account as Account);
        const drive = google.drive({ version: 'v3', auth });
        const requestBody: any = {};
        if (role) requestBody.role = role;
        if (expirationTime) requestBody.expirationTime = expirationTime;

        const res = await drive.permissions.update({
          fileId,
          permissionId,
          requestBody,
          removeExpiration: removeExpiration ?? false,
          transferOwnership: transferOwnership ?? false,
          supportsAllDrives: true,
          fields: 'id,type,role,emailAddress,expirationTime',
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        return handleDriveError(error, account as Account);
      }
    },
  );

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
        await drive.permissions.delete({ fileId, permissionId, supportsAllDrives: true });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ removed: true, permissionId }, null, 2) }],
        };
      } catch (error: any) {
        return handleDriveError(error, account as Account);
      }
    },
  );

  // ─── Comments ──────────────────────────────────────────────────────────

  server.registerTool(
    'drive_comment_create',
    {
      description: 'Create a comment on a Drive file. Works on Docs, Sheets, Slides, PDFs, and any Drive file. The optional anchor is a JSON string describing the document region (see Drive "Manage comments" guide).',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        fileId: z.string().describe('Google Drive file ID'),
        content: z.string().describe('Plain text comment content'),
        anchor: z.string().optional().describe('Region anchor (JSON string). Optional.'),
        quotedFileContent: z.object({
          mimeType: z.string(),
          value: z.string(),
        }).optional().describe('Optional reference to quoted file content'),
      },
    },
    async ({ account, fileId, content, anchor, quotedFileContent }) => {
      try {
        const auth = await getClient(account as Account);
        const drive = google.drive({ version: 'v3', auth });
        const requestBody: any = { content };
        if (anchor) requestBody.anchor = anchor;
        if (quotedFileContent) requestBody.quotedFileContent = quotedFileContent;

        const res = await drive.comments.create({
          fileId,
          requestBody,
          fields: COMMENT_FIELDS,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        return handleDriveError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'drive_comment_list',
    {
      description: 'List comments on a Drive file with pagination',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        fileId: z.string().describe('Google Drive file ID'),
        includeDeleted: z.boolean().optional().describe('Include deleted comments (default: false)'),
        pageSize: z.number().min(1).max(100).optional().describe('Max comments per page (default: 20)'),
        pageToken: z.string().optional().describe('Token from a previous page'),
        startModifiedTime: z.string().optional().describe('Only return comments modified after this RFC 3339 timestamp'),
      },
    },
    async ({ account, fileId, includeDeleted, pageSize, pageToken, startModifiedTime }) => {
      try {
        const auth = await getClient(account as Account);
        const drive = google.drive({ version: 'v3', auth });
        const res = await drive.comments.list({
          fileId,
          includeDeleted: includeDeleted ?? false,
          pageSize: pageSize ?? 20,
          pageToken,
          startModifiedTime,
          fields: COMMENT_LIST_FIELDS,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        return handleDriveError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'drive_comment_get',
    {
      description: 'Get a single comment by ID',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        fileId: z.string().describe('Google Drive file ID'),
        commentId: z.string().describe('Comment ID'),
        includeDeleted: z.boolean().optional(),
      },
    },
    async ({ account, fileId, commentId, includeDeleted }) => {
      try {
        const auth = await getClient(account as Account);
        const drive = google.drive({ version: 'v3', auth });
        const res = await drive.comments.get({
          fileId,
          commentId,
          includeDeleted: includeDeleted ?? false,
          fields: COMMENT_FIELDS,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        return handleDriveError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'drive_comment_update',
    {
      description: 'Edit the content of an existing comment (PATCH semantics)',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        fileId: z.string().describe('Google Drive file ID'),
        commentId: z.string().describe('Comment ID'),
        content: z.string().describe('New plain text content'),
      },
    },
    async ({ account, fileId, commentId, content }) => {
      try {
        const auth = await getClient(account as Account);
        const drive = google.drive({ version: 'v3', auth });
        const res = await drive.comments.update({
          fileId,
          commentId,
          requestBody: { content },
          fields: COMMENT_FIELDS,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        return handleDriveError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'drive_comment_delete',
    {
      description: 'Delete a comment from a Drive file',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        fileId: z.string().describe('Google Drive file ID'),
        commentId: z.string().describe('Comment ID'),
      },
    },
    async ({ account, fileId, commentId }) => {
      try {
        const auth = await getClient(account as Account);
        const drive = google.drive({ version: 'v3', auth });
        await drive.comments.delete({ fileId, commentId });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ deleted: true, commentId }, null, 2) }],
        };
      } catch (error: any) {
        return handleDriveError(error, account as Account);
      }
    },
  );

  // ─── Replies ───────────────────────────────────────────────────────────

  server.registerTool(
    'drive_reply_create',
    {
      description: 'Reply to a comment. Optionally close or reopen the thread by setting action to "resolve" or "reopen".',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        fileId: z.string().describe('Google Drive file ID'),
        commentId: z.string().describe('Parent comment ID'),
        content: z.string().describe('Reply content (required even when only changing action)'),
        action: z.enum(['resolve', 'reopen']).optional()
          .describe('Optional action to apply to the thread on this reply'),
      },
    },
    async ({ account, fileId, commentId, content, action }) => {
      try {
        const auth = await getClient(account as Account);
        const drive = google.drive({ version: 'v3', auth });
        const requestBody: any = { content };
        if (action) requestBody.action = action;

        const res = await drive.replies.create({
          fileId,
          commentId,
          requestBody,
          fields: REPLY_FIELDS,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        return handleDriveError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'drive_reply_list',
    {
      description: 'List replies on a comment with pagination',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        fileId: z.string().describe('Google Drive file ID'),
        commentId: z.string().describe('Parent comment ID'),
        includeDeleted: z.boolean().optional(),
        pageSize: z.number().min(1).max(100).optional(),
        pageToken: z.string().optional(),
      },
    },
    async ({ account, fileId, commentId, includeDeleted, pageSize, pageToken }) => {
      try {
        const auth = await getClient(account as Account);
        const drive = google.drive({ version: 'v3', auth });
        const res = await drive.replies.list({
          fileId,
          commentId,
          includeDeleted: includeDeleted ?? false,
          pageSize: pageSize ?? 20,
          pageToken,
          fields: REPLY_LIST_FIELDS,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        return handleDriveError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'drive_reply_update',
    {
      description: 'Edit the content of an existing reply',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        fileId: z.string().describe('Google Drive file ID'),
        commentId: z.string().describe('Parent comment ID'),
        replyId: z.string().describe('Reply ID'),
        content: z.string().describe('New plain text content'),
      },
    },
    async ({ account, fileId, commentId, replyId, content }) => {
      try {
        const auth = await getClient(account as Account);
        const drive = google.drive({ version: 'v3', auth });
        const res = await drive.replies.update({
          fileId,
          commentId,
          replyId,
          requestBody: { content },
          fields: REPLY_FIELDS,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        return handleDriveError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'drive_reply_delete',
    {
      description: 'Delete a reply from a comment thread',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        fileId: z.string().describe('Google Drive file ID'),
        commentId: z.string().describe('Parent comment ID'),
        replyId: z.string().describe('Reply ID'),
      },
    },
    async ({ account, fileId, commentId, replyId }) => {
      try {
        const auth = await getClient(account as Account);
        const drive = google.drive({ version: 'v3', auth });
        await drive.replies.delete({ fileId, commentId, replyId });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ deleted: true, replyId }, null, 2) }],
        };
      } catch (error: any) {
        return handleDriveError(error, account as Account);
      }
    },
  );

  // ─── Revisions ─────────────────────────────────────────────────────────

  server.registerTool(
    'drive_revision_list',
    {
      description: 'List version history of a Drive file',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        fileId: z.string().describe('Google Drive file ID'),
        pageSize: z.number().min(1).max(200).optional(),
        pageToken: z.string().optional(),
      },
    },
    async ({ account, fileId, pageSize, pageToken }) => {
      try {
        const auth = await getClient(account as Account);
        const drive = google.drive({ version: 'v3', auth });
        const res = await drive.revisions.list({
          fileId,
          pageSize: pageSize ?? 50,
          pageToken,
          fields: 'nextPageToken,revisions(id,mimeType,modifiedTime,keepForever,published,lastModifyingUser,size)',
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        return handleDriveError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'drive_revision_update',
    {
      description: 'Pin a revision (keepForever=true) against the 200-version cap, or change its published state for Docs.',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        fileId: z.string().describe('Google Drive file ID'),
        revisionId: z.string().describe('Revision ID'),
        keepForever: z.boolean().optional().describe('Pin this revision indefinitely'),
        published: z.boolean().optional().describe('Toggle published state (Docs only)'),
        publishAuto: z.boolean().optional().describe('Auto-publish subsequent revisions'),
        publishedOutsideDomain: z.boolean().optional().describe('Allow publish outside domain'),
      },
    },
    async ({ account, fileId, revisionId, keepForever, published, publishAuto, publishedOutsideDomain }) => {
      try {
        const auth = await getClient(account as Account);
        const drive = google.drive({ version: 'v3', auth });
        const requestBody: any = {};
        if (keepForever !== undefined) requestBody.keepForever = keepForever;
        if (published !== undefined) requestBody.published = published;
        if (publishAuto !== undefined) requestBody.publishAuto = publishAuto;
        if (publishedOutsideDomain !== undefined) requestBody.publishedOutsideDomain = publishedOutsideDomain;

        const res = await drive.revisions.update({
          fileId,
          revisionId,
          requestBody,
          fields: 'id,modifiedTime,keepForever,published',
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        return handleDriveError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'drive_revision_delete',
    {
      description: 'Delete a specific revision of a file',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        fileId: z.string().describe('Google Drive file ID'),
        revisionId: z.string().describe('Revision ID'),
      },
    },
    async ({ account, fileId, revisionId }) => {
      try {
        const auth = await getClient(account as Account);
        const drive = google.drive({ version: 'v3', auth });
        await drive.revisions.delete({ fileId, revisionId });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ deleted: true, revisionId }, null, 2) }],
        };
      } catch (error: any) {
        return handleDriveError(error, account as Account);
      }
    },
  );

  // ─── Access proposals ──────────────────────────────────────────────────

  server.registerTool(
    'drive_access_proposal_list',
    {
      description: 'List pending "Request access" proposals on a file. Useful for programmatic triage of share requests from external collaborators.',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        fileId: z.string().describe('Google Drive file ID'),
        pageSize: z.number().min(1).max(100).optional(),
        pageToken: z.string().optional(),
      },
    },
    async ({ account, fileId, pageSize, pageToken }) => {
      try {
        const auth = await getClient(account as Account);
        const drive = google.drive({ version: 'v3', auth });
        const res = await drive.accessproposals.list({
          fileId,
          pageSize: pageSize ?? 20,
          pageToken,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        return handleDriveError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'drive_access_proposal_resolve',
    {
      description: 'Resolve a pending access proposal. Action ACCEPT requires a role array (e.g. ["reader"]).',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        fileId: z.string().describe('Google Drive file ID'),
        proposalId: z.string().describe('Access proposal ID'),
        action: z.enum(['ACCEPT', 'DENY']).describe('Whether to accept or deny the proposal'),
        role: z.array(z.enum(['reader', 'commenter', 'writer', 'fileOrganizer'])).optional()
          .describe('Required when action is ACCEPT'),
        view: z.string().optional().describe('Optional view, e.g. "published"'),
        sendNotification: z.boolean().optional()
          .describe('Email the requester about the resolution'),
      },
    },
    async ({ account, fileId, proposalId, action, role, view, sendNotification }) => {
      try {
        const auth = await getClient(account as Account);
        const drive = google.drive({ version: 'v3', auth });
        const requestBody: any = { action };
        if (role) requestBody.role = role;
        if (view) requestBody.view = view;
        if (sendNotification !== undefined) requestBody.sendNotification = sendNotification;

        await drive.accessproposals.resolve({
          fileId,
          proposalId,
          requestBody,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ resolved: true, proposalId, action }, null, 2) }],
        };
      } catch (error: any) {
        return handleDriveError(error, account as Account);
      }
    },
  );

  // ─── Shared drives ─────────────────────────────────────────────────────

  server.registerTool(
    'drive_shared_drives_list',
    {
      description: 'List shared drives the account has access to',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        pageSize: z.number().min(1).max(100).optional(),
        pageToken: z.string().optional(),
        q: z.string().optional().describe('Optional filter expression'),
      },
    },
    async ({ account, pageSize, pageToken, q }) => {
      try {
        const auth = await getClient(account as Account);
        const drive = google.drive({ version: 'v3', auth });
        const res = await drive.drives.list({
          pageSize: pageSize ?? 50,
          pageToken,
          q,
          fields: 'nextPageToken,drives(id,name,colorRgb,createdTime,hidden)',
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        return handleDriveError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'drive_shared_drive_get',
    {
      description: 'Get metadata for a specific shared drive',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        driveId: z.string().describe('Shared drive ID'),
      },
    },
    async ({ account, driveId }) => {
      try {
        const auth = await getClient(account as Account);
        const drive = google.drive({ version: 'v3', auth });
        const res = await drive.drives.get({
          driveId,
          fields: 'id,name,colorRgb,createdTime,hidden,capabilities,restrictions',
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        return handleDriveError(error, account as Account);
      }
    },
  );

  // ─── About ─────────────────────────────────────────────────────────────

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
  return handleGoogleApiError(error, account);
}
