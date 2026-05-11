import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { google } from 'googleapis';
import { ACCOUNTS } from '../accounts.js';
import type { Account } from '../accounts.js';
import { getClient } from '../client.js';
import { handleGoogleApiError } from './_errors.js';

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

  server.registerTool(
    'docs_get',
    {
      description: 'Get document metadata (title, revision, named ranges). Optionally include tab content and choose a suggestionsViewMode.',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        documentId: z.string().describe('Google Docs document ID'),
        includeTabsContent: z.boolean().optional()
          .describe('Include full content for every tab (default: false — first tab only)'),
        suggestionsViewMode: z.enum([
          'DEFAULT_FOR_CURRENT_ACCESS',
          'SUGGESTIONS_INLINE',
          'PREVIEW_SUGGESTIONS_ACCEPTED',
          'PREVIEW_WITHOUT_SUGGESTIONS',
        ]).optional().describe('How suggestions render in the returned body'),
      },
    },
    async ({ account, documentId, includeTabsContent, suggestionsViewMode }) => {
      try {
        const auth = await getClient(account as Account);
        const docs = google.docs({ version: 'v1', auth });
        const res = await docs.documents.get({
          documentId,
          includeTabsContent: includeTabsContent ?? false,
          suggestionsViewMode,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            documentId: res.data.documentId,
            title: res.data.title,
            revisionId: res.data.revisionId,
            namedRanges: res.data.namedRanges ?? {},
            tabs: res.data.tabs ?? undefined,
          }, null, 2) }],
        };
      } catch (error: any) {
        return handleDocsError(error, account as Account);
      }
    },
  );

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

  // ─── Named ranges (mail-merge primitive) ───────────────────────────────

  server.registerTool(
    'docs_create_named_range',
    {
      description: 'Tag a range of text with a name. Multiple ranges can share the same name. Used as a template anchor for docs_replace_named_range_content.',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        documentId: z.string().describe('Google Docs document ID'),
        name: z.string().describe('Name (1-256 chars). Need not be unique.'),
        startIndex: z.number().min(1).describe('Range start (inclusive)'),
        endIndex: z.number().min(2).describe('Range end (exclusive)'),
      },
    },
    async ({ account, documentId, name, startIndex, endIndex }) => {
      try {
        const auth = await getClient(account as Account);
        const docs = google.docs({ version: 'v1', auth });
        const res = await docs.documents.batchUpdate({
          documentId,
          requestBody: {
            requests: [{
              createNamedRange: {
                name,
                range: { startIndex, endIndex },
              },
            }],
          },
        });
        const created = (res.data.replies?.[0] as any)?.createNamedRange;
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(created ?? {}, null, 2) }],
        };
      } catch (error: any) {
        return handleDocsError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'docs_delete_named_range',
    {
      description: 'Delete a named range by its ID or by name. Removes every range matching the identifier.',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        documentId: z.string().describe('Google Docs document ID'),
        namedRangeId: z.string().optional().describe('Specific named range ID'),
        name: z.string().optional().describe('Name (deletes ALL named ranges with this name)'),
      },
    },
    async ({ account, documentId, namedRangeId, name }) => {
      try {
        if (!namedRangeId && !name) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Either namedRangeId or name must be supplied' }) }], isError: true };
        }
        const auth = await getClient(account as Account);
        const docs = google.docs({ version: 'v1', auth });
        const req: any = {};
        if (namedRangeId) req.namedRangeId = namedRangeId;
        else req.name = name;

        await docs.documents.batchUpdate({
          documentId,
          requestBody: { requests: [{ deleteNamedRange: req }] },
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ deleted: true }, null, 2) }],
        };
      } catch (error: any) {
        return handleDocsError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'docs_replace_named_range_content',
    {
      description: 'Replace the content of every named range matching the identifier with the supplied text. Real mail-merge primitive — far more robust than replaceAllText for templated docs.',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        documentId: z.string().describe('Google Docs document ID'),
        namedRangeId: z.string().optional().describe('Specific named range ID'),
        namedRangeName: z.string().optional().describe('Name to match (replaces ALL ranges with this name)'),
        text: z.string().describe('Replacement text'),
      },
    },
    async ({ account, documentId, namedRangeId, namedRangeName, text }) => {
      try {
        if (!namedRangeId && !namedRangeName) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Either namedRangeId or namedRangeName must be supplied' }) }], isError: true };
        }
        const auth = await getClient(account as Account);
        const docs = google.docs({ version: 'v1', auth });
        const req: any = { text };
        if (namedRangeId) req.namedRangeId = namedRangeId;
        else req.namedRangeName = namedRangeName;

        await docs.documents.batchUpdate({
          documentId,
          requestBody: { requests: [{ replaceNamedRangeContent: req }] },
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ replaced: true }, null, 2) }],
        };
      } catch (error: any) {
        return handleDocsError(error, account as Account);
      }
    },
  );

  // ─── Paragraph + document style ────────────────────────────────────────

  server.registerTool(
    'docs_update_paragraph_style',
    {
      description: 'Update paragraph styling (alignment, heading, indents, spacing) across a range. Only supplied fields are applied.',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        documentId: z.string().describe('Google Docs document ID'),
        startIndex: z.number().min(1),
        endIndex: z.number().min(2),
        namedStyleType: z.enum([
          'NORMAL_TEXT', 'TITLE', 'SUBTITLE',
          'HEADING_1', 'HEADING_2', 'HEADING_3', 'HEADING_4', 'HEADING_5', 'HEADING_6',
        ]).optional(),
        alignment: z.enum(['START', 'CENTER', 'END', 'JUSTIFIED']).optional(),
        lineSpacing: z.number().optional().describe('Line spacing as percent (100 = single-space)'),
        spaceAbove: z.number().optional().describe('Space above paragraph, in points'),
        spaceBelow: z.number().optional().describe('Space below paragraph, in points'),
        indentStart: z.number().optional().describe('Start indent in points'),
        indentEnd: z.number().optional().describe('End indent in points'),
        indentFirstLine: z.number().optional().describe('First-line indent in points'),
        direction: z.enum(['LEFT_TO_RIGHT', 'RIGHT_TO_LEFT']).optional(),
        keepLinesTogether: z.boolean().optional(),
        keepWithNext: z.boolean().optional(),
        avoidWidowAndOrphan: z.boolean().optional(),
      },
    },
    async ({ account, documentId, startIndex, endIndex, ...style }) => {
      try {
        const auth = await getClient(account as Account);
        const docs = google.docs({ version: 'v1', auth });
        const built = buildParagraphStyle(style);
        if (built.fields.length === 0) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'No paragraph style properties supplied' }) }], isError: true };
        }
        await docs.documents.batchUpdate({
          documentId,
          requestBody: {
            requests: [{
              updateParagraphStyle: {
                range: { startIndex, endIndex },
                paragraphStyle: built.paragraphStyle,
                fields: built.fields,
              },
            }],
          },
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ styled: true, range: { startIndex, endIndex }, applied: built.fields }, null, 2) }],
        };
      } catch (error: any) {
        return handleDocsError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'docs_update_document_style',
    {
      description: 'Update document-level styling (page size, margins, headers/footers behavior). Only supplied fields are applied.',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        documentId: z.string().describe('Google Docs document ID'),
        pageWidth: z.number().optional().describe('Page width in points (e.g. 595 = A4)'),
        pageHeight: z.number().optional().describe('Page height in points (e.g. 842 = A4)'),
        marginTop: z.number().optional().describe('Margin in points'),
        marginBottom: z.number().optional(),
        marginLeft: z.number().optional(),
        marginRight: z.number().optional(),
        marginHeader: z.number().optional(),
        marginFooter: z.number().optional(),
        pageNumberStart: z.number().optional(),
        useFirstPageHeaderFooter: z.boolean().optional(),
        useEvenPageHeaderFooter: z.boolean().optional(),
        useCustomHeaderFooterMargins: z.boolean().optional(),
      },
    },
    async ({ account, documentId, ...style }) => {
      try {
        const auth = await getClient(account as Account);
        const docs = google.docs({ version: 'v1', auth });
        const built = buildDocumentStyle(style);
        if (built.fields.length === 0) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'No document style properties supplied' }) }], isError: true };
        }
        await docs.documents.batchUpdate({
          documentId,
          requestBody: {
            requests: [{
              updateDocumentStyle: {
                documentStyle: built.documentStyle,
                fields: built.fields,
              },
            }],
          },
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ styled: true, applied: built.fields }, null, 2) }],
        };
      } catch (error: any) {
        return handleDocsError(error, account as Account);
      }
    },
  );

  // ─── Bullets ───────────────────────────────────────────────────────────

  server.registerTool(
    'docs_create_paragraph_bullets',
    {
      description: 'Turn paragraphs in a range into a bulleted or numbered list',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        documentId: z.string().describe('Google Docs document ID'),
        startIndex: z.number().min(1),
        endIndex: z.number().min(2),
        bulletPreset: z.enum([
          'BULLET_DISC_CIRCLE_SQUARE',
          'BULLET_DIAMONDX_ARROW3D_SQUARE',
          'BULLET_CHECKBOX',
          'BULLET_ARROW_DIAMOND_DISC',
          'BULLET_STAR_CIRCLE_SQUARE',
          'BULLET_ARROW3D_CIRCLE_SQUARE',
          'BULLET_LEFTTRIANGLE_DIAMOND_DISC',
          'BULLET_DIAMONDX_HOLLOWDIAMOND_SQUARE',
          'BULLET_DIAMOND_CIRCLE_SQUARE',
          'NUMBERED_DECIMAL_ALPHA_ROMAN',
          'NUMBERED_DECIMAL_ALPHA_ROMAN_PARENS',
          'NUMBERED_DECIMAL_NESTED',
          'NUMBERED_UPPERALPHA_ALPHA_ROMAN',
          'NUMBERED_UPPERROMAN_UPPERALPHA_DECIMAL',
          'NUMBERED_ZERODECIMAL_ALPHA_ROMAN',
        ]).describe('Bullet/numbering preset'),
      },
    },
    async ({ account, documentId, startIndex, endIndex, bulletPreset }) => {
      try {
        const auth = await getClient(account as Account);
        const docs = google.docs({ version: 'v1', auth });
        await docs.documents.batchUpdate({
          documentId,
          requestBody: {
            requests: [{
              createParagraphBullets: {
                range: { startIndex, endIndex },
                bulletPreset,
              },
            }],
          },
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ bulleted: true }, null, 2) }],
        };
      } catch (error: any) {
        return handleDocsError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'docs_delete_paragraph_bullets',
    {
      description: 'Strip bullet/number formatting from paragraphs in a range',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        documentId: z.string().describe('Google Docs document ID'),
        startIndex: z.number().min(1),
        endIndex: z.number().min(2),
      },
    },
    async ({ account, documentId, startIndex, endIndex }) => {
      try {
        const auth = await getClient(account as Account);
        const docs = google.docs({ version: 'v1', auth });
        await docs.documents.batchUpdate({
          documentId,
          requestBody: {
            requests: [{
              deleteParagraphBullets: {
                range: { startIndex, endIndex },
              },
            }],
          },
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ unbulleted: true }, null, 2) }],
        };
      } catch (error: any) {
        return handleDocsError(error, account as Account);
      }
    },
  );

  // ─── Inline images ─────────────────────────────────────────────────────

  server.registerTool(
    'docs_insert_inline_image',
    {
      description: 'Insert a publicly-accessible image (PNG/JPEG/GIF, <50MB, <25MP, URL <2KB) inline at an index or at the document end',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        documentId: z.string().describe('Google Docs document ID'),
        uri: z.string().url().describe('Public image URL'),
        index: z.number().min(1).optional().describe('Insert position; omit to append at the end'),
        width: z.number().optional().describe('Width in points (omit for natural size)'),
        height: z.number().optional().describe('Height in points'),
      },
    },
    async ({ account, documentId, uri, index, width, height }) => {
      try {
        const auth = await getClient(account as Account);
        const docs = google.docs({ version: 'v1', auth });
        const request: any = { uri };
        if (index !== undefined) request.location = { index };
        else request.endOfSegmentLocation = { segmentId: '' };
        if (width !== undefined || height !== undefined) {
          request.objectSize = {};
          if (width !== undefined) request.objectSize.width = { magnitude: width, unit: 'PT' };
          if (height !== undefined) request.objectSize.height = { magnitude: height, unit: 'PT' };
        }
        await docs.documents.batchUpdate({
          documentId,
          requestBody: { requests: [{ insertInlineImage: request }] },
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ inserted: true, at: index ?? 'end' }, null, 2) }],
        };
      } catch (error: any) {
        return handleDocsError(error, account as Account);
      }
    },
  );

  // ─── Breaks ────────────────────────────────────────────────────────────

  server.registerTool(
    'docs_insert_page_break',
    {
      description: 'Insert a page break at a position or at the document end',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        documentId: z.string().describe('Google Docs document ID'),
        index: z.number().min(1).optional().describe('Insert position; omit to append'),
      },
    },
    async ({ account, documentId, index }) => {
      try {
        const auth = await getClient(account as Account);
        const docs = google.docs({ version: 'v1', auth });
        const request: any = {};
        if (index !== undefined) request.location = { index };
        else request.endOfSegmentLocation = { segmentId: '' };
        await docs.documents.batchUpdate({
          documentId,
          requestBody: { requests: [{ insertPageBreak: request }] },
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ inserted: true, at: index ?? 'end' }, null, 2) }],
        };
      } catch (error: any) {
        return handleDocsError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'docs_insert_section_break',
    {
      description: 'Insert a section break at a position. CONTINUOUS keeps the same page; NEXT_PAGE starts a new page.',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        documentId: z.string().describe('Google Docs document ID'),
        index: z.number().min(1).optional(),
        sectionType: z.enum(['CONTINUOUS', 'NEXT_PAGE']).default('NEXT_PAGE').optional(),
      },
    },
    async ({ account, documentId, index, sectionType }) => {
      try {
        const auth = await getClient(account as Account);
        const docs = google.docs({ version: 'v1', auth });
        const request: any = { sectionType: sectionType ?? 'NEXT_PAGE' };
        if (index !== undefined) request.location = { index };
        else request.endOfSegmentLocation = { segmentId: '' };
        await docs.documents.batchUpdate({
          documentId,
          requestBody: { requests: [{ insertSectionBreak: request }] },
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ inserted: true, at: index ?? 'end' }, null, 2) }],
        };
      } catch (error: any) {
        return handleDocsError(error, account as Account);
      }
    },
  );

  // ─── Headers / footers ────────────────────────────────────────────────

  server.registerTool(
    'docs_create_header',
    {
      description: 'Create a header for the document or for a specific section. The new header is empty; insert text into it with docs_insert_text targeting its segmentId.',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        documentId: z.string().describe('Google Docs document ID'),
        sectionBreakIndex: z.number().min(1).optional().describe('Anchor to a specific section break; omit to apply to the document'),
      },
    },
    async ({ account, documentId, sectionBreakIndex }) => {
      try {
        const auth = await getClient(account as Account);
        const docs = google.docs({ version: 'v1', auth });
        const request: any = { type: 'DEFAULT' };
        if (sectionBreakIndex !== undefined) request.sectionBreakLocation = { index: sectionBreakIndex };
        const res = await docs.documents.batchUpdate({
          documentId,
          requestBody: { requests: [{ createHeader: request }] },
        });
        const reply = (res.data.replies?.[0] as any)?.createHeader;
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(reply ?? {}, null, 2) }],
        };
      } catch (error: any) {
        return handleDocsError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'docs_delete_header',
    {
      description: 'Delete a header by its headerId',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        documentId: z.string().describe('Google Docs document ID'),
        headerId: z.string().describe('Header ID (from docs_get or createHeader reply)'),
      },
    },
    async ({ account, documentId, headerId }) => {
      try {
        const auth = await getClient(account as Account);
        const docs = google.docs({ version: 'v1', auth });
        await docs.documents.batchUpdate({
          documentId,
          requestBody: { requests: [{ deleteHeader: { headerId } }] },
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ deleted: true, headerId }, null, 2) }],
        };
      } catch (error: any) {
        return handleDocsError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'docs_create_footer',
    {
      description: 'Create a footer for the document or a specific section',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        documentId: z.string().describe('Google Docs document ID'),
        sectionBreakIndex: z.number().min(1).optional(),
      },
    },
    async ({ account, documentId, sectionBreakIndex }) => {
      try {
        const auth = await getClient(account as Account);
        const docs = google.docs({ version: 'v1', auth });
        const request: any = { type: 'DEFAULT' };
        if (sectionBreakIndex !== undefined) request.sectionBreakLocation = { index: sectionBreakIndex };
        const res = await docs.documents.batchUpdate({
          documentId,
          requestBody: { requests: [{ createFooter: request }] },
        });
        const reply = (res.data.replies?.[0] as any)?.createFooter;
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(reply ?? {}, null, 2) }],
        };
      } catch (error: any) {
        return handleDocsError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'docs_delete_footer',
    {
      description: 'Delete a footer by its footerId',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        documentId: z.string().describe('Google Docs document ID'),
        footerId: z.string().describe('Footer ID'),
      },
    },
    async ({ account, documentId, footerId }) => {
      try {
        const auth = await getClient(account as Account);
        const docs = google.docs({ version: 'v1', auth });
        await docs.documents.batchUpdate({
          documentId,
          requestBody: { requests: [{ deleteFooter: { footerId } }] },
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ deleted: true, footerId }, null, 2) }],
        };
      } catch (error: any) {
        return handleDocsError(error, account as Account);
      }
    },
  );

  // ─── Table mutations (one tool with operation discriminator) ───────────

  server.registerTool(
    'docs_modify_table',
    {
      description: 'Mutate a table by operation: insertRow, insertColumn, deleteRow, deleteColumn, mergeCells, unmergeCells. Locate the cell with tableStartIndex (the table\'s start index in the doc) plus rowIndex/columnIndex (0-based).',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        documentId: z.string().describe('Google Docs document ID'),
        operation: z.enum(['insertRow', 'insertColumn', 'deleteRow', 'deleteColumn', 'mergeCells', 'unmergeCells']),
        tableStartIndex: z.number().min(1).describe('Start index of the table in the document'),
        rowIndex: z.number().min(0).describe('Target row (0-based)'),
        columnIndex: z.number().min(0).describe('Target column (0-based)'),
        insertBelow: z.boolean().optional().describe('insertRow only: insert below the target row (default: false)'),
        insertRight: z.boolean().optional().describe('insertColumn only: insert right of the target column (default: false)'),
        rowSpan: z.number().min(1).optional().describe('mergeCells only: how many rows the merged cell spans (default 1)'),
        columnSpan: z.number().min(1).optional().describe('mergeCells/unmergeCells: column span (default 1)'),
      },
    },
    async ({ account, documentId, operation, tableStartIndex, rowIndex, columnIndex, insertBelow, insertRight, rowSpan, columnSpan }) => {
      try {
        const auth = await getClient(account as Account);
        const docs = google.docs({ version: 'v1', auth });
        const cellLoc = {
          tableStartLocation: { index: tableStartIndex },
          rowIndex,
          columnIndex,
        };
        let request: any;
        switch (operation) {
          case 'insertRow':
            request = { insertTableRow: { tableCellLocation: cellLoc, insertBelow: insertBelow ?? false } };
            break;
          case 'insertColumn':
            request = { insertTableColumn: { tableCellLocation: cellLoc, insertRight: insertRight ?? false } };
            break;
          case 'deleteRow':
            request = { deleteTableRow: { tableCellLocation: cellLoc } };
            break;
          case 'deleteColumn':
            request = { deleteTableColumn: { tableCellLocation: cellLoc } };
            break;
          case 'mergeCells':
            request = {
              mergeTableCells: {
                tableRange: {
                  tableCellLocation: cellLoc,
                  rowSpan: rowSpan ?? 1,
                  columnSpan: columnSpan ?? 1,
                },
              },
            };
            break;
          case 'unmergeCells':
            request = {
              unmergeTableCells: {
                tableRange: {
                  tableCellLocation: cellLoc,
                  rowSpan: rowSpan ?? 1,
                  columnSpan: columnSpan ?? 1,
                },
              },
            };
            break;
        }
        await docs.documents.batchUpdate({
          documentId,
          requestBody: { requests: [request] },
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ operation, completed: true }, null, 2) }],
        };
      } catch (error: any) {
        return handleDocsError(error, account as Account);
      }
    },
  );

  // ─── Tabs ──────────────────────────────────────────────────────────────

  server.registerTool(
    'docs_add_tab',
    {
      description: 'Add a new tab to a document. Can be a top-level tab or nested as a child of an existing tab.',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        documentId: z.string().describe('Google Docs document ID'),
        title: z.string().describe('Tab title'),
        parentTabId: z.string().optional().describe('Parent tab ID (omit for top-level)'),
        index: z.number().min(0).optional().describe('Position among siblings'),
      },
    },
    async ({ account, documentId, title, parentTabId, index }) => {
      try {
        const auth = await getClient(account as Account);
        const docs = google.docs({ version: 'v1', auth });
        const tabProperties: any = { title };
        if (parentTabId) tabProperties.parentTabId = parentTabId;
        if (index !== undefined) tabProperties.index = index;
        const res = await docs.documents.batchUpdate({
          documentId,
          requestBody: { requests: [{ addDocumentTab: { tabProperties } }] },
        });
        const reply = (res.data.replies?.[0] as any)?.addDocumentTab;
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(reply ?? {}, null, 2) }],
        };
      } catch (error: any) {
        return handleDocsError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'docs_delete_tab',
    {
      description: 'Delete a tab and all of its descendant tabs',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        documentId: z.string().describe('Google Docs document ID'),
        tabId: z.string().describe('Tab ID'),
      },
    },
    async ({ account, documentId, tabId }) => {
      try {
        const auth = await getClient(account as Account);
        const docs = google.docs({ version: 'v1', auth });
        await docs.documents.batchUpdate({
          documentId,
          requestBody: { requests: [{ deleteTab: { tabId } }] },
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ deleted: true, tabId }, null, 2) }],
        };
      } catch (error: any) {
        return handleDocsError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'docs_update_tab_properties',
    {
      description: 'Rename a tab, change its position, or move it under a different parent',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        documentId: z.string().describe('Google Docs document ID'),
        tabId: z.string().describe('Tab ID'),
        title: z.string().optional(),
        index: z.number().min(0).optional(),
        parentTabId: z.string().optional(),
      },
    },
    async ({ account, documentId, tabId, title, index, parentTabId }) => {
      try {
        const auth = await getClient(account as Account);
        const docs = google.docs({ version: 'v1', auth });
        const tabProperties: any = { tabId };
        const fields: string[] = [];
        if (title !== undefined) { tabProperties.title = title; fields.push('title'); }
        if (index !== undefined) { tabProperties.index = index; fields.push('index'); }
        if (parentTabId !== undefined) { tabProperties.parentTabId = parentTabId; fields.push('parentTabId'); }
        if (fields.length === 0) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'No tab property supplied' }) }], isError: true };
        }
        await docs.documents.batchUpdate({
          documentId,
          requestBody: {
            requests: [{
              updateDocumentTabProperties: {
                tabProperties,
                fields: fields.join(','),
              },
            }],
          },
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ updated: true, tabId, applied: fields }, null, 2) }],
        };
      } catch (error: any) {
        return handleDocsError(error, account as Account);
      }
    },
  );

  // ─── Batch update escape hatch ─────────────────────────────────────────

  server.registerTool(
    'docs_batch_update',
    {
      description: 'Generic documents.batchUpdate pass-through. Accepts the full Request union (40 types). See https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/request',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        documentId: z.string().describe('Google Docs document ID'),
        requests: z.array(z.record(z.string(), z.any())).describe('Array of Request objects, each with one request-type key'),
        writeControl: z.object({
          requiredRevisionId: z.string().optional(),
          targetRevisionId: z.string().optional(),
        }).optional().describe('Optional optimistic concurrency control'),
      },
    },
    async ({ account, documentId, requests, writeControl }) => {
      try {
        const auth = await getClient(account as Account);
        const docs = google.docs({ version: 'v1', auth });
        const res = await docs.documents.batchUpdate({
          documentId,
          requestBody: {
            requests: requests as any,
            writeControl,
          },
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            documentId: res.data.documentId,
            replies: res.data.replies ?? [],
          }, null, 2) }],
        };
      } catch (error: any) {
        return handleDocsError(error, account as Account);
      }
    },
  );
}

