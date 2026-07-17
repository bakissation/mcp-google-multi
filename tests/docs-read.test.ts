import { describe, it, expect } from 'vitest';
import {
  buildHeadingIndex,
  extractPlainTextInRange,
  resolveHeading,
  findTab,
  listTabs,
} from '../src/tools/docs.js';
import { capText } from '../src/trim.js';

function para(text: string, start: number, namedStyleType?: string) {
  const end = start + text.length;
  return {
    startIndex: start,
    endIndex: end,
    paragraph: {
      ...(namedStyleType ? { paragraphStyle: { namedStyleType } } : {}),
      elements: [{ startIndex: start, endIndex: end, textRun: { content: text } }],
    },
  };
}

function docBody(specs: [style: string | null, text: string][]) {
  let cursor = 1;
  const content: any[] = [];
  for (const [style, text] of specs) {
    content.push(para(text, cursor, style ?? undefined));
    cursor += text.length;
  }
  return { content };
}

const BODY = docBody([
  ['TITLE', 'My Doc\n'],        // 1..8
  [null, 'intro text\n'],       // 8..19
  ['HEADING_1', 'Alpha\n'],     // 19..25
  [null, 'alpha body\n'],       // 25..36
  ['HEADING_2', 'Alpha One\n'], // 36..46
  [null, 'nested body\n'],      // 46..58
  ['HEADING_1', 'Beta\n'],      // 58..63
  [null, 'beta body\n'],        // 63..73
]);

function tableBody() {
  const cellContent = [
    para('In Cell\n', 9, 'HEADING_2'),  // 9..17
    para('cell body\n', 17),            // 17..27
  ];
  return {
    content: [
      para('before\n', 1),              // 1..8
      {
        startIndex: 8,
        endIndex: 40,
        table: { tableRows: [{ tableCells: [{ content: cellContent }] }] },
      },
      para('after\n', 40),              // 40..46
      para('Next\n', 46, 'HEADING_2'),  // 46..51
      para('tail\n', 51),               // 51..56
    ],
  };
}

describe('buildHeadingIndex', () => {
  it('collects title and heading levels with spans to the next same-or-higher heading', () => {
    expect(buildHeadingIndex(BODY)).toEqual([
      { i: 0, level: 'title', text: 'My Doc', startIndex: 1, endIndex: 73 },
      { i: 1, level: 1, text: 'Alpha', startIndex: 19, endIndex: 58 },
      { i: 2, level: 2, text: 'Alpha One', startIndex: 36, endIndex: 58 },
      { i: 3, level: 1, text: 'Beta', startIndex: 58, endIndex: 73 },
    ]);
  });

  it('ends a section at the next heading of the same level', () => {
    const body = docBody([
      ['HEADING_1', 'First\n'],  // 1..7
      [null, 'one\n'],           // 7..11
      ['HEADING_1', 'Second\n'], // 11..18
      [null, 'two\n'],           // 18..22
    ]);
    expect(buildHeadingIndex(body)).toEqual([
      { i: 0, level: 1, text: 'First', startIndex: 1, endIndex: 11 },
      { i: 1, level: 1, text: 'Second', startIndex: 11, endIndex: 22 },
    ]);
  });

  it('includes table-nested headings in document order', () => {
    expect(buildHeadingIndex(tableBody())).toEqual([
      { i: 0, level: 2, text: 'In Cell', startIndex: 9, endIndex: 46 },
      { i: 1, level: 2, text: 'Next', startIndex: 46, endIndex: 56 },
    ]);
  });

  it('returns an empty index for empty or missing bodies', () => {
    expect(buildHeadingIndex({ content: [] })).toEqual([]);
    expect(buildHeadingIndex(undefined)).toEqual([]);
    expect(buildHeadingIndex(docBody([[null, 'no headings\n']]))).toEqual([]);
  });
});

