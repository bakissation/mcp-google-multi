import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage, MessageExtraInfo } from '@modelcontextprotocol/sdk/types.js';

// Wire-level tools/call argument normalization. Clients (LLMs) recurringly
// snake_case a camelCase parameter (thread_id for threadId) and burn a retry
// on the -32602. A schema-level fix is off the table: SDK 1.x advertises an
// EMPTY input schema for any non-object wrapper (pipe/preprocess), so the
// only seam that keeps tools/list intact is the JSON-RPC message itself —
// which is versioned MCP spec, stabler than any SDK internal. The rename is
// provably lossless: it fires only when the sent key is NOT in the tool's
// schema, its camelCase twin IS, and that twin was not also sent.

export function argNormalizationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !/^(0|false|off|no)$/i.test((env.GOOGLE_ARG_NORMALIZE ?? '').trim());
}

const snakeToCamel = (key: string): string => key.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());

export function normalizeCallArguments(
  shapeKeys: ReadonlySet<string>,
  args: Record<string, unknown>,
): { args: Record<string, unknown>; renamed: [string, string][] } {
  const renamed: [string, string][] = [];
  let out: Record<string, unknown> | undefined;
  for (const key of Object.keys(args)) {
    if (shapeKeys.has(key) || !key.includes('_')) continue;
    const camel = snakeToCamel(key);
    if (camel !== key && shapeKeys.has(camel) && !(camel in args)) {
      out ??= { ...args };
      out[camel] = out[key];
      delete out[key];
      renamed.push([key, camel]);
    }
  }
  return { args: out ?? args, renamed };
}

interface ToolCallLike {
  method?: unknown;
  params?: { name?: unknown; arguments?: unknown };
}

export function normalizeMessage(
  msg: JSONRPCMessage,
  shapeFor: (tool: string) => ReadonlySet<string> | undefined,
  log: (line: string) => void = (l) => process.stderr.write(`${l}\n`),
): JSONRPCMessage {
  const m = msg as ToolCallLike;
  if (m.method !== 'tools/call' || typeof m.params?.name !== 'string') return msg;
  const args = m.params.arguments;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return msg;
  const shape = shapeFor(m.params.name);
  if (!shape) return msg;
  const { args: normalized, renamed } = normalizeCallArguments(shape, args as Record<string, unknown>);
  if (renamed.length === 0) return msg;
  // Key names only — argument VALUES never reach the log.
  log(`[args] ${m.params.name}: ${renamed.map(([f, t]) => `${f} -> ${t}`).join(', ')}`);
  return {
    ...(msg as Record<string, unknown>),
    params: { ...(m.params as Record<string, unknown>), arguments: normalized },
  } as unknown as JSONRPCMessage;
}

type OnMessage = (<T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void) | undefined;

/** Wrap a server-side transport so tools/call argument keys are normalized
 * before the SDK validates them. The Protocol assigns `onmessage` during
 * connect(); the interceptor lives in that setter, so the wrapper works
 * identically for stdio and (per-request, stateless) HTTP transports. */
export function withArgNormalization(
  transport: Transport,
  shapeFor: (tool: string) => ReadonlySet<string> | undefined,
  log?: (line: string) => void,
): Transport {
  const wrapper = {
    start: () => transport.start(),
    send: (message: JSONRPCMessage, options?: Parameters<Transport['send']>[1]) => transport.send(message, options),
    close: () => transport.close(),
  } as Transport;
  Object.defineProperty(wrapper, 'onmessage', {
    get: () => transport.onmessage,
    set: (handler: OnMessage) => {
      transport.onmessage = handler
        ? (message, extra) => handler(normalizeMessage(message, shapeFor, log), extra)
        : undefined;
    },
  });
  for (const prop of ['onclose', 'onerror'] as const) {
    Object.defineProperty(wrapper, prop, {
      get: () => transport[prop],
      set: (v) => {
        transport[prop] = v;
      },
    });
  }
  Object.defineProperty(wrapper, 'sessionId', { get: () => transport.sessionId });
  if (transport.setProtocolVersion) {
    wrapper.setProtocolVersion = (v: string) => transport.setProtocolVersion!(v);
  }
  return wrapper;
}
