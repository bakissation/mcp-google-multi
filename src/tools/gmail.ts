import type { ToolRegistry } from '../registry.js';
import { z } from 'zod';
import { coerceArray, coerceBoolean, coerceJson } from './_coerce.js';
import { gmail as gmailClient } from '@googleapis/gmail';
import { ACCOUNTS } from '../accounts.js';
import type { Account } from '../accounts.js';
import { getClient } from '../client.js';
import { handleGoogleApiError } from './_errors.js';
import { buildReplyHeaders, composeRaw, renderMarkdown, htmlToMarkdown, HeaderInjectionError, type ComposeAttachment } from './gmail-mime.js';
import addressparser from 'nodemailer/lib/addressparser/index.js';
import { lookup as lookupMime } from 'mime-types';
import { configDir } from '../config-file.js';
import { getTokenDir } from '../accounts.js';
import { sliceClean } from '../trim.js';
import type { GmailMessageHeader, GmailMessageFull, GmailAttachment } from '../types.js';
import * as path from 'path';
import * as fs from 'fs';

const accountEnum = z.enum(ACCOUNTS).optional();

function getHeader(
  headers: { name?: string | null; value?: string | null }[] | undefined,
  name: string,
): string {
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '';
}

function collectTextParts(part: any, plain: string[], html: string[], topLevel = false): void {
  if (!part) return;
  const isAttachment = Boolean(part.filename) || Boolean(part.body?.attachmentId);
  if (!isAttachment && part.body?.data) {
    const decoded = Buffer.from(part.body.data, 'base64url').toString('utf-8');
    if (part.mimeType === 'text/html') html.push(decoded);
    // Simple (non-multipart) messages can carry any mimeType at the top level;
    // returning their raw body preserves pre-collect behavior.
    else if (part.mimeType === 'text/plain' || !part.mimeType || topLevel) plain.push(decoded);
  }
  for (const child of part.parts ?? []) {
    collectTextParts(child, plain, html);
  }
}

function decodeBody(
  payload: any,
  rawHtml = false,
): { body: string; bodyFormat: 'plain' | 'markdown' | 'html' } {
  const plain: string[] = [];
  const html: string[] = [];
  collectTextParts(payload, plain, html, true);
  // Concatenating every plain leaf keeps forwarded/mixed messages whole;
  // any plain content beats HTML because alternatives duplicate the same body.
  // A plain leaf is returned verbatim (byte-identical to v5).
  if (plain.length > 0) return { body: plain.join('\n\n'), bodyFormat: 'plain' };
  if (html.length > 0) {
    const joined = html.join('\n\n');
    if (rawHtml) return { body: joined, bodyFormat: 'html' };
    // HTML-only -> Markdown (D6). turndown failure degrades to plain text.
    const { text, ok } = htmlToMarkdown(joined);
    return { body: text, bodyFormat: ok ? 'markdown' : 'plain' };
  }
  return { body: '', bodyFormat: 'plain' };
}

function getAttachments(payload: any): GmailAttachment[] {
  const attachments: GmailAttachment[] = [];
  if (payload.filename && payload.body?.attachmentId) {
    const disposition = getHeader(payload.headers, 'Content-Disposition');
    const inline = disposition.toLowerCase().startsWith('inline')
      || getHeader(payload.headers, 'Content-ID') !== '';
    attachments.push({
      filename: payload.filename,
      attachmentId: payload.body.attachmentId,
      mimeType: payload.mimeType ?? 'application/octet-stream',
      ...(typeof payload.body.size === 'number' ? { sizeBytes: payload.body.size } : {}),
      ...(payload.partId ? { partId: payload.partId } : {}),
      ...(inline ? { inline: true } : {}),
    });
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      attachments.push(...getAttachments(part));
    }
  }
  return attachments;
}

// A8 reply auto-fill: parse an RFC 5322 address header into lowercased
// addr-specs (+ display names) using nodemailer's bundled addressparser, which
// already rides the A4 compose dep. Groups are flattened; entries without an
// address are dropped.
interface ParsedAddress { address: string; name: string }
function parseAddresses(headerValue: string): ParsedAddress[] {
  if (!headerValue) return [];
  const out: ParsedAddress[] = [];
  const walk = (entries: any[]): void => {
    for (const e of entries) {
      if (e?.group) walk(e.group);
      else if (e?.address) out.push({ address: String(e.address).trim(), name: String(e.name ?? '').trim() });
    }
  };
  walk(addressparser(headerValue));
  return out;
}
const normAddr = (a: string): string => a.trim().toLowerCase();
/** Rebuild a comma-separated address header; composeRaw/MailComposer re-encodes
 * names (RFC 2047) and the A4 CRLF pre-check applies, so derived recipients get
 * the same header-injection guard as caller-supplied ones. */
