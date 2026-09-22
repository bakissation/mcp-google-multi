import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import type { Transport, JSONRPCMessage } from "@modelcontextprotocol/server";
import {
  argNormalizationEnabled,
  normalizeCallArguments,
  normalizeMessage,
  screenMessage,
  withArgNormalization,
  withValidationEnvelope,
  type ScreenOutcome,
  type StrictArgOptions,
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

// The reject path had no coverage at all while it was opt-in. It is the
// default now, so every branch that decides forward-vs-reject is pinned here.
describe('screenMessage (unknown-argument screening)', () => {
  const DECLARED: Record<string, readonly string[]> = {
    drive_create_folder: ['account', 'name', 'parentFolderId'],
    drive_discover: ['query'],
    discover_all: [],
  };
  const strict = (mode: 'reject' | 'warn' | 'off', onDrop?: (t: string, k: string[]) => void): StrictArgOptions => ({
    mode,
    declaredFor: (t) => DECLARED[t],
    onDrop,
  });
  const call = (name: string, args: Record<string, unknown>, id: number | null = 1) =>
    ({ jsonrpc: '2.0', ...(id === null ? {} : { id }), method: 'tools/call', params: { name, arguments: args } }) as JSONRPCMessage;

  const envelopeOf = (out: ScreenOutcome) => {
    if (out.action !== 'reject') throw new Error('expected a reject');
    const r = out.response as never as { result: { content: Array<{ text: string }>; isError: boolean } };
    expect(r.result.isError).toBe(true);
    return JSON.parse(r.result.content[0].text) as Record<string, unknown>;
  };

  it('rejects an undeclared key and names the likely spelling', () => {
    const out = screenMessage(call('drive_create_folder', { account: 'w', name: 'R', parentId: 'abc' }), strict('reject'), () => {});
    const env = envelopeOf(out);
    expect(env.error).toBe('unknown_argument');
    expect(env.message).toContain('parentId');
    expect(env.hint).toContain('parentFolderId');
    expect(env.retriable).toBe(false);
  });

  it('answers as a tool result, not a JSON-RPC error, so the model can self-correct', () => {
    const out = screenMessage(call('drive_create_folder', { parentId: 'x' }, 42), strict('reject'), () => {});
    if (out.action !== 'reject') throw new Error('expected a reject');
    const r = out.response as never as { id: number; error?: unknown; result?: unknown };
    expect(r.id).toBe(42);
    expect(r.error).toBeUndefined();
    expect(r.result).toBeDefined();
  });

  it('warn forwards the call untouched but still reports the drop', () => {
    const onDrop = vi.fn();
    const log = vi.fn();
    const msg = call('drive_create_folder', { parentId: 'x' });
    const out = screenMessage(msg, strict('warn', onDrop), log);
    expect(out.action).toBe('forward');
    // The caller's own key is never handed to the metrics observer: only the
    // DECLARED key it resolved to, or the literal placeholder. That is the
    // closed-vocabulary rule that keeps local metrics free of caller strings.
    expect(onDrop).toHaveBeenCalledWith('drive_create_folder', ['parentFolderId']);
    expect(String(log.mock.calls[0]?.[0])).toContain('dropped');
  });

  it('records _unmatched, never the caller key, when nothing resembles it', () => {
    const onDrop = vi.fn();
    screenMessage(call('drive_create_folder', { zzzNotAnArg: 1 }), strict('warn', onDrop), () => {});
    expect(onDrop).toHaveBeenCalledWith('drive_create_folder', ['_unmatched']);
  });

  it('off forwards without screening', () => {
    const onDrop = vi.fn();
    expect(screenMessage(call('drive_create_folder', { parentId: 'x' }), strict('off', onDrop), () => {}).action).toBe('forward');
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('forwards declared keys, client artifacts and metadata keys', () => {
    for (const args of [
      { account: 'w', name: 'R', parentFolderId: 'abc' },
      { query: 'x', random_string: 'dummy' },
      { query: 'x', toolCallId: 'call_1' },
      { query: 'x', _meta: { trace: 1 } },
      { query: 'x', 'acme.dev/trace': 't1' },
    ]) {
      const tool = 'query' in args ? 'drive_discover' : 'drive_create_folder';
      expect(screenMessage(call(tool, args), strict('reject'), () => {}).action).toBe('forward');
    }
  });

  it('forwards a redundant duplicate: the declared spelling already won', () => {
    const msg = call('drive_create_folder', { parentFolderId: 'real', parentId: 'ignored' });
    expect(screenMessage(msg, strict('reject'), () => {}).action).toBe('forward');
  });

  it('forwards an unregistered tool so the SDK answers "not found"', () => {
    expect(screenMessage(call('nope_not_a_tool', { anything: 1 }), strict('reject'), () => {}).action).toBe('forward');
  });

  it('forwards a tool that declares no arguments', () => {
    expect(screenMessage(call('discover_all', { anything: 1 }), strict('reject'), () => {}).action).toBe('forward');
  });

  it('forwards a notification, which has no id to answer on', () => {
    expect(screenMessage(call('drive_create_folder', { parentId: 'x' }, null), strict('reject'), () => {}).action).toBe('forward');
  });
});

describe('withArgNormalization strict wiring', () => {
  function fakeTransport(sendImpl?: (m: JSONRPCMessage) => Promise<void>) {
    const t = {
      sent: [] as JSONRPCMessage[],
      start: vi.fn(async () => {}),
      send: vi.fn(async (m: JSONRPCMessage) => {
        t.sent.push(m);
        if (sendImpl) await sendImpl(m);
      }),
      close: vi.fn(async () => {}),
    } as unknown as Transport & { sent: JSONRPCMessage[] };
    return t;
  }
  const STRICT: StrictArgOptions = { mode: 'reject', declaredFor: () => ['account', 'threadId'] };
  const bad = { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 't', arguments: { thread: 'x' } } } as JSONRPCMessage;

  it('answers on the inner transport and never dispatches', () => {
    const inner = fakeTransport();
    const wrapped = withArgNormalization(inner, () => undefined, () => {}, undefined, STRICT);
    const received: JSONRPCMessage[] = [];
    wrapped.onmessage = (m) => received.push(m);
    inner.onmessage!(bad);
    expect(received).toEqual([]);
    expect(inner.sent).toHaveLength(1);
  });

  it('renames a snake_case twin before screening, so a fixable key is not rejected', () => {
    const inner = fakeTransport();
    const shape = new Map([['threadId', 'other' as const]]);
    const wrapped = withArgNormalization(inner, () => shape, () => {}, undefined, STRICT);
    const received: JSONRPCMessage[] = [];
    wrapped.onmessage = (m) => received.push(m);
    inner.onmessage!({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 't', arguments: { thread_id: 'x' } } } as JSONRPCMessage);
    expect(inner.sent).toEqual([]);
    expect((received[0] as never as { params: { arguments: unknown } }).params.arguments).toEqual({ threadId: 'x' });
  });

  it('falls back to dispatch when the reject frame cannot be sent', async () => {
    const inner = fakeTransport(async () => {
      throw new Error('socket gone');
    });
    const wrapped = withArgNormalization(inner, () => undefined, () => {}, undefined, STRICT);
    const received: JSONRPCMessage[] = [];
    wrapped.onmessage = (m) => received.push(m);
    inner.onmessage!(bad);
    await new Promise((r) => setImmediate(r));
    expect(received).toHaveLength(1);
  });
});

// The SDK validates tool input itself and answers with bare prose: no handler
// of ours runs, so no envelope exists and the client gets free text.
describe('withValidationEnvelope (outbound)', () => {
  function harness(opts = { isKnownTool: () => true, defaultAccount: () => 'work' as string | undefined }) {
    const sent: JSONRPCMessage[] = [];
    const inner = {
      start: vi.fn(async () => {}),
      send: vi.fn(async (m: JSONRPCMessage) => { sent.push(m); }),
      close: vi.fn(async () => {}),
    } as unknown as Transport;
    const wrapped = withValidationEnvelope(inner, opts);
    wrapped.onmessage = () => {};
    return { inner, wrapped, sent };
  }
  const call = (id: number, name: string, args: Record<string, unknown> = {}) =>
    ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) as JSONRPCMessage;
  const isErrorText = (id: number, text: string) =>
    ({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: true } }) as unknown as JSONRPCMessage;
  const body = (m: JSONRPCMessage) =>
    (m as never as { result: { content: { text: string }[] } }).result.content[0].text;

  it('converts the SDK validation prose into the 6.0.0 envelope', async () => {
    const { inner, wrapped, sent } = harness();
    inner.onmessage!(call(1, 'gmail_search', { account: 'work' }));
    await wrapped.send(isErrorText(1, 'Input validation error: Invalid arguments for tool gmail_search: account: Unknown account alias. Valid: work'));
    const env = JSON.parse(body(sent[0]));
    expect(env.error).toBe('validation_error');
    expect(env.message).toContain('Unknown account alias');
    expect(env.hint).toBeTruthy();
    expect(env.retriable).toBe(false);
    expect(env.account).toBe('work');
  });

  it('recovers the account from the REQUEST, which validation never got past', async () => {
    const { inner, wrapped, sent } = harness();
    inner.onmessage!(call(2, 'gmail_search', { account: 'other' }));
    await wrapped.send(isErrorText(2, 'Input validation error: Invalid arguments for tool gmail_search: query: expected string'));
    expect(JSON.parse(body(sent[0])).account).toBe('other');
  });

  it('leaves a handler-authored envelope alone', async () => {
    const { inner, wrapped, sent } = harness();
    const envelope = JSON.stringify({ error: 'not_found', message: 'gone', retriable: false, account: 'work' });
    inner.onmessage!(call(3, 'gmail_read'));
    await wrapped.send(isErrorText(3, envelope));
    expect(body(sent[0])).toBe(envelope);
  });

  // The account wizard answers in prose today; rewriting it would relabel a
  // configuration refusal as a server fault.
  it('leaves handler-authored PROSE alone', async () => {
    const { inner, wrapped, sent } = harness();
    inner.onmessage!(call(4, 'account_add'));
    await wrapped.send(isErrorText(4, 'E_ENV_ACCOUNTS_MODE: accounts are defined by env'));
    expect(body(sent[0])).toBe('E_ENV_ACCOUNTS_MODE: accounts are defined by env');
  });

  it('never puts a client-invented tool name into an envelope', async () => {
    const { inner, wrapped, sent } = harness({ isKnownTool: () => false, defaultAccount: () => undefined });
    inner.onmessage!(call(5, 'made_up_tool'));
    await wrapped.send(isErrorText(5, 'Input validation error: Invalid arguments for tool made_up_tool: x'));
    expect(body(sent[0])).toContain('Input validation error');
  });

  it('ignores successful results and non-response frames', async () => {
    const { wrapped, sent } = harness();
    const okResult = { jsonrpc: '2.0', id: 6, result: { content: [{ type: 'text', text: 'fine' }] } } as unknown as JSONRPCMessage;
    await wrapped.send(okResult);
    expect(sent[0]).toBe(okResult);
    const request = { jsonrpc: '2.0', id: 7, method: 'elicitation/create', params: {} } as JSONRPCMessage;
    await wrapped.send(request);
    expect(sent[1]).toBe(request);
  });
});
