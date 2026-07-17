import type { ToolRegistry } from '../registry.js';
import { z } from 'zod';
import { google } from 'googleapis';
import { ACCOUNTS } from '../accounts.js';
import type { Account } from '../accounts.js';
import { getClient } from '../client.js';
import { handleGoogleApiError } from './_errors.js';
import { coerceArray, coerceBoolean, coerceJson } from './_coerce.js';
import { sliceClean } from '../trim.js';

const accountEnum = z.enum(ACCOUNTS);

const SLIDE_TEXT_DIGEST_CHARS = 200;

export function registerSlidesTools(server: ToolRegistry): void {
  server.registerTool(
    'slides_create',
    {
      description: 'Create a new Google Slides presentation (starts with one blank slide)',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        title: z.string().describe('Presentation title'),
      },
    },
    async ({ account, title }) => {
      try {
        const auth = await getClient(account as Account);
        const slides = google.slides({ version: 'v1', auth });
        const res = await slides.presentations.create({ requestBody: { title } });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            presentationId: res.data.presentationId,
            title: res.data.title,
            url: `https://docs.google.com/presentation/d/${res.data.presentationId}/edit`,
            firstSlideObjectId: res.data.slides?.[0]?.objectId,
          }, null, 2) }],
        };
      } catch (error: any) {
        return handleSlidesError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'slides_get',
    {
      description: 'Get a presentation as a compact summary (title, per-slide objectId + text digest). Pass full:true for the raw Presentation JSON (can be very large).',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        presentationId: z.string().describe('Presentation ID'),
        full: coerceBoolean.optional().describe('Return the untrimmed Presentation resource'),
      },
    },
    async ({ account, presentationId, full }) => {
      try {
        const auth = await getClient(account as Account);
        const slides = google.slides({ version: 'v1', auth });
        const res = await slides.presentations.get({ presentationId });
        const payload = full ? res.data : summarizePresentation(res.data as Record<string, any>);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
        };
      } catch (error: any) {
        return handleSlidesError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'slides_page_get',
    {
      description: 'Get the full JSON of one slide/page (all page elements with geometry and text)',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        presentationId: z.string().describe('Presentation ID'),
        pageObjectId: z.string().describe('Page object ID (from slides_get)'),
      },
    },
    async ({ account, presentationId, pageObjectId }) => {
      try {
        const auth = await getClient(account as Account);
        const slides = google.slides({ version: 'v1', auth });
        const res = await slides.presentations.pages.get({ presentationId, pageObjectId });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        return handleSlidesError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'slides_page_thumbnail',
    {
      description: 'Get a rendered thumbnail image URL for one slide (the contentUrl expires after ~30 minutes)',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        presentationId: z.string().describe('Presentation ID'),
        pageObjectId: z.string().describe('Page object ID (from slides_get)'),
        mimeType: z.enum(['PNG']).optional().describe('Thumbnail mime type (default: PNG)'),
        thumbnailSize: z.enum(['LARGE', 'MEDIUM', 'SMALL', 'WIDTH2000_PX']).optional()
          .describe('LARGE=1600px, MEDIUM=800px, SMALL=200px, WIDTH2000_PX=2000px wide (default: server-chosen)'),
      },
    },
    async ({ account, presentationId, pageObjectId, mimeType, thumbnailSize }) => {
      try {
        const auth = await getClient(account as Account);
        const slides = google.slides({ version: 'v1', auth });
        const res = await slides.presentations.pages.getThumbnail({
          presentationId,
          pageObjectId,
          'thumbnailProperties.mimeType': mimeType,
          'thumbnailProperties.thumbnailSize': thumbnailSize,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        return handleSlidesError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'slides_batch_update',
    {
      description: 'Generic presentations.batchUpdate pass-through. Accepts the full Request union (create/move/delete slides, insert text/shapes/images/tables, styling, replaceAllText, …). See https://developers.google.com/workspace/slides/api/reference/rest/v1/presentations/request',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        presentationId: z.string().describe('Presentation ID'),
        requests: coerceArray(coerceJson(z.record(z.string(), z.unknown())))
          .describe('Array of Request objects, each with one request-type key like {createSlide: {...}}'),
        writeControl: coerceJson(z.object({
          requiredRevisionId: z.string().optional(),
        }).optional()).describe('Optional optimistic concurrency control'),
      },
    },
    async ({ account, presentationId, requests, writeControl }) => {
      try {
        const auth = await getClient(account as Account);
        const slides = google.slides({ version: 'v1', auth });
        const res = await slides.presentations.batchUpdate({
          presentationId,
          requestBody: {
            requests: requests as any,
            writeControl,
          },
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            presentationId: res.data.presentationId,
            replies: res.data.replies ?? [],
          }, null, 2) }],
        };
      } catch (error: any) {
        return handleSlidesError(error, account as Account);
      }
    },
  );
}

// ─── Helpers (exported for unit tests) ───────────────────────────────────

export function extractPageText(elements: Array<Record<string, any>> | undefined): string {
  const parts: string[] = [];
  const visit = (els: Array<Record<string, any>> | undefined): void => {
    for (const el of els ?? []) {
      for (const te of el.shape?.text?.textElements ?? []) {
        const content = te.textRun?.content ?? te.autoText?.content;
        if (content) parts.push(content);
      }
      for (const row of el.table?.tableRows ?? []) {
        for (const cell of row.tableCells ?? []) {
          for (const te of cell.text?.textElements ?? []) {
            if (te.textRun?.content) parts.push(te.textRun.content);
          }
        }
      }
      visit(el.elementGroup?.children);
    }
  };
  visit(elements);
  return parts.join('').replace(/\s+/g, ' ').trim();
}

export function summarizePresentation(p: Record<string, any>): Record<string, unknown> {
  const slides = ((p.slides ?? []) as Array<Record<string, any>>).map((s, index) => {
    const text = extractPageText(s.pageElements);
    return {
      index,
      objectId: s.objectId,
      elementCount: (s.pageElements ?? []).length,
      ...(text ? { text: sliceClean(text, SLIDE_TEXT_DIGEST_CHARS) } : {}),
    };
  });
  return {
    presentationId: p.presentationId,
    title: p.title,
    revisionId: p.revisionId,
    slideCount: slides.length,
    slides,
    hint: 'Pass full:true for the raw Presentation JSON, or slides_page_get for one slide.',
  };
}

function handleSlidesError(error: any, account: Account) {
  return handleGoogleApiError(error, account, "Slides tools require the optional \"slides\" scope bundle. Add GOOGLE_OPTIONAL_SCOPES=slides (or include \"slides\" in the list) and re-auth.");
}