function formatAddresses(list: ParsedAddress[]): string {
  return list.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(', ');
}

/** Re: prefix unless the subject already carries one (case-insensitive, after
 * trimming); never double-prefix. */
export function deriveReplySubject(sourceSubject: string): string {
  const s = sourceSubject.trim();
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}

// The account's own-address set (primary + Gmail send-as aliases) used to
// exclude the caller from reply-all. Send-as rarely changes, so memoize per
// process; a stale miss only costs one extra self-copy, never a wrong send.
const ownAddressCache = new Map<string, Promise<Set<string>>>();
function getOwnAddresses(gmail: any, account: string, primaryEmail: string): Promise<Set<string>> {
  let cached = ownAddressCache.get(account);
  if (!cached) {
    cached = (async () => {
      const set = new Set<string>([normAddr(primaryEmail)]);
      try {
        const res = await gmail.users.settings.sendAs.list({ userId: 'me' });
        for (const entry of res.data.sendAs ?? []) {
          if (entry.sendAsEmail) set.add(normAddr(entry.sendAsEmail));
        }
      } catch {
        // insufficient_scope / 5xx: degrade to the primary alone, never block the send.
      }
      return set;
    })();
    ownAddressCache.set(account, cached);
  }
  return cached;
}

interface ReplyDerivation {
  inReplyTo: string;
  references: string;
  sourceFound: boolean;
  to?: string;
  cc?: string;
  subject?: string;
}

/** Fetch the reply source once and derive threading headers plus (auto-fill)
 * to/cc/subject. On any fetch failure, degrade to the API id for threading and
 * report sourceFound:false so the caller can decide (per A8 error dispositions). */
export async function resolveReply(
  gmail: any,
  account: string,
  primaryEmail: string,
  replyToMessageId: string,
  replyAll: boolean,
): Promise<ReplyDerivation> {
  let headers: any[] | undefined;
  try {
    const meta = await gmail.users.messages.get({
      userId: 'me',
      id: replyToMessageId,
      format: 'metadata',
      metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Message-ID', 'References'],
    });
    headers = meta.data.payload?.headers;
  } catch {
    // Degrade to the API id (pre-lookup behavior) rather than blocking the send.
    return { inReplyTo: replyToMessageId, references: replyToMessageId, sourceFound: false };
  }

  const threading = buildReplyHeaders(
    replyToMessageId,
    getHeader(headers, 'Message-ID'),
    getHeader(headers, 'References'),
  );

  const own = await getOwnAddresses(gmail, account, primaryEmail);
  const fromList = parseAddresses(getHeader(headers, 'From'));
  const toList = parseAddresses(getHeader(headers, 'To'));
  const ccList = parseAddresses(getHeader(headers, 'Cc'));

  // Replying to your own sent mail: From is self, so reply to the original To.
  const fromIsSelf = fromList.length > 0 && fromList.every((a) => own.has(normAddr(a.address)));
  const derivedToList = fromIsSelf ? toList : fromList;
  const derivedTo = formatAddresses(derivedToList);

  let derivedCc: string | undefined;
  if (replyAll) {
    const toAddrs = new Set(derivedToList.map((a) => normAddr(a.address)));
    const seen = new Set<string>();
    const ccOut: ParsedAddress[] = [];
    for (const a of [...toList, ...ccList]) {
      const key = normAddr(a.address);
      if (own.has(key) || toAddrs.has(key) || seen.has(key)) continue;
      seen.add(key);
      ccOut.push(a);
    }
    if (ccOut.length > 0) derivedCc = formatAddresses(ccOut);
  }

  return {
    ...threading,
    sourceFound: true,
    to: derivedTo || undefined,
    cc: derivedCc,
    subject: deriveReplySubject(getHeader(headers, 'Subject')),
  };
}

const BODY_CAP_CHARS = 50_000;
// Gmail's messages.send raw/JSON path rejects messages near ~25 MB (the wire
// message is base64-encoded, ~+33% over the raw bytes), so cap the ESTIMATED
// ENCODED total there rather than the spec's nominal 35 MB raw (spike/live
// correction — a 35 MB raw payload is ~47 MB on the wire and Gmail 400s it).
const GMAIL_MAX_MESSAGE_BYTES = 25 * 1024 * 1024;
const estimateEncoded = (rawBytes: number) => Math.ceil((rawBytes * 4) / 3);

