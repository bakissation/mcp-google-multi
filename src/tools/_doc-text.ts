// Plain-text extraction for the binary document types drive_read can show:
// PDF, and the three OOXML Office formats (docx, xlsx, pptx), which are zips
// of XML. Done locally on the downloaded bytes, so nothing is converted or
// copied into the user's Drive. The parsers load on first use, which keeps
// server startup and the tool list untouched.

export type DocKind = 'pdf' | 'docx' | 'xlsx' | 'pptx';

const KIND_BY_MIME: Record<string, DocKind> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
};

export function docKindForMime(mimeType: string | null | undefined): DocKind | undefined {
  if (!mimeType) return undefined;
  return KIND_BY_MIME[mimeType.split(';')[0].trim().toLowerCase()];
}

// Bounds the work done on one file. Office files are zips, so a small file can
// expand a long way; the per-entry and total limits stop a decompression bomb.
export const DOC_MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024;
const ZIP_ENTRY_MAX_BYTES = 20 * 1024 * 1024;
const ZIP_TOTAL_MAX_BYTES = 50 * 1024 * 1024;
const SHEET_MAX = 50;
const SLIDE_MAX = 500;

export class DocTextError extends Error {}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

// Joins the text runs (`<tag>...</tag>`) found in one XML fragment.
function runsText(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g');
  let out = '';
  for (let m = re.exec(xml); m; m = re.exec(xml)) out += decodeEntities(m[1]);
  return out;
}

// WordprocessingML and DrawingML both mark paragraphs, tabs and line breaks
// inline with the text, so one pass handles docx bodies and pptx slides.
function paragraphsText(xml: string, para: string, text: string, tab: string, br: string): string {
  const paraRe = new RegExp(`<${para}(?:\\s[^>]*)?>([\\s\\S]*?)</${para}>`, 'g');
  const tokenRe = new RegExp(`<${text}(?:\\s[^>]*)?>([\\s\\S]*?)</${text}>|<${tab}\\s*/>|<${br}(?:\\s[^>]*)?/>`, 'g');
  const lines: string[] = [];
  for (let p = paraRe.exec(xml); p; p = paraRe.exec(xml)) {
    let line = '';
    for (let t = tokenRe.exec(p[1]); t; t = tokenRe.exec(p[1])) {
      if (t[1] !== undefined) line += decodeEntities(t[1]);
      else line += t[0].startsWith(`<${tab}`) ? '\t' : '\n';
    }
    lines.push(line);
  }
  return lines.join('\n');
}

function attr(tagText: string, name: string): string | undefined {
  const m = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(tagText);
  return m ? decodeEntities(m[1]) : undefined;
}

