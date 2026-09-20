import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import type { Transport, JSONRPCMessage } from "@modelcontextprotocol/server";
import {
  argNormalizationEnabled,
  normalizeCallArguments,
  normalizeMessage,
  withArgNormalization,
} from '../src/arg-normalize.js';
import { ToolRegistry } from '../src/registry.js';
import type { Policy } from '../src/write-control.js';

import type { ArgShape } from '../src/arg-normalize.js';

const SHAPE: ArgShape = new Map([
  ['account', 'other'],
  ['threadId', 'other'],
  ['messageId', 'other'],
  ['newParentFolderId', 'other'],
  ['maxResults', 'number'],
  ['replyAll', 'boolean'],
] as const);

describe('normalizeCallArguments', () => {
  it('renames a snake_case key to its declared camelCase twin', () => {
    const { args, renamed } = normalizeCallArguments(SHAPE, { account: 'work', thread_id: 'abc' });
    expect(args).toEqual({ account: 'work', threadId: 'abc' });
    expect(renamed).toEqual([['thread_id', 'threadId']]);
  });

  it('never clobbers: both spellings present leaves everything untouched', () => {
    const input = { threadId: 'right', thread_id: 'stale' };
    const { args, renamed } = normalizeCallArguments(SHAPE, input);
    expect(args).toBe(input);
    expect(renamed).toEqual([]);
  });

  it('leaves keys alone when the camelCase twin is not in the schema', () => {
    const input = { some_random_key: 1, account: 'work' };
    const { args, renamed } = normalizeCallArguments(SHAPE, input);
    expect(args).toBe(input);
    expect(renamed).toEqual([]);
  });

  it('handles multi-underscore keys', () => {
    const { args } = normalizeCallArguments(SHAPE, { new_parent_folder_id: 'f1' });
    expect(args).toEqual({ newParentFolderId: 'f1' });
  });

  it('coerces string-encoded scalars on RENAMED keys (clients type-strip unknown keys)', () => {
    expect(normalizeCallArguments(SHAPE, { max_results: '2' }).args).toEqual({ maxResults: 2 });
    expect(normalizeCallArguments(SHAPE, { max_results: '-1.5' }).args).toEqual({ maxResults: -1.5 });
    expect(normalizeCallArguments(SHAPE, { reply_all: 'true' }).args).toEqual({ replyAll: true });
    expect(normalizeCallArguments(SHAPE, { reply_all: 'False' }).args).toEqual({ replyAll: false });
  });

  it('never coerces non-parseable strings, non-strings, or declared keys', () => {
    expect(normalizeCallArguments(SHAPE, { max_results: 'abc' }).args).toEqual({ maxResults: 'abc' });
    expect(normalizeCallArguments(SHAPE, { max_results: 3 }).args).toEqual({ maxResults: 3 });
    const declared = { maxResults: '2' };
    expect(normalizeCallArguments(SHAPE, declared).args).toBe(declared);
  });
});

describe('normalizeMessage', () => {
  const shapeFor = (tool: string) => (tool === 'gmail_read_thread' ? SHAPE : undefined);
  const call = (name: string, args: unknown): JSONRPCMessage =>
    ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) as JSONRPCMessage;

  it('rewrites tools/call arguments and logs key names only', () => {
    const log = vi.fn();
    const out = normalizeMessage(call('gmail_read_thread', { thread_id: 'x' }), shapeFor, log) as never as {
      params: { arguments: Record<string, unknown> };
    };
    expect(out.params.arguments).toEqual({ threadId: 'x' });
    expect(log).toHaveBeenCalledWith('[args] gmail_read_thread: thread_id -> threadId');
    expect(String(log.mock.calls[0][0])).not.toContain('x');
  });

  it('returns the message unchanged for unknown tools, other methods, and clean calls', () => {
    const log = vi.fn();
    const unknownTool = call('other_tool', { thread_id: 'x' });
    expect(normalizeMessage(unknownTool, shapeFor, log)).toBe(unknownTool);
    const list = { jsonrpc: '2.0', id: 2, method: 'tools/list' } as JSONRPCMessage;
    expect(normalizeMessage(list, shapeFor, log)).toBe(list);
    const clean = call('gmail_read_thread', { threadId: 'x' });
    expect(normalizeMessage(clean, shapeFor, log)).toBe(clean);
    expect(log).not.toHaveBeenCalled();
  });
});