const attachmentSchema = z
  .array(
    z.object({
      path: z.string().describe('Absolute local path to the file to attach'),
      filename: z.string().optional().describe('MIME filename; defaults to the path basename'),
      contentType: z.string().optional().describe('MIME type; defaults to a lookup on the filename'),
    }),
  )
  .optional()
  .describe('Files to attach (each { path, filename?, contentType? }); path must be absolute');

/** Reads attachment files into buffers (THIS server reads them, never
 * MailComposer), enforces absolute-path + total-size guards, and derives the
 * MIME filename via basename so a caller name can't inject path separators. */
// Deny reading anything inside the server's own secret dirs — mailing out
// master.key / <alias>.enc / mcp-jwt.key would be a full-account-takeover
// exfil channel (this same server also reads untrusted mail/drive content, so
// a prompt-injected attach path is a real confused-deputy vector).
function isInside(dir: string, target: string): boolean {
  let d = path.resolve(dir);
  let t = path.resolve(target);
  // Windows path comparison is case-insensitive; without folding, a
  // drive-letter/casing difference makes path.relative report "outside".
  if (process.platform === 'win32') {
    d = d.toLowerCase();
    t = t.toLowerCase();
  }
  const rel = path.relative(d, t);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Deny if realTarget resolves inside `dir` (both realpath'd so a symlinked
 * dir or 8.3/extended-prefix form can't slip past). */
async function isInsideRealDir(dir: string, realTarget: string): Promise<boolean> {
  let realDir: string;
  try {
    realDir = await fs.promises.realpath(dir);
  } catch {
    return false; // dir does not exist → target cannot be inside it
  }
  return isInside(realDir, realTarget);
}

export async function readAttachments(
  raw: Array<{ path: string; filename?: string; contentType?: string }> | undefined,
  bodyBytes: number,
): Promise<ComposeAttachment[] | undefined> {
  if (!raw || raw.length === 0) return undefined;
  const denied = [configDir(), getTokenDir()];
  const out: ComposeAttachment[] = [];
  let total = bodyBytes;
  for (const a of raw) {
    if (!path.isAbsolute(a.path)) {
      throw new GmailComposeError('validation_error', `attachment path must be absolute: ${path.basename(a.path)}`);
    }
    // Resolve symlinks BEFORE any confinement check, or a symlink defeats it.
    let real: string;
    try {
      real = await fs.promises.realpath(a.path);
    } catch {
      throw new GmailComposeError('E_ATTACHMENT_NOT_FOUND', `attachment not found or unreadable: ${path.basename(a.path)}`);
    }
    for (const d of denied) {
      if (await isInsideRealDir(d, real)) {
        throw new GmailComposeError('E_ATTACHMENT_FORBIDDEN', `refusing to attach a file inside the server's config/token directory: ${path.basename(a.path)}`);
      }
    }
    // stat BEFORE read: reject non-regular files (a FIFO would block readFile
    // forever) and over-cap files without buffering them.
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(real);
    } catch {
      throw new GmailComposeError('E_ATTACHMENT_NOT_FOUND', `attachment not found or unreadable: ${path.basename(a.path)}`);
    }
    if (!stat.isFile()) {
      throw new GmailComposeError('validation_error', `attachment is not a regular file: ${path.basename(a.path)}`);
    }
    total += stat.size;
    if (estimateEncoded(total) > GMAIL_MAX_MESSAGE_BYTES) {
      throw new GmailComposeError('E_ATTACHMENT_TOO_LARGE', `attachments + body exceed Gmail's ~${Math.round(GMAIL_MAX_MESSAGE_BYTES / 1024 / 1024)}MB message limit once encoded (estimated ${Math.round(estimateEncoded(total) / 1024 / 1024)}MB)`);
    }
    const content = await fs.promises.readFile(real);
    const filename = path.basename(a.filename ?? a.path);
    out.push({
      filename,
      content,
      contentType: a.contentType || lookupMime(filename) || 'application/octet-stream',
    });
  }
  return out;
}

/** Tagged compose-time failure; the handlers map it to an isError envelope.
 * `category` is the taxonomy error field (default validation_error); reply
 * auto-fill raises it as not_found when a source message can't be fetched. */
class GmailComposeError extends Error {
  constructor(public slug: string, message: string, public category: string = 'validation_error') {
    super(message);
  }
}

/** Maps compose-time (non-Google) failures to an isError envelope;
 * returns null for anything else so the Google error mapper handles it. */
function composeErrorResult(error: unknown, account: Account) {
  const slug =
    error instanceof HeaderInjectionError ? 'E_HEADER_INJECTION'
    : error instanceof GmailComposeError ? error.slug
    : null;
  if (!slug) return null;
  const category = error instanceof GmailComposeError ? error.category : 'validation_error';
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({ error: category, slug, message: (error as Error).message, retriable: false, account }),
    }],
    isError: true,
  };
}

