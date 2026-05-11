import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { google } from 'googleapis';
import { ACCOUNTS } from '../accounts.js';
import type { Account } from '../accounts.js';
import { getClient } from '../client.js';
import { handleGoogleApiError } from './_errors.js';

const accountEnum = z.enum(ACCOUNTS);

export function registerTasksTools(server: McpServer): void {
  // ─── Tasklists ─────────────────────────────────────────────────────────

  server.registerTool(
    'tasks_lists_list',
    {
      description: 'List all tasklists (the user\'s top-level task containers)',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        maxResults: z.number().min(1).max(100).optional(),
        pageToken: z.string().optional(),
      },
    },
    async ({ account, maxResults, pageToken }) => {
      try {
        const auth = await getClient(account as Account);
        const tasks = google.tasks({ version: 'v1', auth });
        const res = await tasks.tasklists.list({
          maxResults: maxResults ?? 100,
          pageToken,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        return handleTasksError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'tasks_list_get',
    {
      description: 'Get a single tasklist by ID',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        tasklistId: z.string().describe('Tasklist ID'),
      },
    },
    async ({ account, tasklistId }) => {
      try {
        const auth = await getClient(account as Account);
        const tasks = google.tasks({ version: 'v1', auth });
        const res = await tasks.tasklists.get({ tasklist: tasklistId });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        return handleTasksError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'tasks_list_insert',
    {
      description: 'Create a new tasklist',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        title: z.string().describe('Tasklist title'),
      },
    },
    async ({ account, title }) => {
      try {
        const auth = await getClient(account as Account);
        const tasks = google.tasks({ version: 'v1', auth });
        const res = await tasks.tasklists.insert({
          requestBody: { title },
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        return handleTasksError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'tasks_list_update',
    {
      description: 'Rename a tasklist (PATCH semantics)',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        tasklistId: z.string().describe('Tasklist ID'),
        title: z.string().describe('New title'),
      },
    },
    async ({ account, tasklistId, title }) => {
      try {
        const auth = await getClient(account as Account);
        const tasks = google.tasks({ version: 'v1', auth });
        const res = await tasks.tasklists.patch({
          tasklist: tasklistId,
          requestBody: { title },
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        return handleTasksError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'tasks_list_delete',
    {
      description: 'Delete a tasklist and every task inside it',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        tasklistId: z.string().describe('Tasklist ID'),
      },
    },
    async ({ account, tasklistId }) => {
      try {
        const auth = await getClient(account as Account);
        const tasks = google.tasks({ version: 'v1', auth });
        await tasks.tasklists.delete({ tasklist: tasklistId });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ deleted: true, tasklistId }, null, 2) }],
        };
      } catch (error: any) {
        return handleTasksError(error, account as Account);
      }
    },
  );

  // ─── Tasks ─────────────────────────────────────────────────────────────

  server.registerTool(
    'tasks_list',
    {
      description: 'List tasks within a tasklist with rich filters',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        tasklistId: z.string().describe('Tasklist ID'),
        maxResults: z.number().min(1).max(100).optional(),
        pageToken: z.string().optional(),
        showCompleted: z.boolean().optional().describe('Include completed tasks (default: true)'),
        showDeleted: z.boolean().optional(),
        showHidden: z.boolean().optional(),
        showAssigned: z.boolean().optional(),
        completedMax: z.string().optional().describe('RFC 3339 upper bound on completion date'),
        completedMin: z.string().optional(),
        dueMax: z.string().optional(),
        dueMin: z.string().optional(),
        updatedMin: z.string().optional(),
      },
    },
    async ({ account, tasklistId, ...params }) => {
      try {
        const auth = await getClient(account as Account);
        const tasks = google.tasks({ version: 'v1', auth });
        const res = await tasks.tasks.list({
          tasklist: tasklistId,
          ...params,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        return handleTasksError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'tasks_get',
    {
      description: 'Get a single task',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        tasklistId: z.string().describe('Tasklist ID'),
        taskId: z.string().describe('Task ID'),
      },
    },
    async ({ account, tasklistId, taskId }) => {
      try {
        const auth = await getClient(account as Account);
        const tasks = google.tasks({ version: 'v1', auth });
        const res = await tasks.tasks.get({ tasklist: tasklistId, task: taskId });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        return handleTasksError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'tasks_insert',
    {
      description: 'Create a new task. Use parent to nest under another task, previous to position after a sibling.',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        tasklistId: z.string().describe('Tasklist ID'),
        title: z.string().describe('Task title'),
        notes: z.string().optional().describe('Task description'),
        due: z.string().optional().describe('Due date in RFC 3339 (e.g. 2026-06-15T00:00:00.000Z)'),
        status: z.enum(['needsAction', 'completed']).optional(),
        parent: z.string().optional().describe('Parent task ID for nesting'),
        previous: z.string().optional().describe('Position this task immediately after this sibling task ID'),
      },
    },
    async ({ account, tasklistId, title, notes, due, status, parent, previous }) => {
      try {
        const auth = await getClient(account as Account);
        const tasks = google.tasks({ version: 'v1', auth });
        const requestBody: any = { title };
        if (notes !== undefined) requestBody.notes = notes;
        if (due !== undefined) requestBody.due = due;
        if (status !== undefined) requestBody.status = status;

        const res = await tasks.tasks.insert({
          tasklist: tasklistId,
          parent,
          previous,
          requestBody,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        return handleTasksError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'tasks_update',
    {
      description: 'Update a task (PATCH semantics — only supplied fields change)',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        tasklistId: z.string().describe('Tasklist ID'),
        taskId: z.string().describe('Task ID'),
        title: z.string().optional(),
        notes: z.string().optional(),
        due: z.string().optional().describe('RFC 3339'),
        status: z.enum(['needsAction', 'completed']).optional(),
      },
    },
    async ({ account, tasklistId, taskId, title, notes, due, status }) => {
      try {
        const auth = await getClient(account as Account);
        const tasks = google.tasks({ version: 'v1', auth });
        const requestBody: any = {};
        if (title !== undefined) requestBody.title = title;
        if (notes !== undefined) requestBody.notes = notes;
        if (due !== undefined) requestBody.due = due;
        if (status !== undefined) requestBody.status = status;

        if (Object.keys(requestBody).length === 0) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'No fields to update' }) }], isError: true };
        }

        const res = await tasks.tasks.patch({
          tasklist: tasklistId,
          task: taskId,
          requestBody,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        return handleTasksError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'tasks_delete',
    {
      description: 'Delete a task',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        tasklistId: z.string().describe('Tasklist ID'),
        taskId: z.string().describe('Task ID'),
      },
    },
    async ({ account, tasklistId, taskId }) => {
      try {
        const auth = await getClient(account as Account);
        const tasks = google.tasks({ version: 'v1', auth });
        await tasks.tasks.delete({ tasklist: tasklistId, task: taskId });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ deleted: true, taskId }, null, 2) }],
        };
      } catch (error: any) {
        return handleTasksError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'tasks_move',
    {
      description: 'Reposition a task: change its parent, move it after a sibling, or move it to another tasklist',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        tasklistId: z.string().describe('Source tasklist ID'),
        taskId: z.string().describe('Task ID'),
        parent: z.string().optional().describe('New parent task ID'),
        previous: z.string().optional().describe('New sibling to position after'),
        destinationTasklist: z.string().optional().describe('Move to a different tasklist'),
      },
    },
    async ({ account, tasklistId, taskId, parent, previous, destinationTasklist }) => {
      try {
        const auth = await getClient(account as Account);
        const tasks = google.tasks({ version: 'v1', auth });
        const res = await tasks.tasks.move({
          tasklist: tasklistId,
          task: taskId,
          parent,
          previous,
          destinationTasklist,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        return handleTasksError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'tasks_clear',
    {
      description: 'Permanently delete every completed task in a tasklist',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        tasklistId: z.string().describe('Tasklist ID'),
      },
    },
    async ({ account, tasklistId }) => {
      try {
        const auth = await getClient(account as Account);
        const tasks = google.tasks({ version: 'v1', auth });
        await tasks.tasks.clear({ tasklist: tasklistId });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ cleared: true, tasklistId }, null, 2) }],
        };
      } catch (error: any) {
        return handleTasksError(error, account as Account);
      }
    },
  );
}

function handleTasksError(error: any, account: Account) {
  return handleGoogleApiError(error, account);
}
