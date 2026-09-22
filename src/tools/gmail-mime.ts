import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type Mail from 'nodemailer/lib/mailer/index.js';
import MarkdownIt from 'markdown-it';
import TurndownService from 'turndown';
// @ts-expect-error turndown-plugin-gfm ships no type declarations
import { gfm } from 'turndown-plugin-gfm';
import type { Plugin } from 'turndown';

// D6 send: one symmetric text format. body is Markdown; text/plain = the
// source verbatim, text/html = this render. html:false ESCAPES raw HTML in
// the body (the XSS-safe default); allowRawHtml swaps to the html:true
// instance so an audited caller can pass literal HTML (e.g. inline color).
const mdSafe = new MarkdownIt({ html: false, linkify: true });
const mdRaw = new MarkdownIt({ html: true, linkify: true });

export function renderMarkdown(body: string, allowRawHtml = false): string {
  return (allowRawHtml ? mdRaw : mdSafe).render(body);
}

/** RFC 5322 §2.3 forbids bare CR or LF in bodies; normalize everything to CRLF. */
export function normalizeBodyLineEndings(body: string): string {
  return body.replace(/\r\n|\r|\n/g, '\r\n');
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function codePointToChar(code: number, fallback: string): string {
  if (Number.isNaN(code) || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return fallback;
  return String.fromCodePoint(code);
}

function decodeEntities(text: string): string {
  return text.replace(
    /&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z][a-zA-Z0-9]*));/g,
    (match, dec, hex, named) => {
      if (dec) return codePointToChar(parseInt(dec, 10), match);
      if (hex) return codePointToChar(parseInt(hex, 16), match);
      return NAMED_ENTITIES[named.toLowerCase()] ?? match;
    },
  );
}

// Fixpoint tag strip: one pass can reassemble a tag from a removed span's
// edges (<scr<b>ipt> -> <script>).
function stripTags(input: string, replacement = ''): string {
  let out = input;
  for (let previous = ''; previous !== out; ) {
    previous = out;
    out = out.replace(/<[^>]*>/g, replacement);
  }
  return out;
}

/** Best-effort HTML→plain-text for HTML-only emails; regex on purpose (avoids an HTML-parser dep, mail HTML is flat enough). */
export function htmlToText(html: string): string {
  // Repeat until stable: single-pass removal can leave behind sequences
  // reassembled from the removed span's edges (<scr<script>ipt>).
  let text = html;
  for (let previous = ''; previous !== text; ) {
    previous = text;
    text = text
      // --!> is a valid comment terminator per WHATWG
      .replace(/<!--[\s\S]*?--!?>/g, '')
      // an unterminated comment consumes the rest of the document per spec
      .replace(/<!--[\s\S]*$/, '')
      .replace(/<(style|script|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  }
  // All comment content is gone; drop any stray bare delimiters too.
  text = text.replace(/<!--|--!?>/g, '');
  // Source whitespace (incl. newlines) is insignificant in HTML; real line
  // structure is reintroduced from block tags below.
  text = text.replace(/\s+/g, ' ');

  text = text.replace(
    /<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a\s*>/gi,
    (_match, dq, sq, inner) => {
      const href = (dq ?? sq ?? '').trim();
      const innerText = stripTags(inner, ' ').replace(/\s+/g, ' ').trim();
      const redundant =
        href === '' ||
        href.startsWith('#') ||
        href === innerText ||
        href === `mailto:${innerText}`;
      return redundant ? inner : `${inner} (${href})`;
    },
  );

  text = text
    .replace(/<(?:br|hr)\b[^>]*>/gi, '\n')
    .replace(/<\/t[dh]\s*>/gi, ' ')
    .replace(/<(?:p|h[1-6])\b[^>]*>/gi, '\n')
    .replace(/<\/(?:p|div|h[1-6]|li|tr|table|ul|ol|blockquote|pre|section|article|header|footer|address|figure|dl|dt|dd)\s*>/gi, '\n');
  text = stripTags(text);

  return decodeEntities(text)
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// D6 read: HTML-only bodies convert to Markdown so the model reads structure
// (headings, links, lists, GFM tables), not a flat text dump. turndown's
// bundled @mixmark-io/domino fork does NOT execute scripts; remove() drops
// script/style/head entirely (turndown otherwise leaks their text content).
const turndownService = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
turndownService.use(gfm as Plugin);
turndownService.remove(['script', 'style', 'head']);

/** Convert HTML to Markdown; on any turndown failure fall back to the
 * plain-text extractor (caller then reports bodyFormat 'plain', not 'markdown'). */
export function htmlToMarkdown(html: string): { text: string; ok: boolean } {
  try {
    return { text: turndownService.turndown(html), ok: true };
  } catch {
    return { text: htmlToText(html), ok: false };
  }
}

/** In-Reply-To/References need the parent's real RFC 5322 Message-ID header, not the Gmail API id;
 * falls back to the API id so replies still thread inside Gmail. */
export function buildReplyHeaders(
  fallbackId: string,
  parentMessageIdHeader: string,
  parentReferences: string,
): { inReplyTo: string; references: string } {
  const parentId = parentMessageIdHeader.trim();
  if (parentId === '') return { inReplyTo: fallbackId, references: fallbackId };
  const refs = parentReferences.trim().replace(/\s+/g, ' ');
  return {
    inReplyTo: parentId,
    references: refs === '' ? parentId : `${refs} ${parentId}`,
  };
}

export interface ComposeAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

export interface ComposeInput {
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  cc?: string;
  inReplyTo?: string;
  references?: string;
  attachments?: ComposeAttachment[];
}

/** Header-injection guard slug; caller maps to a validation_error envelope. */
export class HeaderInjectionError extends Error {
  constructor(public field: string) {
    super(`E_HEADER_INJECTION: "${field}" must not contain CR or LF (header injection).`);
  }
}

/**
 * The single MIME-assembly seam for gmail_send and gmail_create_draft (A4).
 * MailComposer owns header/RFC-2047/address encoding and boundary generation,
 * which closes the CRLF header-injection hole in the old hand-rolled encoders.
 * A deterministic pre-check rejects CR/LF in address/subject headers with a
 * named error (belt-and-suspenders over MailComposer's own stripping).
 *
 * Bare-LF defense (Gmail's raw upload skips SMTP line-ending normalization):
 * normalize text/html to CRLF, build with newline:"\r\n" and base64 CTE.
 */
export async function composeRaw(input: ComposeInput): Promise<string> {
  for (const field of ['from', 'to', 'cc', 'subject'] as const) {
    const v = input[field];
    if (typeof v === 'string' && /[\r\n]/.test(v)) throw new HeaderInjectionError(field);
  }

  const options: Mail.Options & { newline?: string; textEncoding?: 'base64' | 'quoted-printable' } = {
    from: input.from,
    to: input.to,
    cc: input.cc || undefined,
    subject: input.subject,
    text: normalizeBodyLineEndings(input.text),
    html: input.html ? normalizeBodyLineEndings(input.html) : undefined,
    inReplyTo: input.inReplyTo,
    references: input.references,
    attachments: input.attachments,
    newline: '\r\n',
    textEncoding: 'base64',
    // This server reads any attachment file itself and passes a Buffer;
    // MailComposer must never touch the filesystem or network (SSRF / local
    // file-read defense-in-depth).
    disableFileAccess: true,
    disableUrlAccess: true,
  };
  const mail = new MailComposer(options);

  const built: Buffer = await new Promise((resolve, reject) => {
    mail.compile().build((err, message) => (err ? reject(err) : resolve(message)));
  });
  return built.toString('base64url');
}