export function parseMessage(
  msg: any,
  bodyCap?: number,
  opts?: { rawHtml?: boolean },
): GmailMessageFull {
  const headers = msg.payload?.headers ?? [];
  const { body, bodyFormat } = decodeBody(msg.payload, opts?.rawHtml === true);
  const capped = bodyCap !== undefined && body.length > bodyCap;
  const messageIdHeader = getHeader(headers, 'Message-ID');
  const inReplyTo = getHeader(headers, 'In-Reply-To');
  const references = getHeader(headers, 'References');
  return {
    id: msg.id ?? '',
    threadId: msg.threadId ?? '',
    subject: getHeader(headers, 'Subject'),
    from: getHeader(headers, 'From'),
    to: getHeader(headers, 'To'),
    cc: getHeader(headers, 'Cc'),
    date: getHeader(headers, 'Date'),
    body: capped ? sliceClean(body, bodyCap) : body,
    bodyFormat,
    ...(capped ? { bodyTruncated: true, bodyTotalChars: body.length } : {}),
    ...(messageIdHeader ? { messageIdHeader } : {}),
    ...(inReplyTo ? { inReplyTo } : {}),
    ...(references ? { references } : {}),
    ...(msg.labelIds ? { labelIds: msg.labelIds } : {}),
    ...(msg.internalDate ? { internalDate: msg.internalDate } : {}),
    attachments: getAttachments(msg.payload),
  };
}

