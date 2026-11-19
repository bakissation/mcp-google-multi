import { describe, it, expect, vi } from 'vitest';
import { ToolRegistry } from '../src/registry.js';
import type { Policy } from '../src/write-control.js';
import { fakeServer } from './_tool-harness.js';
import { registerClassroomTools, summarizeMaterial, parseDueDate, parseDueTime } from '../src/tools/classroom.js';

const POLICY: Policy = { profile: 'safe-writes', readOnly: false, allow: [], deny: [] };

type Req = { url: string; method?: string; data?: unknown };

function setup(respond: (req: Req) => unknown = () => ({})) {
  const fake = fakeServer();
  const registry = new ToolRegistry(fake.server as never, POLICY);
  const request = vi.fn(async (req: Req) => ({ data: respond(req), headers: new Headers(), status: 200 }));
  registerClassroomTools(registry, { getClientFn: (async () => ({ request })) as never });
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = (await fake.handlers[name]({ account: 'test', ...args })) as { content: { text: string }[]; isError?: boolean };
    return { res, out: JSON.parse(res.content[0].text) as Record<string, any> };
  };
  const last = () => request.mock.calls.at(-1)![0] as Req;
  return { registry, call, last, request };
}

describe('registerClassroomTools', () => {
  it('registers the seven tools with read, create and update classes', () => {
    const { registry } = setup();
    const by = Object.fromEntries(registry.tools.map((t) => [t.name, t]));
    expect(Object.keys(by).sort()).toEqual([
      'classroom_create_coursework',
      'classroom_create_material',
      'classroom_list_courses',
      'classroom_list_coursework',
      'classroom_list_materials',
      'classroom_list_submissions',
      'classroom_publish',
    ]);
    for (const n of ['classroom_list_courses', 'classroom_list_materials', 'classroom_list_coursework', 'classroom_list_submissions']) {
      expect(by[n].cud).toBe('read');
    }
    expect(by.classroom_create_material.cud).toBe('create');
    expect(by.classroom_create_coursework.cud).toBe('create');
    expect(by.classroom_publish.cud).toBe('update');
    for (const t of registry.tools) expect(t.service).toBe('classroom');
  });
});

describe('classroom_list_courses', () => {
  it('asks for ACTIVE courses by default and returns a compact list', async () => {
    const { call, last } = setup(() => ({ courses: [{ id: '1', name: 'Math', section: 'A', courseState: 'ACTIVE', extra: 'x' }], nextPageToken: 'tok' }));
    const { out } = await call('classroom_list_courses', {});
    expect(last().url).toContain('/v1/courses?');
    expect(last().url).toContain('courseStates=ACTIVE');
    expect(out).toEqual({ count: 1, courses: [{ id: '1', name: 'Math', section: 'A', courseState: 'ACTIVE' }], nextPageToken: 'tok' });
  });

  it('forwards pageSize and pageToken', async () => {
    const { call, last } = setup(() => ({}));
    const { out } = await call('classroom_list_courses', { pageSize: 5, pageToken: 'abc' });
    expect(last().url).toContain('pageSize=5');
    expect(last().url).toContain('pageToken=abc');
    expect(out).toEqual({ count: 0, courses: [] });
  });
});

describe('read tools', () => {
  it('lists materials with flattened attachments', async () => {
    const { call, last } = setup(() => ({
      courseWorkMaterial: [{
        id: 'm1', title: 'Slides', state: 'DRAFT',
        materials: [
          { driveFile: { driveFile: { id: 'f1', title: 'deck.pdf' }, shareMode: 'VIEW' } },
          { link: { url: 'https://example.com', title: 'Site' } },
        ],
      }],
    }));
    const { out } = await call('classroom_list_materials', { courseId: 'c1', states: ['DRAFT'] });
    expect(last().url).toContain('/v1/courses/c1/courseWorkMaterials?');
    expect(last().url).toContain('courseWorkMaterialStates=DRAFT');
    expect(out.materials[0].materials).toEqual([
      { type: 'driveFile', id: 'f1', title: 'deck.pdf' },
      { type: 'link', url: 'https://example.com', title: 'Site' },
    ]);
  });

  it('lists coursework and submissions', async () => {
    const cw = setup(() => ({ courseWork: [{ id: 'w1', title: 'HW', workType: 'ASSIGNMENT', state: 'PUBLISHED', maxPoints: 10 }] }));
    expect((await cw.call('classroom_list_coursework', { courseId: 'c1' })).out.coursework[0]).toMatchObject({ id: 'w1', maxPoints: 10 });
    expect(cw.last().url).toContain('/v1/courses/c1/courseWork?');

    const sub = setup(() => ({ studentSubmissions: [{ id: 's1', userId: 'u1', state: 'TURNED_IN', late: true }] }));
    const { out } = await sub.call('classroom_list_submissions', { courseId: 'c1', courseWorkId: '-', states: ['TURNED_IN'], userId: 'u1' });
    expect(sub.last().url).toContain('/v1/courses/c1/courseWork/-/studentSubmissions?');
    expect(sub.last().url).toContain('states=TURNED_IN');
    expect(sub.last().url).toContain('userId=u1');
    expect(out.submissions[0]).toMatchObject({ id: 's1', state: 'TURNED_IN', late: true });
  });

  it('passes a Google error through untouched', async () => {
    const fake = fakeServer();
    const registry = new ToolRegistry(fake.server as never, POLICY);
    const request = vi.fn(async () => {
      throw Object.assign(new Error('Not Found'), { code: 404, response: { status: 404, data: { error: { code: 404, message: 'Requested entity was not found.' } } } });
    });
    registerClassroomTools(registry, { getClientFn: (async () => ({ request })) as never });
    const res = (await fake.handlers.classroom_list_materials({ account: 'test', courseId: 'nope' })) as { isError?: boolean; content: { text: string }[] };
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('not found');
  });
});

