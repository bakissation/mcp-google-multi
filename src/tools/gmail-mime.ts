import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type Mail from 'nodemailer/lib/mailer/index.js';
import MarkdownIt from 'markdown-it';
import TurndownService from 'turndown';
// @ts-expect-error turndown-plugin-gfm ships no type declarations
import { gfm } from 'turndown-plugin-gfm';
import type { Plugin } from 'turndown';

// Send: body is Markdown; text/plain is the source, text/html is this render.
// html:false escapes raw HTML in the body (XSS-safe default); allowRawHtml opts into html:true for an audited caller.
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

// HTML-only bodies convert to Markdown so the model reads structure, not a flat
// text dump; turndown's bundled domino fork doesn't execute scripts, and remove() drops script/style/head (which otherwise leak text).
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

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// A quoted source goes inside a blockquote, so its document wrappers have to go; script and head never belong in a quote.
// This is an index scan rather than a regex replace: removing one tag can join its neighbours into a new one
// (`<scr<script></script>ipt>`), so the scan repeats until nothing changes, and an opening that is never closed is
// dropped with everything after it. Any `<` of those tags that is still left is escaped to text.
const WRAPPER_TAGS = ['script', 'head', 'html', 'body'];

/** ASCII-only lowercase: toLowerCase() can change the length of a string (e.g. U+0130), which would shift every index. */
function asciiLower(s: string): string {
  const out: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out.push(c >= 65 && c <= 90 ? String.fromCharCode(c + 32) : s[i]);
  }
  return out.join('');
}

function isNameChar(c: number): boolean {
  return (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95;
}

/** The wrapper tag whose `<` is at `lt` in the lowercased text, if any. */
function wrapperTagAt(lower: string, lt: number): { name: string; closing: boolean; nameEnd: number } | undefined {
  const closing = lower[lt + 1] === '/';
  const start = lt + (closing ? 2 : 1);
  for (const name of WRAPPER_TAGS) {
    if (lower.startsWith(name, start) && !isNameChar(lower.charCodeAt(start + name.length))) {
      return { name, closing, nameEnd: start + name.length };
    }
  }
  return undefined;
}

function isSpace(c: number): boolean {
  return c === 32 || (c >= 9 && c <= 13);
}

/** Index just past the `</name   >` that closes a block, or -1 when there is none. */
function closeTagEnd(lower: string, name: string, from: number): number {
  for (let at = lower.indexOf(`</${name}`, from); at !== -1; at = lower.indexOf(`</${name}`, at + 1)) {
    let k = at + 2 + name.length;
    while (k < lower.length && isSpace(lower.charCodeAt(k))) k++;
    if (lower[k] === '>') return k + 1;
  }
  return -1;
}

function stripWrappersOnce(html: string): string {
  const lower = asciiLower(html);
  const parts: string[] = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      parts.push(html.slice(i));
      break;
    }
    parts.push(html.slice(i, lt));
    const tagEnd = html.indexOf('>', lt);
    if (lower.startsWith('<!doctype', lt)) {
      if (tagEnd === -1) { parts.push('<'); i = lt + 1; } else i = tagEnd + 1;
      continue;
    }
    const tag = wrapperTagAt(lower, lt);
    if (tag === undefined) { parts.push('<'); i = lt + 1; continue; }
    if (tag.name === 'html' || tag.name === 'body' || tag.closing) {
      if (tagEnd === -1) { parts.push('<'); i = lt + 1; } else i = tagEnd + 1;
      continue;
    }
    // An opening script or head: drop the whole block, or everything to the end when it never closes.
    const end = tagEnd === -1 ? -1 : closeTagEnd(lower, tag.name, tagEnd + 1);
    if (end === -1) break;
    i = end;
  }
  return parts.join('');
}

function quotableHtml(html: string): string {
  let out = html;
  for (let previous = ''; previous !== out; ) {
    previous = out;
    out = stripWrappersOnce(out);
  }
  const lower = asciiLower(out);
  const parts: string[] = [];
  let i = 0;
  for (let lt = out.indexOf('<'); lt !== -1; lt = out.indexOf('<', i)) {
    parts.push(out.slice(i, lt), wrapperTagAt(lower, lt) === undefined ? '<' : '&lt;');
    i = lt + 1;
  }
  parts.push(out.slice(i));
  return parts.join('');
}

export interface ReplyQuoteSource {
  from: string;
  date: string;
  /** The source's text/plain body ('' when it has none). */
  plain: string;
  /** The source's text/html body ('' when it has none). */
  html: string;
}

/** The quoted original a mail client appends to a reply: the Gmail API never adds it to a raw message.
 * Returns undefined when the source has no text body at all. */
export function buildReplyQuote(src: ReplyQuoteSource): { text: string; html: string } | undefined {
  if (src.plain === '' && src.html === '') return undefined;
  const who = src.from.trim() || 'the sender';
  const attribution = src.date.trim() ? `On ${src.date.trim()}, ${who} wrote:` : `${who} wrote:`;

  const plain = src.plain !== '' ? src.plain : htmlToMarkdown(src.html).text;
  const quotedText = plain
    .replace(/\r\n|\r/g, '\n')
    .split('\n')
    .map((line) => (line === '' ? '>' : `> ${line}`))
    .join('\n');

  const inner = src.html !== ''
    ? quotableHtml(src.html)
    : escapeHtml(src.plain).replace(/\r\n|\r|\n/g, '<br>\n');
  // Gmail's own class names, so Gmail collapses the quote the way it does for a reply written in its UI.
  const html =
    '<br><div class="gmail_quote gmail_quote_container">' +
    `<div dir="ltr" class="gmail_attr">${escapeHtml(attribution)}<br></div>` +
    '<blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex">' +
    `${inner}</blockquote></div>\n`;

  return { text: `${attribution}\n${quotedText}\n`, html };
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
 * The single MIME-assembly seam for gmail_send and gmail_create_draft.
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
    // This server reads attachment files itself and passes a Buffer; MailComposer
    // must never touch the filesystem or network (SSRF / local file-read defense-in-depth).
    disableFileAccess: true,
    disableUrlAccess: true,
  };
  const mail = new MailComposer(options);

  const built: Buffer = await new Promise((resolve, reject) => {
    mail.compile().build((err, message) => (err ? reject(err) : resolve(message)));
  });
  return built.toString('base64url');
}