function columnIndex(ref: string): number {
  let n = 0;
  for (const ch of ref.replace(/[^A-Za-z]/g, '').toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return Math.max(0, n - 1);
}

type Files = Record<string, Uint8Array>;
const dec = new TextDecoder('utf-8');
const textOf = (files: Files, name: string): string | undefined => {
  const f = files[name];
  return f ? dec.decode(f) : undefined;
};

async function openZip(bytes: Uint8Array, want: (name: string) => boolean): Promise<Files> {
  const { unzipSync } = await import('fflate');
  let total = 0;
  try {
    return unzipSync(bytes, {
      filter: (f) => {
        if (!want(f.name)) return false;
        if (f.originalSize > ZIP_ENTRY_MAX_BYTES) throw new DocTextError('a part of the file is too large to read');
        total += f.originalSize;
        if (total > ZIP_TOTAL_MAX_BYTES) throw new DocTextError('the file expands to more than the read limit');
        return true;
      },
    });
  } catch (e) {
    if (e instanceof DocTextError) throw e;
    throw new DocTextError('the file is not a valid Office document');
  }
}

const numberOf = (name: string): number => parseInt(/(\d+)\.xml$/.exec(name)?.[1] ?? '0', 10);

async function docxText(bytes: Uint8Array): Promise<string> {
  const files = await openZip(bytes, (n) => n === 'word/document.xml');
  const xml = textOf(files, 'word/document.xml');
  if (xml === undefined) throw new DocTextError('the file has no document body');
  return paragraphsText(xml, 'w:p', 'w:t', 'w:tab', 'w:br');
}

async function pptxText(bytes: Uint8Array): Promise<string> {
  const files = await openZip(bytes, (n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  const slides = Object.keys(files).sort((a, b) => numberOf(a) - numberOf(b)).slice(0, SLIDE_MAX);
  if (slides.length === 0) throw new DocTextError('the file has no slides');
  return slides
    .map((name, i) => `## Slide ${i + 1}\n${paragraphsText(textOf(files, name)!, 'a:p', 'a:t', 'a:tab', 'a:br')}`)
    .join('\n\n');
}

async function xlsxText(bytes: Uint8Array): Promise<string> {
  const files = await openZip(
    bytes,
    (n) => n === 'xl/workbook.xml' || n === 'xl/_rels/workbook.xml.rels' || n === 'xl/sharedStrings.xml'
      || /^xl\/worksheets\/sheet\d+\.xml$/.test(n),
  );

  const shared: string[] = [];
  const sst = textOf(files, 'xl/sharedStrings.xml');
  if (sst) {
    const siRe = /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g;
    for (let m = siRe.exec(sst); m; m = siRe.exec(sst)) shared.push(runsText(m[1], 't'));
  }

  // Sheet names live in workbook.xml; relationship ids point at the part.
  const targets = new Map<string, string>();
  const rels = textOf(files, 'xl/_rels/workbook.xml.rels');
  if (rels) {
    const re = /<Relationship\s[^>]*>/g;
    for (let m = re.exec(rels); m; m = re.exec(rels)) {
      const id = attr(m[0], 'Id');
      const target = attr(m[0], 'Target');
      if (id && target) targets.set(id, target.replace(/^\/?(xl\/)?/, 'xl/'));
    }
  }
  const sheets: { name: string; part: string }[] = [];
  const wb = textOf(files, 'xl/workbook.xml');
  if (wb) {
    const re = /<sheet\s[^>]*>/g;
    for (let m = re.exec(wb); m; m = re.exec(wb)) {
      const name = attr(m[0], 'name');
      const rid = attr(m[0], 'r:id');
      const part = rid ? targets.get(rid) : undefined;
      if (name && part && files[part]) sheets.push({ name, part });
    }
  }
  if (sheets.length === 0) {
    for (const part of Object.keys(files).filter((n) => n.startsWith('xl/worksheets/')).sort((a, b) => numberOf(a) - numberOf(b))) {
      sheets.push({ name: `Sheet ${numberOf(part)}`, part });
    }
  }
  if (sheets.length === 0) throw new DocTextError('the file has no sheets');

  const out: string[] = [];
  for (const { name, part } of sheets.slice(0, SHEET_MAX)) {
    const xml = textOf(files, part)!;
    const rows: string[] = [];
    const rowRe = /<row(?:\s[^>]*)?>([\s\S]*?)<\/row>/g;
    for (let r = rowRe.exec(xml); r; r = rowRe.exec(xml)) {
      const cells: string[] = [];
      const cellRe = /<c(\s[^>]*?)?(?:\/>|>([\s\S]*?)<\/c>)/g;
      for (let c = cellRe.exec(r[1]); c; c = cellRe.exec(r[1])) {
        const head = c[1] ?? '';
        const body = c[2] ?? '';
        const type = attr(head, 't');
        let value: string;
        if (type === 'inlineStr') value = runsText(body, 't');
        else {
          const v = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(body)?.[1];
          if (v === undefined) value = '';
          else if (type === 's') value = shared[parseInt(v, 10)] ?? '';
          else if (type === 'b') value = v === '1' ? 'TRUE' : 'FALSE';
          else value = decodeEntities(v);
        }
        const ref = attr(head, 'r');
        if (ref) while (cells.length < columnIndex(ref)) cells.push('');
        cells.push(value.replace(/[\t\r\n]+/g, ' '));
      }
      while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
      rows.push(cells.join('\t'));
    }
    out.push(`## ${name}\n${rows.join('\n')}`);
  }
  return out.join('\n\n');
}

async function pdfText(bytes: Uint8Array): Promise<string> {
  const { getDocumentProxy, extractText } = await import('unpdf');
  let pdf;
  try {
    pdf = await getDocumentProxy(new Uint8Array(bytes), { verbosity: 0 });
  } catch (e) {
    const name = (e as { name?: string })?.name;
    throw new DocTextError(name === 'PasswordException' ? 'the PDF is password protected' : 'the file is not a readable PDF');
  }
  try {
    const { text } = await extractText(pdf, { mergePages: true });
    return text;
  } finally {
    await pdf.cleanup().catch(() => undefined);
  }
}

/** Text of a PDF or OOXML document. Throws DocTextError with a reason that is
 * safe to show the user. An empty result means the file has no text layer. */
export async function extractDocumentText(kind: DocKind, bytes: Uint8Array): Promise<string> {
  const text = kind === 'pdf' ? await pdfText(bytes)
    : kind === 'docx' ? await docxText(bytes)
    : kind === 'xlsx' ? await xlsxText(bytes)
    : await pptxText(bytes);
  return text.replace(/\r\n?/g, '\n').trim();
}