// ─── Helpers (exported for unit tests) ───────────────────────────────────

export function buildParagraphStyle(input: {
  namedStyleType?: string;
  alignment?: string;
  lineSpacing?: number;
  spaceAbove?: number;
  spaceBelow?: number;
  indentStart?: number;
  indentEnd?: number;
  indentFirstLine?: number;
  direction?: string;
  keepLinesTogether?: boolean;
  keepWithNext?: boolean;
  avoidWidowAndOrphan?: boolean;
}): { paragraphStyle: any; fields: string } {
  const ps: any = {};
  const fields: string[] = [];
  if (input.namedStyleType) { ps.namedStyleType = input.namedStyleType; fields.push('namedStyleType'); }
  if (input.alignment) { ps.alignment = input.alignment; fields.push('alignment'); }
  if (input.lineSpacing !== undefined) { ps.lineSpacing = input.lineSpacing; fields.push('lineSpacing'); }
  if (input.spaceAbove !== undefined) { ps.spaceAbove = { magnitude: input.spaceAbove, unit: 'PT' }; fields.push('spaceAbove'); }
  if (input.spaceBelow !== undefined) { ps.spaceBelow = { magnitude: input.spaceBelow, unit: 'PT' }; fields.push('spaceBelow'); }
  if (input.indentStart !== undefined) { ps.indentStart = { magnitude: input.indentStart, unit: 'PT' }; fields.push('indentStart'); }
  if (input.indentEnd !== undefined) { ps.indentEnd = { magnitude: input.indentEnd, unit: 'PT' }; fields.push('indentEnd'); }
  if (input.indentFirstLine !== undefined) { ps.indentFirstLine = { magnitude: input.indentFirstLine, unit: 'PT' }; fields.push('indentFirstLine'); }
  if (input.direction) { ps.direction = input.direction; fields.push('direction'); }
  if (input.keepLinesTogether !== undefined) { ps.keepLinesTogether = input.keepLinesTogether; fields.push('keepLinesTogether'); }
  if (input.keepWithNext !== undefined) { ps.keepWithNext = input.keepWithNext; fields.push('keepWithNext'); }
  if (input.avoidWidowAndOrphan !== undefined) { ps.avoidWidowAndOrphan = input.avoidWidowAndOrphan; fields.push('avoidWidowAndOrphan'); }
  return { paragraphStyle: ps, fields: fields.join(',') };
}

