import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { toolHarness, parseResult, type GoogleRequest } from './_tool-harness.js';

// drive_read: text out of PDF and Office files, extracted locally from the
// downloaded bytes (no Drive-side conversion).

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

const zip = (parts: Record<string, string>): Uint8Array =>
  zipSync(Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, strToU8(v)])));

/** A one-page PDF whose content stream is `stream` (empty = no text layer). */
function pdf(stream: string): Uint8Array {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return strToU8(out);
}

function drive(file: { mimeType: string; bytes: Uint8Array; size?: number; name?: string }) {
  return toolHarness({
    respond: (req: GoogleRequest) =>
      req.params?.alt === 'media'
        ? file.bytes.buffer.slice(file.bytes.byteOffset, file.bytes.byteOffset + file.bytes.byteLength)
        : { id: 'f1', name: file.name ?? 'file', mimeType: file.mimeType, size: String(file.size ?? file.bytes.length), webViewLink: 'https://drive.example.com/f1' },
  });
}

const read = async (file: Parameters<typeof drive>[0], extra: Record<string, unknown> = {}) => {
  const h = drive(file);
  const res = await h.call('drive_read', { account: 'test', fileId: 'f1', ...extra });
  return { res, out: parseResult(res), h };
};

describe('drive_read: Word', () => {
  const body = (inner: string) => `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>${inner}</w:body></w:document>`;

  it('returns paragraphs, tabs, line breaks and decoded entities', async () => {
    const bytes = zip({
      'word/document.xml': body(
        '<w:p><w:pPr><w:jc w:val="left"/></w:pPr><w:r><w:t>Quarterly &amp; yearly</w:t></w:r></w:p>' +
        '<w:p><w:r><w:t xml:space="preserve">Name</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>Value &#233;</w:t></w:r></w:p>' +
        '<w:p><w:r><w:t>one</w:t><w:br/><w:t>two</w:t></w:r></w:p>',
      ),
      'word/styles.xml': '<ignored/>',
    });
    const { res, out } = await read({ mimeType: DOCX, bytes, name: 'plan.docx' });
    expect(res.isError).toBeFalsy();
    expect(out.name).toBe('plan.docx');
    expect(out.content).toBe('Quarterly & yearly\nName\tValue é\none\ntwo');
  });

  it('pages long text with offset like other reads', async () => {
    const paras = Array.from({ length: 50 }, (_, i) => `<w:p><w:r><w:t>line ${i}</w:t></w:r></w:p>`).join('');
    const bytes = zip({ 'word/document.xml': body(paras) });
    const first = (await read({ mimeType: DOCX, bytes }, { maxChars: 20 })).out;
    expect(first.truncated).toBe(true);
    expect(first.content).toHaveLength(20);
    const next = (await read({ mimeType: DOCX, bytes }, { maxChars: 20, offset: 20 })).out;
    expect(next.offset).toBe(20);
    expect(next.content).not.toBe(first.content);
  });

  it('a zip without a document body is a binary error with a reason', async () => {
    const { res, out } = await read({ mimeType: DOCX, bytes: zip({ 'other.xml': '<a/>' }) });
    expect(res.isError).toBe(true);
    expect(out.error).toBe('binary');
    expect(out.message).toContain('no document body');
    expect(out.hint).toContain('drive_download');
  });

  it('bytes that are not a zip are a binary error, not a crash', async () => {
    const { res, out } = await read({ mimeType: DOCX, bytes: strToU8('this is not a zip file at all') });
    expect(res.isError).toBe(true);
    expect(out.error).toBe('binary');
    expect(out.message).toContain('not a valid Office document');
  });

  it('refuses a part that expands past the safety limit', async () => {
    const huge = zipSync({ 'word/document.xml': new Uint8Array(21 * 1024 * 1024) });
    expect(huge.length).toBeLessThan(1024 * 1024);
    const { res, out } = await read({ mimeType: DOCX, bytes: huge });
    expect(res.isError).toBe(true);
    expect(out.error).toBe('binary');
    expect(out.message).toContain('too large');
  });
});

