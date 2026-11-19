import type { ToolRegistry } from '../registry.js';
import { z } from 'zod';
import { accountArgLive } from '../accounts.js';
import { executeApiMethod, jsonResult, type ApiMethodRef, type ExecuteDeps, type QueryParams } from '../executor.js';
import { coerceArray, coerceNumber } from './_coerce.js';

/**
 * Curated Classroom tools: compact reads, drafts by default, and a separate
 * publish step. The generated classroom_* per-method tools stay available for
 * everything else (announcements, rosters, grading, add-ons).
 */

const BASE = 'https://classroom.googleapis.com/';
const SC = 'https://www.googleapis.com/auth/classroom.';

const COURSES_SCOPES = [`${SC}courses`, `${SC}courses.readonly`] as const;
const COURSEWORK_READ_SCOPES = [`${SC}coursework.students`, `${SC}coursework.students.readonly`, `${SC}coursework.me`, `${SC}coursework.me.readonly`] as const;
const COURSEWORK_WRITE_SCOPES = [`${SC}coursework.students`] as const;
const MATERIALS_READ_SCOPES = [`${SC}courseworkmaterials`, `${SC}courseworkmaterials.readonly`] as const;
const MATERIALS_WRITE_SCOPES = [`${SC}courseworkmaterials`] as const;
const SUBMISSIONS_SCOPES = [
  `${SC}coursework.students`,
  `${SC}coursework.students.readonly`,
  `${SC}student-submissions.students.readonly`,
] as const;

const METHODS = {
  coursesList: { id: 'classroom.courses.list', httpMethod: 'GET', path: 'v1/courses', baseUrl: BASE, requiredParams: [], scopes: COURSES_SCOPES },
  materialsList: { id: 'classroom.courses.courseWorkMaterials.list', httpMethod: 'GET', path: 'v1/courses/{courseId}/courseWorkMaterials', baseUrl: BASE, requiredParams: ['courseId'], scopes: MATERIALS_READ_SCOPES },
  courseWorkList: { id: 'classroom.courses.courseWork.list', httpMethod: 'GET', path: 'v1/courses/{courseId}/courseWork', baseUrl: BASE, requiredParams: ['courseId'], scopes: COURSEWORK_READ_SCOPES },
  submissionsList: { id: 'classroom.courses.courseWork.studentSubmissions.list', httpMethod: 'GET', path: 'v1/courses/{courseId}/courseWork/{courseWorkId}/studentSubmissions', baseUrl: BASE, requiredParams: ['courseId', 'courseWorkId'], scopes: SUBMISSIONS_SCOPES },
  materialCreate: { id: 'classroom.courses.courseWorkMaterials.create', httpMethod: 'POST', path: 'v1/courses/{courseId}/courseWorkMaterials', baseUrl: BASE, requiredParams: ['courseId'], scopes: MATERIALS_WRITE_SCOPES },
  courseWorkCreate: { id: 'classroom.courses.courseWork.create', httpMethod: 'POST', path: 'v1/courses/{courseId}/courseWork', baseUrl: BASE, requiredParams: ['courseId'], scopes: COURSEWORK_WRITE_SCOPES },
  courseWorkPatch: { id: 'classroom.courses.courseWork.patch', httpMethod: 'PATCH', path: 'v1/courses/{courseId}/courseWork/{id}', baseUrl: BASE, requiredParams: ['courseId', 'id'], scopes: COURSEWORK_WRITE_SCOPES },
  materialPatch: { id: 'classroom.courses.courseWorkMaterials.patch', httpMethod: 'PATCH', path: 'v1/courses/{courseId}/courseWorkMaterials/{id}', baseUrl: BASE, requiredParams: ['courseId', 'id'], scopes: MATERIALS_WRITE_SCOPES },
} satisfies Record<string, ApiMethodRef>;

const SHARE_MODES = ['VIEW', 'EDIT', 'STUDENT_COPY'] as const;

type Rec = Record<string, unknown>;

