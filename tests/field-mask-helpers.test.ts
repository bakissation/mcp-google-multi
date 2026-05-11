import { describe, it, expect } from 'vitest';
import { buildCellFormat } from '../src/tools/sheets.js';
import { buildParagraphStyle, buildDocumentStyle } from '../src/tools/docs.js';

describe('buildCellFormat (Sheets RepeatCell helper)', () => {
  it('returns empty fields when nothing supplied', () => {
    const r = buildCellFormat({});
    expect(r.fields).toBe('');
    expect(r.format).toEqual({});
  });

  it('wraps backgroundColor in backgroundColorStyle.rgbColor', () => {
    const r = buildCellFormat({ backgroundColor: { red: 1, green: 0.5, blue: 0 } });
    expect(r.format.backgroundColorStyle).toEqual({ rgbColor: { red: 1, green: 0.5, blue: 0 } });
    expect(r.fields).toBe('userEnteredFormat.backgroundColorStyle');
  });

  it('emits dotted-path fields for nested textFormat', () => {
    const r = buildCellFormat({
      textFormat: { bold: true, italic: false, fontSize: 12 },
    });
    expect(r.format.textFormat).toEqual({ bold: true, italic: false, fontSize: 12 });
    const fields = r.fields.split(',');
    expect(fields).toContain('userEnteredFormat.textFormat.bold');
    expect(fields).toContain('userEnteredFormat.textFormat.italic');
    expect(fields).toContain('userEnteredFormat.textFormat.fontSize');
  });

  it('wraps foregroundColor in foregroundColorStyle.rgbColor', () => {
    const r = buildCellFormat({
      textFormat: { foregroundColor: { red: 0, green: 0, blue: 1 } },
    });
    expect(r.format.textFormat.foregroundColorStyle).toEqual({
      rgbColor: { red: 0, green: 0, blue: 1 },
    });
    expect(r.fields).toBe('userEnteredFormat.textFormat.foregroundColorStyle');
  });

  it('omits empty textFormat object when no sub-fields are set', () => {
    const r = buildCellFormat({ textFormat: {}, horizontalAlignment: 'CENTER' });
    expect(r.format.textFormat).toBeUndefined();
    expect(r.fields).toBe('userEnteredFormat.horizontalAlignment');
  });

  it('emits numberFormat as a whole replacement, not per-subfield', () => {
    const r = buildCellFormat({
      numberFormat: { type: 'CURRENCY', pattern: '$#,##0.00' },
    });
    expect(r.format.numberFormat).toEqual({ type: 'CURRENCY', pattern: '$#,##0.00' });
    expect(r.fields).toBe('userEnteredFormat.numberFormat');
  });

  it('combines multiple top-level fields with commas', () => {
    const r = buildCellFormat({
      backgroundColor: { red: 1 },
      horizontalAlignment: 'CENTER',
      verticalAlignment: 'MIDDLE',
      wrapStrategy: 'WRAP',
    });
    const fields = r.fields.split(',');
    expect(fields).toContain('userEnteredFormat.backgroundColorStyle');
    expect(fields).toContain('userEnteredFormat.horizontalAlignment');
    expect(fields).toContain('userEnteredFormat.verticalAlignment');
    expect(fields).toContain('userEnteredFormat.wrapStrategy');
    expect(fields).toHaveLength(4);
  });
});

describe('buildParagraphStyle (Docs updateParagraphStyle helper)', () => {
  it('returns empty fields when nothing supplied', () => {
    const r = buildParagraphStyle({});
    expect(r.fields).toBe('');
    expect(r.paragraphStyle).toEqual({});
  });

  it('wraps point-valued fields as Dimension {magnitude, unit: PT}', () => {
    const r = buildParagraphStyle({
      spaceAbove: 12,
      indentStart: 36,
      indentFirstLine: 18,
    });
    expect(r.paragraphStyle.spaceAbove).toEqual({ magnitude: 12, unit: 'PT' });
    expect(r.paragraphStyle.indentStart).toEqual({ magnitude: 36, unit: 'PT' });
    expect(r.paragraphStyle.indentFirstLine).toEqual({ magnitude: 18, unit: 'PT' });
  });

  it('preserves scalar fields as-is (lineSpacing, namedStyleType, alignment)', () => {
    const r = buildParagraphStyle({
      namedStyleType: 'HEADING_2',
      alignment: 'CENTER',
      lineSpacing: 150,
    });
    expect(r.paragraphStyle.namedStyleType).toBe('HEADING_2');
    expect(r.paragraphStyle.alignment).toBe('CENTER');
    expect(r.paragraphStyle.lineSpacing).toBe(150);
  });

  it('emits boolean toggles correctly', () => {
    const r = buildParagraphStyle({
      keepLinesTogether: true,
      avoidWidowAndOrphan: false,
    });
    expect(r.paragraphStyle.keepLinesTogether).toBe(true);
    expect(r.paragraphStyle.avoidWidowAndOrphan).toBe(false);
    expect(r.fields.split(',')).toContain('keepLinesTogether');
    expect(r.fields.split(',')).toContain('avoidWidowAndOrphan');
  });

  it('builds fields list flat (no nesting prefix unlike Sheets)', () => {
    const r = buildParagraphStyle({ alignment: 'JUSTIFIED', namedStyleType: 'NORMAL_TEXT' });
    expect(r.fields.split(',').sort()).toEqual(['alignment', 'namedStyleType']);
  });
});

describe('buildDocumentStyle (Docs updateDocumentStyle helper)', () => {
  it('returns empty fields when nothing supplied', () => {
    const r = buildDocumentStyle({});
    expect(r.fields).toBe('');
    expect(r.documentStyle).toEqual({});
  });

  it('groups pageWidth + pageHeight under pageSize with a single fields entry', () => {
    const r = buildDocumentStyle({ pageWidth: 595, pageHeight: 842 });
    expect(r.documentStyle.pageSize).toEqual({
      width: { magnitude: 595, unit: 'PT' },
      height: { magnitude: 842, unit: 'PT' },
    });
    expect(r.fields).toBe('pageSize');
  });

  it('emits pageSize even if only one dimension is supplied', () => {
    const r = buildDocumentStyle({ pageWidth: 595 });
    expect(r.documentStyle.pageSize).toEqual({ width: { magnitude: 595, unit: 'PT' } });
    expect(r.fields).toBe('pageSize');
  });

  it('wraps each margin as Dimension and emits per-margin fields', () => {
    const r = buildDocumentStyle({ marginTop: 72, marginBottom: 72, marginLeft: 90, marginRight: 90 });
    expect(r.documentStyle.marginTop).toEqual({ magnitude: 72, unit: 'PT' });
    const fields = r.fields.split(',').sort();
    expect(fields).toEqual(['marginBottom', 'marginLeft', 'marginRight', 'marginTop']);
  });

  it('passes pageNumberStart as a raw number, not a Dimension', () => {
    const r = buildDocumentStyle({ pageNumberStart: 5 });
    expect(r.documentStyle.pageNumberStart).toBe(5);
    expect(r.fields).toBe('pageNumberStart');
  });

  it('emits boolean header/footer toggles as scalar values', () => {
    const r = buildDocumentStyle({
      useFirstPageHeaderFooter: true,
      useEvenPageHeaderFooter: false,
    });
    expect(r.documentStyle.useFirstPageHeaderFooter).toBe(true);
    expect(r.documentStyle.useEvenPageHeaderFooter).toBe(false);
  });
});