describe('extractPlainTextInRange', () => {
  it('extracts a mid-document section including nested subheadings', () => {
    expect(extractPlainTextInRange(BODY, 19, 58)).toBe('Alpha\nalpha body\nAlpha One\nnested body\n');
  });

  it('extracts the last section through to the document end', () => {
    expect(extractPlainTextInRange(BODY, 58, 73)).toBe('Beta\nbeta body\n');
  });

  it('extracts a section whose heading sits inside a table', () => {
    expect(extractPlainTextInRange(tableBody(), 9, 46)).toBe('In Cell\ncell body\nafter\n');
  });

  it('slices partially-overlapping paragraphs at the range edges', () => {
    expect(extractPlainTextInRange(BODY, 21, 27)).toBe('pha\nal');
  });

  it('returns empty for missing bodies and empty ranges', () => {
    expect(extractPlainTextInRange(undefined, 0, 100)).toBe('');
    expect(extractPlainTextInRange(BODY, 19, 19)).toBe('');
  });

  it('full range matches the unbounded walk', () => {
    expect(extractPlainTextInRange(BODY, 0, Infinity))
      .toBe('My Doc\nintro text\nAlpha\nalpha body\nAlpha One\nnested body\nBeta\nbeta body\n');
  });
});

describe('resolveHeading', () => {
  const headings = buildHeadingIndex(docBody([
    ['HEADING_1', 'Overview\n'],
    ['HEADING_2', 'Overview of Costs\n'],
    ['HEADING_1', 'Details\n'],
  ]));

  it('prefers a case-insensitive exact match over substring matches', () => {
    const res = resolveHeading(headings, 'overview');
    expect(res).toHaveProperty('match');
    expect((res as any).match.i).toBe(0);
  });

  it('falls back to a unique substring match', () => {
    const res = resolveHeading(headings, 'costs');
    expect((res as any).match.i).toBe(1);
  });

  it('errors on an ambiguous substring, listing candidates', () => {
    const res = resolveHeading(headings, 'over');
    expect(res).toEqual({ error: 'ambiguous', candidates: [headings[0], headings[1]] });
  });

  it('errors on duplicate exact matches', () => {
    const dup = buildHeadingIndex(docBody([
      ['HEADING_1', 'Notes\n'],
      [null, 'x\n'],
      ['HEADING_1', 'Notes\n'],
    ]));
    const res = resolveHeading(dup, 'Notes');
    expect(res).toEqual({ error: 'ambiguous', candidates: dup });
  });

  it('errors not_found with all headings as candidates', () => {
    expect(resolveHeading(headings, 'zzz')).toEqual({ error: 'not_found', candidates: headings });
  });
});

describe('section paging', () => {
  it('applies maxChars/offset within an extracted section', () => {
    const section = extractPlainTextInRange(BODY, 58, 73);
    expect(capText(section, 5, 0)).toEqual({ text: 'Beta\n', truncated: true, totalChars: 15 });
    expect(capText(section, 100, 5)).toEqual({ text: 'beta body\n', truncated: false, totalChars: 15 });
  });
});

describe('tab helpers', () => {
  const tabs = [
    {
      tabProperties: { tabId: 't1', title: 'First' },
      childTabs: [{ tabProperties: { tabId: 't1a', title: 'Nested' } }],
    },
    { tabProperties: { tabId: 't2', title: 'Second' } },
  ];

  it('finds tabs recursively through childTabs', () => {
    expect(findTab(tabs, 't1a')?.tabProperties.title).toBe('Nested');
    expect(findTab(tabs, 't2')?.tabProperties.title).toBe('Second');
    expect(findTab(tabs, 'missing')).toBeUndefined();
    expect(findTab(undefined, 't1')).toBeUndefined();
  });

  it('lists all tabs flat', () => {
    expect(listTabs(tabs)).toEqual([
      { tabId: 't1', title: 'First' },
      { tabId: 't1a', title: 'Nested' },
      { tabId: 't2', title: 'Second' },
    ]);
  });
});