function asRec(v: unknown): Rec {
  return v && typeof v === 'object' ? (v as Rec) : {};
}

/** Parse the executor's success text; undefined when it is not a JSON object (errors pass through untouched). */
function parseOk(res: { content: { text: string }[]; isError?: boolean }): Rec | undefined {
  if (res.isError) return undefined;
  try {
    const v = JSON.parse(res.content[0]?.text ?? '');
    return v && typeof v === 'object' ? (v as Rec) : undefined;
  } catch {
    return undefined;
  }
}

function pick(o: Rec, keys: readonly string[]): Rec {
  const out: Rec = {};
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) out[k] = o[k];
  return out;
}

/** One attachment as `{type, id|url, title}`; the raw nesting is Classroom's, not useful to a model. */
export function summarizeMaterial(m: unknown): Rec {
  const r = asRec(m);
  if (r.driveFile) {
    const f = asRec(asRec(r.driveFile).driveFile);
    return { type: 'driveFile', id: f.id, title: f.title };
  }
  if (r.link) {
    const l = asRec(r.link);
    return { type: 'link', url: l.url, title: l.title };
  }
  if (r.youtubeVideo) {
    const y = asRec(r.youtubeVideo);
    return { type: 'youtubeVideo', id: y.id, title: y.title };
  }
  if (r.form) {
    const f = asRec(r.form);
    return { type: 'form', url: f.formUrl, title: f.title };
  }
  return { type: 'unknown' };
}

function summarizeItem(o: unknown, keys: readonly string[]): Rec {
  const r = asRec(o);
  const out = pick(r, keys);
  if (Array.isArray(r.materials)) out.materials = r.materials.map(summarizeMaterial);
  return out;
}

const COURSE_KEYS = ['id', 'name', 'section', 'descriptionHeading', 'courseState', 'enrollmentCode', 'alternateLink'] as const;
const MATERIAL_KEYS = ['id', 'title', 'description', 'state', 'topicId', 'scheduledTime', 'updateTime', 'alternateLink'] as const;
const COURSEWORK_KEYS = ['id', 'title', 'description', 'workType', 'state', 'maxPoints', 'dueDate', 'dueTime', 'topicId', 'scheduledTime', 'updateTime', 'alternateLink'] as const;
const SUBMISSION_KEYS = ['id', 'userId', 'state', 'late', 'assignedGrade', 'draftGrade', 'updateTime', 'alternateLink'] as const;

function listAnswer(data: Rec, apiKey: string, outKey: string, keys: readonly string[]): Rec {
  const items = Array.isArray(data[apiKey]) ? (data[apiKey] as unknown[]) : [];
  const out: Rec = { count: items.length, [outKey]: items.map((i) => summarizeItem(i, keys)) };
  if (typeof data.nextPageToken === 'string' && data.nextPageToken) out.nextPageToken = data.nextPageToken;
  return out;
}

function attachmentList(driveFileIds: string[] | undefined, links: { url: string; title?: string }[] | undefined, shareMode: string): Rec[] {
  const out: Rec[] = [];
  for (const id of driveFileIds ?? []) out.push({ driveFile: { driveFile: { id }, shareMode } });
  for (const l of links ?? []) out.push({ link: l.title ? { url: l.url, title: l.title } : { url: l.url } });
  return out;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{1,2}):(\d{2})$/;

export function parseDueDate(s: string): { year: number; month: number; day: number } | undefined {
  const m = DATE_RE.exec(s.trim());
  if (!m) return undefined;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  return { year, month, day };
}

export function parseDueTime(s: string): { hours: number; minutes: number } | undefined {
  const m = TIME_RE.exec(s.trim());
  if (!m) return undefined;
  const [hours, minutes] = [Number(m[1]), Number(m[2])];
  if (hours > 23 || minutes > 59) return undefined;
  return { hours, minutes };
}

function invalid(message: string) {
  return jsonResult({ error: 'validation_error', message, retriable: false }, true);
}