describe('drive_read: Excel', () => {
  it('returns each sheet by name as tab-separated rows, resolving shared strings', async () => {
    const bytes = zip({
      'xl/workbook.xml':
        '<workbook xmlns:r="r"><sheets><sheet name="Budget &amp; Plan" sheetId="1" r:id="rId1"/><sheet name="Notes" sheetId="2" r:id="rId2"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels':
        '<Relationships><Relationship Id="rId1" Type="t" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="t" Target="/xl/worksheets/sheet2.xml"/></Relationships>',
      'xl/sharedStrings.xml':
        '<sst><si><t>Item</t></si><si><r><t>Amou</t></r><r><t>nt</t></r></si><si><t>Rent</t></si></sst>',
      'xl/worksheets/sheet1.xml':
        '<worksheet><sheetData>' +
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="D1" t="inlineStr"><is><t>Flag</t></is></c></row>' +
        '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>1200.5</v></c><c r="C2" t="b"><v>1</v></c><c r="D2" t="str"><v>a&lt;b</v></c></row>' +
        '</sheetData></worksheet>',
      'xl/worksheets/sheet2.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>hello</t></is></c></row></sheetData></worksheet>',
    });
    const { res, out } = await read({ mimeType: XLSX, bytes, name: 'book.xlsx' });
    expect(res.isError).toBeFalsy();
    expect(out.content).toBe(
      '## Budget & Plan\nItem\tAmount\t\tFlag\nRent\t1200.5\tTRUE\ta<b\n\n## Notes\nhello',
    );
  });

  it('falls back to numbered sheets when the workbook index is missing', async () => {
    const bytes = zip({
      'xl/worksheets/sheet2.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>two</t></is></c></row></sheetData></worksheet>',
      'xl/worksheets/sheet10.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>ten</t></is></c></row></sheetData></worksheet>',
    });
    const { out } = await read({ mimeType: XLSX, bytes });
    expect(out.content).toBe('## Sheet 2\ntwo\n\n## Sheet 10\nten');
  });
});

describe('drive_read: PowerPoint', () => {
  const slide = (...paras: string[]) =>
    `<p:sld><p:cSld><p:spTree>${paras.map((t) => `<p:sp><p:txBody><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:txBody></p:sp>`).join('')}</p:spTree></p:cSld></p:sld>`;

  it('returns slides in numeric order, not name order', async () => {
    const bytes = zip({
      'ppt/slides/slide10.xml': slide('Last one'),
      'ppt/slides/slide2.xml': slide('Second', 'Details &amp; more'),
      'ppt/slides/slide1.xml': slide('Title'),
      'ppt/notesSlides/notesSlide1.xml': slide('speaker notes are not slides'),
    });
    const { res, out } = await read({ mimeType: PPTX, bytes, name: 'deck.pptx' });
    expect(res.isError).toBeFalsy();
    expect(out.content).toBe('## Slide 1\nTitle\n\n## Slide 2\nSecond\nDetails & more\n\n## Slide 3\nLast one');
  });
});

describe('drive_read: PDF', () => {
  it('returns the text layer', async () => {
    const bytes = pdf('BT /F1 18 Tf 20 100 Td (Invoice 2026 total 42) Tj ET');
    const { res, out } = await read({ mimeType: 'application/pdf', bytes, name: 'invoice.pdf' });
    expect(res.isError).toBeFalsy();
    expect(out.name).toBe('invoice.pdf');
    expect(out.content).toContain('Invoice 2026 total 42');
  });

  it('a PDF with no text layer (a scan) is a binary error that says so', async () => {
    const { res, out } = await read({ mimeType: 'application/pdf', bytes: pdf('') });
    expect(res.isError).toBe(true);
    expect(out.error).toBe('binary');
    expect(out.message).toContain('scanned PDF');
    expect(out.hint).toContain('drive_download');
  });

  it('bytes that are not a PDF are a binary error, not a crash', async () => {
    const { res, out } = await read({ mimeType: 'application/pdf', bytes: strToU8('definitely not a pdf') });
    expect(res.isError).toBe(true);
    expect(out.error).toBe('binary');
  });
});

describe('drive_read: limits and the rest', () => {
  it('a PDF over the size limit is too_large and is never downloaded', async () => {
    const { res, out, h } = await read({ mimeType: 'application/pdf', bytes: strToU8('x'), size: 11 * 1024 * 1024 });
    expect(res.isError).toBe(true);
    expect(out.error).toBe('too_large');
    expect(h.requests().filter((r) => r.params?.alt === 'media')).toHaveLength(0);
  });

  it('an Office file between 2MB and the document limit is still read', async () => {
    const bytes = zip({ 'word/document.xml': '<w:document><w:p><w:t>big but fine</w:t></w:p></w:document>' });
    const { res, out } = await read({ mimeType: DOCX, bytes, size: 5 * 1024 * 1024 });
    expect(res.isError).toBeFalsy();
    expect(out.content).toBe('big but fine');
  });

  it('other binaries still return error:binary', async () => {
    const { res, out } = await read({ mimeType: 'image/png', bytes: strToU8('png') });
    expect(res.isError).toBe(true);
    expect(out.error).toBe('binary');
  });
});