describe('withArgNormalization transport wrapper', () => {
  function fakeTransport() {
    const t = {
      sent: [] as JSONRPCMessage[],
      start: vi.fn(async () => {}),
      send: vi.fn(async (m: JSONRPCMessage) => {
        t.sent.push(m);
      }),
      close: vi.fn(async () => {}),
    } as unknown as Transport & { sent: JSONRPCMessage[] };
    return t;
  }

  it('normalizes inbound tools/call before the assigned handler sees it', () => {
    const inner = fakeTransport();
    const wrapped = withArgNormalization(inner, () => SHAPE, () => {});
    const received: JSONRPCMessage[] = [];
    wrapped.onmessage = (m) => received.push(m); // what Protocol.connect() does
    inner.onmessage!({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 't', arguments: { thread_id: 'x' } } } as JSONRPCMessage);
    expect((received[0] as never as { params: { arguments: unknown } }).params.arguments).toEqual({ threadId: 'x' });
  });

  it('delegates start/send/close and the other callbacks', async () => {
    const inner = fakeTransport();
    const wrapped = withArgNormalization(inner, () => undefined);
    await wrapped.start();
    const msg = { jsonrpc: '2.0', id: 9, result: {} } as JSONRPCMessage;
    await wrapped.send(msg);
    await wrapped.close();
    expect(inner.start).toHaveBeenCalledTimes(1);
    expect(inner.sent).toEqual([msg]);
    expect(inner.close).toHaveBeenCalledTimes(1);
    const onclose = () => {};
    wrapped.onclose = onclose;
    expect(inner.onclose).toBe(onclose);
  });
});

describe('registry integration + flag', () => {
  it('registry.argShape feeds the normalizer with the declared keys (fanout account included)', () => {
    const POLICY: Policy = { profile: 'safe-writes', readOnly: false, allow: [], deny: [] };
    const server = { registerTool: () => 'ok', sendToolListChanged: vi.fn(), server: { setRequestHandler: () => {} } };
    const registry = new ToolRegistry(server as never, POLICY, 'lazy');
    registry.registerTool(
      'gmail_read_thread',
      {
        description: 'x',
        inputSchema: {
          account: z.string().optional(),
          threadId: z.string(),
          maxResults: z.number().min(1).default(20).optional(),
          full: z.boolean().optional(),
        },
      },
      () => {},
    );
    const shape = registry.argShape('gmail_read_thread')!;
    expect([...shape.keys()].sort()).toEqual(['account', 'full', 'maxResults', 'threadId']);
    expect(shape.get('maxResults')).toBe('number');
    expect(shape.get('full')).toBe('boolean');
    expect(shape.get('threadId')).toBe('other');
    expect(registry.argShape('nope')).toBeUndefined();

    const out = normalizeMessage(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'gmail_read_thread', arguments: { thread_id: 'z' } } } as JSONRPCMessage,
      (n) => registry.argShape(n),
      () => {},
    ) as never as { params: { arguments: Record<string, unknown> } };
    expect(out.params.arguments).toEqual({ threadId: 'z' });
  });

  it('GOOGLE_ARG_NORMALIZE=off disables, default enables', () => {
    expect(argNormalizationEnabled({} as NodeJS.ProcessEnv)).toBe(true);
    expect(argNormalizationEnabled({ GOOGLE_ARG_NORMALIZE: 'off' } as NodeJS.ProcessEnv)).toBe(false);
    expect(argNormalizationEnabled({ GOOGLE_ARG_NORMALIZE: '0' } as NodeJS.ProcessEnv)).toBe(false);
    expect(argNormalizationEnabled({ GOOGLE_ARG_NORMALIZE: 'on' } as NodeJS.ProcessEnv)).toBe(true);
  });
});