describe('create tools', () => {
  it('creates a material as DRAFT by default with Drive attachments and links', async () => {
    const { call, last } = setup(() => ({ id: 'm9', title: 'Week 1', state: 'DRAFT' }));
    const { out } = await call('classroom_create_material', {
      courseId: 'c1', title: 'Week 1', driveFileIds: ['f1', 'f2'], links: [{ url: 'https://example.com/a', title: 'A' }, { url: 'https://example.com/b' }],
    });
    expect(last().method).toBe('POST');
    expect(last().url).toContain('/v1/courses/c1/courseWorkMaterials?');
    expect(last().data).toEqual({
      title: 'Week 1',
      state: 'DRAFT',
      materials: [
        { driveFile: { driveFile: { id: 'f1' }, shareMode: 'VIEW' } },
        { driveFile: { driveFile: { id: 'f2' }, shareMode: 'VIEW' } },
        { link: { url: 'https://example.com/a', title: 'A' } },
        { link: { url: 'https://example.com/b' } },
      ],
    });
    expect(out).toMatchObject({ id: 'm9', state: 'DRAFT' });
  });

  it('honours an explicit state, share mode and topic', async () => {
    const { call, last } = setup(() => ({ id: 'm1' }));
    await call('classroom_create_material', { courseId: 'c1', title: 'T', state: 'PUBLISHED', topicId: 't1', driveFileIds: ['f1'], shareMode: 'STUDENT_COPY', description: 'd' });
    expect(last().data).toMatchObject({ state: 'PUBLISHED', topicId: 't1', description: 'd', materials: [{ driveFile: { shareMode: 'STUDENT_COPY' } }] });
  });

  it('creates coursework as a DRAFT assignment with points and a due date', async () => {
    const { call, last } = setup(() => ({ id: 'w1', title: 'HW', state: 'DRAFT', workType: 'ASSIGNMENT' }));
    await call('classroom_create_coursework', { courseId: 'c1', title: 'HW', maxPoints: 20, dueDate: '2026-12-04', dueTime: '21:00' });
    expect(last().url).toContain('/v1/courses/c1/courseWork?');
    expect(last().data).toEqual({
      title: 'HW', workType: 'ASSIGNMENT', state: 'DRAFT', maxPoints: 20,
      dueDate: { year: 2026, month: 12, day: 4 }, dueTime: { hours: 21, minutes: 0 },
    });
  });

  it('defaults the due time to 23:59 and rejects bad or orphaned dates', async () => {
    const a = setup(() => ({ id: 'w1' }));
    await a.call('classroom_create_coursework', { courseId: 'c1', title: 'HW', dueDate: '2026-12-04' });
    expect((a.last().data as any).dueTime).toEqual({ hours: 23, minutes: 59 });

    const b = setup();
    const bad = await b.call('classroom_create_coursework', { courseId: 'c1', title: 'HW', dueDate: '04/12/2026' });
    expect(bad.res.isError).toBe(true);
    expect(bad.out.error).toBe('validation_error');
    const orphan = await b.call('classroom_create_coursework', { courseId: 'c1', title: 'HW', dueTime: '10:00' });
    expect(orphan.res.isError).toBe(true);
    expect(b.request).not.toHaveBeenCalled();
  });
});

describe('classroom_publish', () => {
  it('patches state to PUBLISHED on coursework with an update mask', async () => {
    const { call, last } = setup(() => ({ id: 'w1', state: 'PUBLISHED', title: 'HW' }));
    const { out } = await call('classroom_publish', { courseId: 'c1', kind: 'coursework', id: 'w1' });
    expect(last().method).toBe('PATCH');
    expect(last().url).toContain('/v1/courses/c1/courseWork/w1?');
    expect(last().url).toContain('updateMask=state');
    expect(last().data).toEqual({ state: 'PUBLISHED' });
    expect(out).toMatchObject({ id: 'w1', state: 'PUBLISHED' });
  });

  it('patches a material through its own endpoint', async () => {
    const { call, last } = setup(() => ({ id: 'm1', state: 'PUBLISHED' }));
    await call('classroom_publish', { courseId: 'c1', kind: 'material', id: 'm1' });
    expect(last().url).toContain('/v1/courses/c1/courseWorkMaterials/m1?');
  });
});

describe('helpers', () => {
  it('summarizeMaterial flattens known attachment kinds', () => {
    expect(summarizeMaterial({ youtubeVideo: { id: 'y', title: 'V' } })).toEqual({ type: 'youtubeVideo', id: 'y', title: 'V' });
    expect(summarizeMaterial({ form: { formUrl: 'https://f', title: 'F' } })).toEqual({ type: 'form', url: 'https://f', title: 'F' });
    expect(summarizeMaterial({})).toEqual({ type: 'unknown' });
  });
  it('parses dates and times strictly', () => {
    expect(parseDueDate('2026-02-30')).toEqual({ year: 2026, month: 2, day: 30 });
    expect(parseDueDate('2026-13-01')).toBeUndefined();
    expect(parseDueDate('tomorrow')).toBeUndefined();
    expect(parseDueTime('9:05')).toEqual({ hours: 9, minutes: 5 });
    expect(parseDueTime('24:00')).toBeUndefined();
  });
});
