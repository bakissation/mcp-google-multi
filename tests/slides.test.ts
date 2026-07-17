import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../src/registry.js';
import type { Policy } from '../src/write-control.js';
import { registerSlidesTools, extractPageText, summarizePresentation } from '../src/tools/slides.js';

const POLICY: Policy = { profile: 'safe-writes', readOnly: false, allow: [], deny: [] };

function buildRegistry(): ToolRegistry {
  const server = {
    registerTool: () => 'ok',
    sendToolListChanged: () => {},
    server: { setRequestHandler: () => {} },
  };
  return new ToolRegistry(server as never, POLICY);
}

describe('registerSlidesTools', () => {
  it('registers the five slides tools with the expected cud classes', () => {
    const registry = buildRegistry();
    registerSlidesTools(registry);
    const byName = Object.fromEntries(registry.tools.map((t) => [t.name, t]));
    expect(Object.keys(byName).sort()).toEqual([
      'slides_batch_update',
      'slides_create',
      'slides_get',
      'slides_page_get',
      'slides_page_thumbnail',
    ]);
    expect(byName.slides_create.cud).toBe('create');
    expect(byName.slides_get.cud).toBe('read');
    expect(byName.slides_page_get.cud).toBe('read');
    expect(byName.slides_page_thumbnail.cud).toBe('read');
    expect(byName.slides_batch_update.cud).toBe('update');
    for (const tool of registry.tools) expect(tool.service).toBe('slides');
  });
});

describe('extractPageText', () => {
  it('collects shape text runs and normalizes whitespace', () => {
    const text = extractPageText([
      { shape: { text: { textElements: [{ textRun: { content: 'Hello\n' } }, { textRun: { content: ' world ' } }] } } },
    ]);
    expect(text).toBe('Hello world');
  });

  it('collects table cell text and nested group children', () => {
    const text = extractPageText([
      {
        table: {
          tableRows: [
            { tableCells: [{ text: { textElements: [{ textRun: { content: 'A1 ' } }] } }] },
          ],
        },
      },
      {
        elementGroup: {
          children: [
            { shape: { text: { textElements: [{ textRun: { content: 'grouped' } }] } } },
          ],
        },
      },
    ]);
    expect(text).toBe('A1 grouped');
  });

  it('handles autoText and elements with no text', () => {
    expect(extractPageText([{ image: {} }, { shape: { text: { textElements: [{ autoText: { content: '3' } }] } } }])).toBe('3');
    expect(extractPageText(undefined)).toBe('');
  });
});

describe('summarizePresentation', () => {
  const presentation = {
    presentationId: 'p1',
    title: 'Deck',
    revisionId: 'r9',
    pageSize: { width: {}, height: {} },
    masters: [{ objectId: 'm1' }],
    slides: [
      {
        objectId: 's1',
        pageElements: [
          { shape: { text: { textElements: [{ textRun: { content: 'Title slide' } }] } } },
        ],
      },
      { objectId: 's2' },
    ],
  };

  it('produces a compact per-slide digest instead of the raw payload', () => {
    const summary = summarizePresentation(presentation) as any;
    expect(summary.presentationId).toBe('p1');
    expect(summary.title).toBe('Deck');
    expect(summary.revisionId).toBe('r9');
    expect(summary.slideCount).toBe(2);
    expect(summary.slides).toEqual([
      { index: 0, objectId: 's1', elementCount: 1, text: 'Title slide' },
      { index: 1, objectId: 's2', elementCount: 0 },
    ]);
    expect(summary.masters).toBeUndefined();
    expect(summary.pageSize).toBeUndefined();
    expect(summary.hint).toContain('full:true');
  });

  it('caps each slide digest at 200 chars', () => {
    const long = 'x'.repeat(500);
    const summary = summarizePresentation({
      presentationId: 'p2',
      slides: [{ objectId: 's1', pageElements: [{ shape: { text: { textElements: [{ textRun: { content: long } }] } } }] }],
    }) as any;
    expect(summary.slides[0].text).toHaveLength(200);
  });

  it('handles a presentation with no slides', () => {
    const summary = summarizePresentation({ presentationId: 'p3', title: 'Empty' }) as any;
    expect(summary.slideCount).toBe(0);
    expect(summary.slides).toEqual([]);
  });
});