export function buildDocumentStyle(input: {
  pageWidth?: number;
  pageHeight?: number;
  marginTop?: number;
  marginBottom?: number;
  marginLeft?: number;
  marginRight?: number;
  marginHeader?: number;
  marginFooter?: number;
  pageNumberStart?: number;
  useFirstPageHeaderFooter?: boolean;
  useEvenPageHeaderFooter?: boolean;
  useCustomHeaderFooterMargins?: boolean;
}): { documentStyle: any; fields: string } {
  const ds: any = {};
  const fields: string[] = [];
  const dim = (m: number) => ({ magnitude: m, unit: 'PT' });

  if (input.pageWidth !== undefined || input.pageHeight !== undefined) {
    ds.pageSize = {};
    if (input.pageWidth !== undefined) ds.pageSize.width = dim(input.pageWidth);
    if (input.pageHeight !== undefined) ds.pageSize.height = dim(input.pageHeight);
    fields.push('pageSize');
  }
  if (input.marginTop !== undefined) { ds.marginTop = dim(input.marginTop); fields.push('marginTop'); }
  if (input.marginBottom !== undefined) { ds.marginBottom = dim(input.marginBottom); fields.push('marginBottom'); }
  if (input.marginLeft !== undefined) { ds.marginLeft = dim(input.marginLeft); fields.push('marginLeft'); }
  if (input.marginRight !== undefined) { ds.marginRight = dim(input.marginRight); fields.push('marginRight'); }
  if (input.marginHeader !== undefined) { ds.marginHeader = dim(input.marginHeader); fields.push('marginHeader'); }
  if (input.marginFooter !== undefined) { ds.marginFooter = dim(input.marginFooter); fields.push('marginFooter'); }
  if (input.pageNumberStart !== undefined) { ds.pageNumberStart = input.pageNumberStart; fields.push('pageNumberStart'); }
  if (input.useFirstPageHeaderFooter !== undefined) { ds.useFirstPageHeaderFooter = input.useFirstPageHeaderFooter; fields.push('useFirstPageHeaderFooter'); }
  if (input.useEvenPageHeaderFooter !== undefined) { ds.useEvenPageHeaderFooter = input.useEvenPageHeaderFooter; fields.push('useEvenPageHeaderFooter'); }
  if (input.useCustomHeaderFooterMargins !== undefined) { ds.useCustomHeaderFooterMargins = input.useCustomHeaderFooterMargins; fields.push('useCustomHeaderFooterMargins'); }

  return { documentStyle: ds, fields: fields.join(',') };
}

function handleDocsError(error: any, account: Account) {
  return handleGoogleApiError(error, account);
}