export function registerGmailTools(server: ToolRegistry): void {
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
        const gmail = gmailClient({ version: 'v1', auth });

        const listRes = await gmail.users.messages.list({
          userId: 'me',
          q: query,
          maxResults: maxResults ?? 20,
        });

        const messages = listRes.data.messages ?? [];
        const results: GmailMessageHeader[] = [];

        // Bounded parallelism: chunked Promise.all keeps order and avoids
        // hammering the per-user quota with an unbounded fan-out.
        const CHUNK_SIZE = 10;
        for (let i = 0; i < messages.length; i += CHUNK_SIZE) {
          const details = await Promise.all(
            messages.slice(i, i + CHUNK_SIZE).map((m) => gmail.users.messages.get({
              userId: 'me',
              id: m.id!,
              format: 'metadata',
              metadataHeaders: ['From', 'To', 'Subject', 'Date'],
            })),
          );
          for (const detail of details) {
            results.push({
              id: detail.data.id ?? '',
              threadId: detail.data.threadId ?? '',
              subject: getHeader(detail.data.payload?.headers, 'Subject'),
              from: getHeader(detail.data.payload?.headers, 'From'),
              to: getHeader(detail.data.payload?.headers, 'To'),
              date: getHeader(detail.data.payload?.headers, 'Date'),
              snippet: detail.data.snippet ?? '',
              labelIds: detail.data.labelIds ?? [],
            });
          }
        }

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }],
        };
      } catch (error: any) {
        const mapped = composeErrorResult(error, account as Account);
        return mapped ?? handleGmailError(error, account as Account);
      }
    },
  );
  server.registerTool(
    'gmail_read',
    {
      _meta: { 'anthropic/maxResultSizeChars': 50_000 },
      description: 'Read a full Gmail message by ID (body capped at 50k chars unless full=true)',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        messageId: z.string().describe('Gmail message ID'),
        full: coerceBoolean.optional().describe('Return the entire body without the character cap'),
        rawHtml: coerceBoolean.optional()
          .describe('Return the HTML body unconverted instead of the plain-text rendering (HTML-only messages)'),
      },
    },
    async ({ account, messageId, full, rawHtml }) => {
      try {
        const auth = await getClient(account as Account);
        const gmail = gmailClient({ version: 'v1', auth });

        const res = await gmail.users.messages.get({
          userId: 'me',
          id: messageId,
          format: 'full',
        });

        const result = parseMessage(res.data, full ? undefined : BODY_CAP_CHARS, { rawHtml });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error: any) {
        const mapped = composeErrorResult(error, account as Account);
        return mapped ?? handleGmailError(error, account as Account);
      }
    },
  );
  server.registerTool(
    'gmail_read_thread',
    {
      _meta: { 'anthropic/maxResultSizeChars': 50_000 },
      description: 'Read all messages in a Gmail thread (bodies capped at 50k chars each unless full=true). mode=summary returns headers + snippets only.',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        threadId: z.string().describe('Gmail thread ID'),
        full: coerceBoolean.optional().describe('Return entire bodies without the character cap'),
        rawHtml: coerceBoolean.optional()
          .describe('Return HTML bodies unconverted instead of the plain-text rendering (HTML-only messages)'),
        mode: z.enum(['full', 'summary']).default('full')
          .describe('full = complete bodies; summary = per-message headers and snippet only'),
      },
    },
    async ({ account, threadId, full, rawHtml, mode }) => {
      try {
        const auth = await getClient(account as Account);
        const gmail = gmailClient({ version: 'v1', auth });

        if (mode === 'summary') {
          const res = await gmail.users.threads.get({
            userId: 'me',
            id: threadId,
            format: 'metadata',
            metadataHeaders: ['From', 'To', 'Subject', 'Date', 'Message-ID'],
          });
          const summaries = (res.data.messages ?? []).map((m) => ({
            id: m.id ?? '',
            from: getHeader(m.payload?.headers, 'From'),
            to: getHeader(m.payload?.headers, 'To'),
            subject: getHeader(m.payload?.headers, 'Subject'),
            date: getHeader(m.payload?.headers, 'Date'),
            snippet: m.snippet ?? '',
            labelIds: m.labelIds ?? [],
          }));
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(summaries, null, 2) }],
          };
        }

        const res = await gmail.users.threads.get({
          userId: 'me',
          id: threadId,
          format: 'full',
        });

        const messages = (res.data.messages ?? []).map((m) => parseMessage(m, full ? undefined : BODY_CAP_CHARS, { rawHtml }));
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(messages, null, 2) }],
        };
      } catch (error: any) {
        const mapped = composeErrorResult(error, account as Account);
        return mapped ?? handleGmailError(error, account as Account);
      }
    },
  );
  server.registerTool(
    'gmail_send',
    {
      description: 'Send an email from a Gmail account',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        to: z.string().optional().describe('Recipient(s), comma-separated. Optional when replyToMessageId is set (derived from the source); a supplied value wins.'),
        subject: z.string().optional().describe('Email subject. Optional when replyToMessageId is set (derived as "Re: ..."); a supplied value wins.'),
        body: z.string().describe('Email body as Markdown (headings, links, lists, tables, blockquotes). Rendered to HTML for the rich part; the Markdown source is the plain-text part.'),
        htmlBody: z.string().optional()
          .describe('REMOVED in v6: author Markdown in `body` instead; for literal HTML (e.g. inline color) pass `allowRawHtml: true`. Passing htmlBody now errors.'),
        allowRawHtml: z.boolean().optional()
          .describe('When true, raw HTML in `body` passes through into the HTML part instead of being escaped. Default false (HTML is shown literally).'),
        cc: z.string().optional().describe('CC recipients, comma-separated. With replyToMessageId + replyAll, derived from the source minus your own addresses; a supplied value wins.'),
        replyToMessageId: z.string().optional()
          .describe('Message ID to reply to. Sets In-Reply-To/References and, unless overridden, derives to/subject (and cc when replyAll) from the source, so you need not read it first.'),
        replyAll: coerceBoolean.optional()
          .describe('With replyToMessageId: include the source To+Cc (minus your own addresses) in cc. Default false (reply to sender only).'),
        replyToThreadId: z.string().optional()
          .describe('Thread ID to send the message in'),
        attachments: coerceJson(attachmentSchema),
      },
    },
    async ({ account, to, subject, body, htmlBody, allowRawHtml, cc, replyToMessageId, replyAll, replyToThreadId, attachments }) => {
      try {
        const auth = await getClient(account as Account);
        const gmail = gmailClient({ version: 'v1', auth });
        const config = (await import('../accounts.js')).getAccountSet().configs[account as Account];

        if (htmlBody !== undefined) {
          throw new GmailComposeError('E_HTMLBODY_REMOVED', 'htmlBody was removed in v6: author Markdown in `body`; for literal HTML pass `allowRawHtml: true`.');
        }
        const reply = replyToMessageId
          ? await resolveReply(gmail, account as Account, config.email, replyToMessageId, replyAll === true)
          : undefined;
        // Caller value > derived value. A missing source with no caller `to`
        // means we cannot address the reply: fail rather than silently drop it.
        if (reply && !reply.sourceFound && to === undefined) {
          throw new GmailComposeError('E_REPLY_SOURCE_NOT_FOUND', `reply source message ${replyToMessageId} not found; recipients could not be derived and no \`to\` was provided.`, 'not_found');
        }
        const finalTo = to ?? reply?.to;
        const finalSubject = subject ?? reply?.subject;
        const finalCc = cc ?? reply?.cc;
        if (finalTo === undefined || finalTo === '') {
          throw new GmailComposeError('E_MISSING_RECIPIENT', '`to` is required (or set replyToMessageId to derive it from the source).');
        }
        if (finalSubject === undefined) {
          throw new GmailComposeError('E_MISSING_SUBJECT', '`subject` is required (or set replyToMessageId to derive it from the source).');
        }
        const html = renderMarkdown(body, allowRawHtml === true);
        const files = await readAttachments(
          attachments as Array<{ path: string; filename?: string; contentType?: string }> | undefined,
          Buffer.byteLength(body ?? '') + Buffer.byteLength(html),
        );
        const encoded = await composeRaw({
          from: config.email,
          to: finalTo,
          subject: finalSubject,
          text: body,
          html,
          cc: finalCc,
          inReplyTo: reply?.inReplyTo,
          references: reply?.references,
          attachments: files,
        });

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
        const mapped = composeErrorResult(error, account as Account);
        return mapped ?? handleGmailError(error, account as Account);
      }
    },
  );
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
        const gmail = gmailClient({ version: 'v1', auth });

        const res = await gmail.users.messages.attachments.get({
          userId: 'me',
          messageId,
          id: attachmentId,
        });

        const data = res.data.data;
        if (!data) throw new Error('No attachment data returned');

        const buffer = Buffer.from(data, 'base64url');
        // Strip path components so callers can't escape savePath via "../".
        const fullPath = path.join(savePath, path.basename(filename));
        await fs.promises.writeFile(fullPath, buffer, { mode: 0o600 });

        return {
          content: [{ type: 'text' as const, text: `Saved to ${fullPath} (${buffer.length} bytes)` }],
        };
      } catch (error: any) {
        const mapped = composeErrorResult(error, account as Account);
        return mapped ?? handleGmailError(error, account as Account);
      }
    },
  );
  server.registerTool(
    'gmail_create_draft',
    {
      description: 'Create a Gmail draft without sending',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        to: z.string().optional().describe('Recipient(s), comma-separated. Optional when replyToMessageId is set (derived from the source); a supplied value wins.'),
        subject: z.string().optional().describe('Email subject. Optional when replyToMessageId is set (derived as "Re: ..."); a supplied value wins.'),
        body: z.string().describe('Email body as Markdown (headings, links, lists, tables, blockquotes). Rendered to HTML for the rich part; the Markdown source is the plain-text part.'),
        htmlBody: z.string().optional()
          .describe('REMOVED in v6: author Markdown in `body` instead; for literal HTML (e.g. inline color) pass `allowRawHtml: true`. Passing htmlBody now errors.'),
        allowRawHtml: z.boolean().optional()
          .describe('When true, raw HTML in `body` passes through into the HTML part instead of being escaped. Default false (HTML is shown literally).'),
        cc: z.string().optional().describe('CC recipients, comma-separated. With replyToMessageId + replyAll, derived from the source minus your own addresses; a supplied value wins.'),
        replyToMessageId: z.string().optional()
          .describe('Message ID to reply to. Sets In-Reply-To/References and, unless overridden, derives to/subject (and cc when replyAll) from the source, so you need not read it first.'),
        replyAll: coerceBoolean.optional()
          .describe('With replyToMessageId: include the source To+Cc (minus your own addresses) in cc. Default false (reply to sender only).'),
        replyToThreadId: z.string().optional()
          .describe('Thread ID to associate the draft with'),
        attachments: coerceJson(attachmentSchema),
      },
    },
    async ({ account, to, subject, body, htmlBody, allowRawHtml, cc, replyToMessageId, replyAll, replyToThreadId, attachments }) => {
      try {
        const auth = await getClient(account as Account);
        const gmail = gmailClient({ version: 'v1', auth });
        const config = (await import('../accounts.js')).getAccountSet().configs[account as Account];

        if (htmlBody !== undefined) {
          throw new GmailComposeError('E_HTMLBODY_REMOVED', 'htmlBody was removed in v6: author Markdown in `body`; for literal HTML pass `allowRawHtml: true`.');
        }
        const reply = replyToMessageId
          ? await resolveReply(gmail, account as Account, config.email, replyToMessageId, replyAll === true)
          : undefined;
        if (reply && !reply.sourceFound && to === undefined) {
          throw new GmailComposeError('E_REPLY_SOURCE_NOT_FOUND', `reply source message ${replyToMessageId} not found; recipients could not be derived and no \`to\` was provided.`, 'not_found');
        }
        const finalTo = to ?? reply?.to;
        const finalSubject = subject ?? reply?.subject;
        const finalCc = cc ?? reply?.cc;
        if (finalTo === undefined || finalTo === '') {
          throw new GmailComposeError('E_MISSING_RECIPIENT', '`to` is required (or set replyToMessageId to derive it from the source).');
        }
        if (finalSubject === undefined) {
          throw new GmailComposeError('E_MISSING_SUBJECT', '`subject` is required (or set replyToMessageId to derive it from the source).');
        }
        const html = renderMarkdown(body, allowRawHtml === true);
        const files = await readAttachments(
          attachments as Array<{ path: string; filename?: string; contentType?: string }> | undefined,
          Buffer.byteLength(body ?? '') + Buffer.byteLength(html),
        );
        const encoded = await composeRaw({
          from: config.email,
          to: finalTo,
          subject: finalSubject,
          text: body,
          html,
          cc: finalCc,
          inReplyTo: reply?.inReplyTo,
          references: reply?.references,
          attachments: files,
        });

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
        const mapped = composeErrorResult(error, account as Account);
        return mapped ?? handleGmailError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'gmail_modify_labels',
    {
      description: 'Add or remove labels on a Gmail message. Use system label IDs like STARRED, UNREAD, INBOX, TRASH, or custom label IDs from gmail_list_labels.',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        messageId: z.string().describe('Gmail message ID'),
        addLabelIds: coerceArray(z.string()).optional().describe('Label IDs to add'),
        removeLabelIds: coerceArray(z.string()).optional().describe('Label IDs to remove'),
      },
    },
    async ({ account, messageId, addLabelIds, removeLabelIds }) => {
      try {
        const auth = await getClient(account as Account);
        const gmail = gmailClient({ version: 'v1', auth });
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
        const mapped = composeErrorResult(error, account as Account);
        return mapped ?? handleGmailError(error, account as Account);
      }
    },
  );

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
        const gmail = gmailClient({ version: 'v1', auth });
        const res = await gmail.users.messages.trash({ userId: 'me', id: messageId });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        const mapped = composeErrorResult(error, account as Account);
        return mapped ?? handleGmailError(error, account as Account);
      }
    },
  );

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
        const gmail = gmailClient({ version: 'v1', auth });
        await gmail.users.messages.delete({ userId: 'me', id: messageId });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ deleted: true, messageId }, null, 2) }],
        };
      } catch (error: any) {
        const mapped = composeErrorResult(error, account as Account);
        return mapped ?? handleGmailError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'gmail_batch_modify',
    {
      description: 'Add/remove labels across up to 1000 Gmail messages at once. Useful for bulk archiving, marking as read, etc.',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        messageIds: coerceArray(z.string()).describe('Message IDs (up to 1000)'),
        addLabelIds: coerceArray(z.string()).optional().describe('Label IDs to add'),
        removeLabelIds: coerceArray(z.string()).optional().describe('Label IDs to remove'),
      },
    },
    async ({ account, messageIds, addLabelIds, removeLabelIds }) => {
      try {
        const auth = await getClient(account as Account);
        const gmail = gmailClient({ version: 'v1', auth });
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
        const mapped = composeErrorResult(error, account as Account);
        return mapped ?? handleGmailError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'gmail_batch_delete',
    {
      description: 'Permanently delete multiple Gmail messages. Irreversible.',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        messageIds: coerceArray(z.string()).describe('Message IDs (up to 1000)'),
      },
    },
    async ({ account, messageIds }) => {
      try {
        const auth = await getClient(account as Account);
        const gmail = gmailClient({ version: 'v1', auth });
        await gmail.users.messages.batchDelete({
          userId: 'me',
          requestBody: { ids: messageIds },
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ deleted: messageIds.length }, null, 2) }],
        };
      } catch (error: any) {
        const mapped = composeErrorResult(error, account as Account);
        return mapped ?? handleGmailError(error, account as Account);
      }
    },
  );

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
        const gmail = gmailClient({ version: 'v1', auth });
        const res = await gmail.users.drafts.list({
          userId: 'me',
          maxResults: maxResults ?? 20,
          q: query,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data.drafts ?? [], null, 2) }],
        };
      } catch (error: any) {
        const mapped = composeErrorResult(error, account as Account);
        return mapped ?? handleGmailError(error, account as Account);
      }
    },
  );

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
        const gmail = gmailClient({ version: 'v1', auth });
        const res = await gmail.users.drafts.get({
          userId: 'me',
          id: draftId,
          format: 'full',
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        const mapped = composeErrorResult(error, account as Account);
        return mapped ?? handleGmailError(error, account as Account);
      }
    },
  );

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
        const gmail = gmailClient({ version: 'v1', auth });
        const res = await gmail.users.drafts.send({
          userId: 'me',
          requestBody: { id: draftId },
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        const mapped = composeErrorResult(error, account as Account);
        return mapped ?? handleGmailError(error, account as Account);
      }
    },
  );

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
        const gmail = gmailClient({ version: 'v1', auth });
        const res = await gmail.users.labels.list({ userId: 'me' });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data.labels ?? [], null, 2) }],
        };
      } catch (error: any) {
        const mapped = composeErrorResult(error, account as Account);
        return mapped ?? handleGmailError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'gmail_create_label',
    {
      description: 'Create a new custom Gmail label',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        name: z.string().describe('Label name, e.g. "Work/Projects" (nested labels use "/")'),
        messageListVisibility: z.enum(['show', 'hide']).optional()
          .describe('Whether messages with this label show in message list (default: show)'),
        labelListVisibility: z.enum(['labelShow', 'labelShowIfUnread', 'labelHide']).optional()
          .describe('Whether the label appears in the label list (default: labelShow)'),
      },
    },
    async ({ account, name, messageListVisibility, labelListVisibility }) => {
      try {
        const auth = await getClient(account as Account);
        const gmail = gmailClient({ version: 'v1', auth });
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
        const mapped = composeErrorResult(error, account as Account);
        return mapped ?? handleGmailError(error, account as Account);
      }
    },
  );

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
        const gmail = gmailClient({ version: 'v1', auth });
        await gmail.users.labels.delete({ userId: 'me', id: labelId });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ deleted: true, labelId }, null, 2) }],
        };
      } catch (error: any) {
        const mapped = composeErrorResult(error, account as Account);
        return mapped ?? handleGmailError(error, account as Account);
      }
    },
  );

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
        const gmail = gmailClient({ version: 'v1', auth });
        const res = await gmail.users.getProfile({ userId: 'me' });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        const mapped = composeErrorResult(error, account as Account);
        return mapped ?? handleGmailError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'gmail_list_history',
    {
      description: 'Get all mailbox changes since a given historyId. Useful for detecting new emails since last check.',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        startHistoryId: z.string().describe('History ID from a previous gmail_get_profile or gmail_read response'),
        maxResults: z.number().min(1).max(500).default(100).optional()
          .describe('Max results to return (default: 100)'),
        historyTypes: coerceArray(z.enum(['messageAdded', 'messageDeleted', 'labelAdded', 'labelRemoved'])).optional()
          .describe('Filter by history event types'),
      },
    },
    async ({ account, startHistoryId, maxResults, historyTypes }) => {
      try {
        const auth = await getClient(account as Account);
        const gmail = gmailClient({ version: 'v1', auth });
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
        const mapped = composeErrorResult(error, account as Account);
        return mapped ?? handleGmailError(error, account as Account);
      }
    },
  );

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
        const gmail = gmailClient({ version: 'v1', auth });
        const res = await gmail.users.settings.getVacation({ userId: 'me' });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        const mapped = composeErrorResult(error, account as Account);
        return mapped ?? handleGmailError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'gmail_set_vacation',
    {
      description: 'Enable or disable Gmail vacation responder with a custom message',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        enableAutoReply: coerceBoolean.describe('Whether to enable the vacation responder'),
        responseSubject: z.string().optional().describe('Subject line for auto-reply'),
        responseBodyPlainText: z.string().optional().describe('Plain text body for auto-reply'),
        startTime: z.string().optional().describe('Start time as Unix timestamp in ms'),
        endTime: z.string().optional().describe('End time as Unix timestamp in ms'),
        restrictToContacts: coerceBoolean.optional().describe('Only reply to contacts (default: false)'),
        restrictToDomain: coerceBoolean.optional().describe('Only reply to same domain (default: false)'),
      },
    },
    async ({ account, enableAutoReply, responseSubject, responseBodyPlainText, startTime, endTime, restrictToContacts, restrictToDomain }) => {
      try {
        const auth = await getClient(account as Account);
        const gmail = gmailClient({ version: 'v1', auth });
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
        const mapped = composeErrorResult(error, account as Account);
        return mapped ?? handleGmailError(error, account as Account);
      }
    },
  );
}

function handleGmailError(error: any, account: Account) {
  return handleGoogleApiError(error, account);
}