const linkSchema = z.object({
  url: z.string().url().describe('Link address (https)'),
  title: z.string().optional().describe('Link title shown to students'),
});

export function registerClassroomTools(registry: ToolRegistry, deps: ExecuteDeps = {}): void {
  const account = accountArgLive(() => registry.accountAliases()).optional().describe('Google account alias (omit for the default account)');
  const register = registry.registerTool as unknown as (
    name: string,
    config: { description: string; inputSchema: z.ZodRawShape; annotations?: Record<string, unknown>; requiredScopes?: readonly string[] },
    handler: (args: never) => Promise<unknown>,
  ) => void;

  const pageArgs = {
    pageSize: coerceNumber(z.number().int().min(1).max(100)).optional().describe('Items per page (default 30)'),
    pageToken: z.string().optional().describe('nextPageToken from the previous answer'),
  };

  async function run(method: ApiMethodRef, acct: string | undefined, args: { pathParams?: Record<string, string>; queryParams?: QueryParams; body?: unknown }) {
    return executeApiMethod(method, { account: acct as string, ...args }, deps);
  }

  function listQuery(a: { pageSize?: number; pageToken?: string }): QueryParams {
    const q: QueryParams = {};
    if (a.pageSize !== undefined) q.pageSize = a.pageSize;
    if (a.pageToken) q.pageToken = a.pageToken;
    return q;
  }

  register(
    'classroom_list_courses',
    {
      description: 'List Google Classroom courses the account teaches or attends (id, name, section, state, link). Active courses by default.',
      inputSchema: {
        account,
        courseStates: coerceArray(z.enum(['ACTIVE', 'ARCHIVED', 'PROVISIONED', 'DECLINED', 'SUSPENDED'])).optional().describe('Course states to include (default ACTIVE)'),
        ...pageArgs,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
      requiredScopes: COURSES_SCOPES,
    },
    async (a: { account?: string; courseStates?: string[]; pageSize?: number; pageToken?: string }) => {
      const q = listQuery(a);
      q.courseStates = a.courseStates?.length ? a.courseStates : ['ACTIVE'];
      const res = await run(METHODS.coursesList, a.account, { queryParams: q });
      const data = parseOk(res);
      return data ? jsonResult(listAnswer(data, 'courses', 'courses', COURSE_KEYS)) : res;
    },
  );

  register(
    'classroom_list_materials',
    {
      description: 'List the materials of one Classroom course (id, title, state DRAFT or PUBLISHED, attachments). Newest first.',
      inputSchema: {
        account,
        courseId: z.string().min(1).describe('Course id (from classroom_list_courses)'),
        states: coerceArray(z.enum(['DRAFT', 'PUBLISHED', 'DELETED'])).optional().describe('Material states to include (default PUBLISHED)'),
        ...pageArgs,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
      requiredScopes: MATERIALS_READ_SCOPES,
    },
    async (a: { account?: string; courseId: string; states?: string[]; pageSize?: number; pageToken?: string }) => {
      const q = listQuery(a);
      if (a.states?.length) q.courseWorkMaterialStates = a.states;
      const res = await run(METHODS.materialsList, a.account, { pathParams: { courseId: a.courseId }, queryParams: q });
      const data = parseOk(res);
      return data ? jsonResult(listAnswer(data, 'courseWorkMaterial', 'materials', MATERIAL_KEYS)) : res;
    },
  );

  register(
    'classroom_list_coursework',
    {
      description: 'List the assignments and questions of one Classroom course (id, title, type, state, points, due date, attachments). Newest first.',
      inputSchema: {
        account,
        courseId: z.string().min(1).describe('Course id (from classroom_list_courses)'),
        states: coerceArray(z.enum(['DRAFT', 'PUBLISHED', 'DELETED'])).optional().describe('States to include (default PUBLISHED)'),
        ...pageArgs,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
      requiredScopes: COURSEWORK_READ_SCOPES,
    },
    async (a: { account?: string; courseId: string; states?: string[]; pageSize?: number; pageToken?: string }) => {
      const q = listQuery(a);
      if (a.states?.length) q.courseWorkStates = a.states;
      const res = await run(METHODS.courseWorkList, a.account, { pathParams: { courseId: a.courseId }, queryParams: q });
      const data = parseOk(res);
      return data ? jsonResult(listAnswer(data, 'courseWork', 'coursework', COURSEWORK_KEYS)) : res;
    },
  );

  register(
    'classroom_list_submissions',
    {
      description: 'List student submissions for one assignment (id, student userId, state, late, grade). Pass "-" as courseWorkId for every assignment of the course.',
      inputSchema: {
        account,
        courseId: z.string().min(1).describe('Course id'),
        courseWorkId: z.string().min(1).describe('Assignment id from classroom_list_coursework, or "-" for all'),
        states: coerceArray(z.enum(['NEW', 'CREATED', 'TURNED_IN', 'RETURNED', 'RECLAIMED_BY_STUDENT'])).optional().describe('Submission states to include'),
        userId: z.string().optional().describe('Only this student (user id, or "me")'),
        ...pageArgs,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
      requiredScopes: SUBMISSIONS_SCOPES,
    },
    async (a: { account?: string; courseId: string; courseWorkId: string; states?: string[]; userId?: string; pageSize?: number; pageToken?: string }) => {
      const q = listQuery(a);
      if (a.states?.length) q.states = a.states;
      if (a.userId) q.userId = a.userId;
      const res = await run(METHODS.submissionsList, a.account, { pathParams: { courseId: a.courseId, courseWorkId: a.courseWorkId }, queryParams: q });
      const data = parseOk(res);
      if (!data) return res;
      return jsonResult(listAnswer(data, 'studentSubmissions', 'submissions', SUBMISSION_KEYS));
    },
  );

  const attachmentArgs = {
    driveFileIds: coerceArray(z.string().min(1)).optional().describe('Drive file ids to attach (the files must already be in Drive)'),
    links: z.array(linkSchema).optional().describe('Links to attach'),
    shareMode: z.enum(SHARE_MODES).optional().describe('How students get the Drive files: VIEW (default), EDIT, or STUDENT_COPY (each student gets a copy)'),
  };

  register(
    'classroom_create_material',
    {
      description:
        'Create a Classroom material (a post of resources, no grade) as a DRAFT unless you pass state PUBLISHED. Attach Drive files by id and links. A draft is invisible to students until classroom_publish.',
      inputSchema: {
        account,
        courseId: z.string().min(1).describe('Course id'),
        title: z.string().min(1).max(3000).describe('Material title'),
        description: z.string().max(30000).optional().describe('Material text'),
        topicId: z.string().optional().describe('Topic id to file it under'),
        state: z.enum(['DRAFT', 'PUBLISHED']).optional().describe('DRAFT (default) or PUBLISHED'),
        ...attachmentArgs,
      },
      annotations: { openWorldHint: true },
      requiredScopes: MATERIALS_WRITE_SCOPES,
    },
    async (a: { account?: string; courseId: string; title: string; description?: string; topicId?: string; state?: 'DRAFT' | 'PUBLISHED'; driveFileIds?: string[]; links?: { url: string; title?: string }[]; shareMode?: string }) => {
      const body: Rec = { title: a.title, state: a.state ?? 'DRAFT' };
      if (a.description) body.description = a.description;
      if (a.topicId) body.topicId = a.topicId;
      const mats = attachmentList(a.driveFileIds, a.links, a.shareMode ?? 'VIEW');
      if (mats.length) body.materials = mats;
      const res = await run(METHODS.materialCreate, a.account, { pathParams: { courseId: a.courseId }, body });
      const data = parseOk(res);
      return data ? jsonResult(summarizeItem(data, MATERIAL_KEYS)) : res;
    },
  );

  register(
    'classroom_create_coursework',
    {
      description:
        'Create a Classroom assignment (or short-answer question) as a DRAFT unless you pass state PUBLISHED. Attach Drive files by id and links, set points and a due date. A draft is invisible to students until classroom_publish.',
      inputSchema: {
        account,
        courseId: z.string().min(1).describe('Course id'),
        title: z.string().min(1).max(3000).describe('Assignment title'),
        description: z.string().max(30000).optional().describe('Instructions'),
        workType: z.enum(['ASSIGNMENT', 'SHORT_ANSWER_QUESTION']).optional().describe('ASSIGNMENT (default) or SHORT_ANSWER_QUESTION'),
        maxPoints: coerceNumber(z.number().min(0)).optional().describe('Maximum points (omit for ungraded)'),
        dueDate: z.string().optional().describe('Due date YYYY-MM-DD'),
        dueTime: z.string().optional().describe('Due time HH:MM in UTC (Classroom stores UTC; needs dueDate)'),
        topicId: z.string().optional().describe('Topic id to file it under'),
        state: z.enum(['DRAFT', 'PUBLISHED']).optional().describe('DRAFT (default) or PUBLISHED'),
        ...attachmentArgs,
      },
      annotations: { openWorldHint: true },
      requiredScopes: COURSEWORK_WRITE_SCOPES,
    },
    async (a: { account?: string; courseId: string; title: string; description?: string; workType?: string; maxPoints?: number; dueDate?: string; dueTime?: string; topicId?: string; state?: 'DRAFT' | 'PUBLISHED'; driveFileIds?: string[]; links?: { url: string; title?: string }[]; shareMode?: string }) => {
      const body: Rec = { title: a.title, workType: a.workType ?? 'ASSIGNMENT', state: a.state ?? 'DRAFT' };
      if (a.description) body.description = a.description;
      if (a.topicId) body.topicId = a.topicId;
      if (a.maxPoints !== undefined) body.maxPoints = a.maxPoints;
      if (a.dueDate) {
        const d = parseDueDate(a.dueDate);
        if (!d) return invalid('dueDate must be YYYY-MM-DD, for example 2026-12-04.');
        body.dueDate = d;
        const t = a.dueTime ? parseDueTime(a.dueTime) : { hours: 23, minutes: 59 };
        if (!t) return invalid('dueTime must be HH:MM in UTC, for example 21:00.');
        body.dueTime = t;
      } else if (a.dueTime) {
        return invalid('dueTime needs a dueDate.');
      }
      const mats = attachmentList(a.driveFileIds, a.links, a.shareMode ?? 'VIEW');
      if (mats.length) body.materials = mats;
      const res = await run(METHODS.courseWorkCreate, a.account, { pathParams: { courseId: a.courseId }, body });
      const data = parseOk(res);
      return data ? jsonResult(summarizeItem(data, COURSEWORK_KEYS)) : res;
    },
  );

  register(
    'classroom_publish',
    {
      description:
        'Publish a DRAFT Classroom assignment or material so students see it (and are notified). Get the id from classroom_create_coursework, classroom_create_material or a list tool with states DRAFT.',
      inputSchema: {
        account,
        courseId: z.string().min(1).describe('Course id'),
        kind: z.enum(['coursework', 'material']).describe('coursework for an assignment or question, material for a material'),
        id: z.string().min(1).describe('Item id'),
      },
      annotations: { openWorldHint: true },
      requiredScopes: [...COURSEWORK_WRITE_SCOPES, ...MATERIALS_WRITE_SCOPES],
    },
    async (a: { account?: string; courseId: string; kind: 'coursework' | 'material'; id: string }) => {
      const material = a.kind === 'material';
      const res = await run(material ? METHODS.materialPatch : METHODS.courseWorkPatch, a.account, {
        pathParams: { courseId: a.courseId, id: a.id },
        queryParams: { updateMask: 'state' },
        body: { state: 'PUBLISHED' },
      });
      const data = parseOk(res);
      return data ? jsonResult(summarizeItem(data, material ? MATERIAL_KEYS : COURSEWORK_KEYS)) : res;
    },
  );
}
