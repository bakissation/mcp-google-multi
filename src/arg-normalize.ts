import type { Transport, JSONRPCMessage, MessageExtraInfo } from "@modelcontextprotocol/server";
import {
  screenArguments,
  unknownArgEnvelope,
  type SiblingSpelling,
  type UnknownArgMode,
} from './arg-strict.js';
import { sliceClean } from './trim.js';

// The SDK synthesizes input-validation failures as isError RESULTS, skipping
// the handler entirely: no handler of ours runs, so no envelope exists and the
// client gets free text. The text is prose in both SDK eras (v1 prefixed it
// with "MCP error -32602: ", v2 dropped that prefix), while handler envelopes
// are always JSON starting with "{".
const SCHEMA_VALIDATION_TEXT = /^(MCP error -32602: )?Input validation error:/;

export function isSchemaValidationText(text: string): boolean {
  return SCHEMA_VALIDATION_TEXT.test(text);
}

/** Capture form of the v2 text. The tool-name class excludes ':' and ' ', so
 * the first ": " after the name is unambiguously the delimiter. */
const VALIDATION_PROSE =
  /^(?:MCP error -32602: )?Input validation error: Invalid arguments for tool ([A-Za-z0-9_.-]+): ([\s\S]+)$/;

/** The SDK's OTHER synthesized prose on the same catch. Both prefixes are
 * SDK-authored; a HANDLER's free text is not, and must survive untouched
 * (the account wizard answers in prose today). */
const SDK_OUTPUT_PROSE = /^(?:MCP error -32602: )?Output validation error: /;

// Wire-level tools/call argument normalization. Clients (LLMs) recurringly
// snake_case a camelCase parameter (thread_id for threadId) and burn a retry
// on the -32602. A schema-level fix is off the table: the SDK advertises an
// EMPTY input schema for any non-object wrapper (pipe/preprocess), so the
// only seam that keeps tools/list intact is the JSON-RPC message itself —
// which is versioned MCP spec, stabler than any SDK internal. The rename is
// provably lossless: it fires only when the sent key is NOT in the tool's
// schema, its camelCase twin IS, and that twin was not also sent.

export function argNormalizationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !/^(0|false|off|no)$/i.test((env.GOOGLE_ARG_NORMALIZE ?? '').trim());
}

/** Declared scalar kind per schema key; drives value coercion on RENAMED keys
 * only. Clients string-encode values for keys absent from the advertised
 * schema, so a renamed key almost always arrives as a string — without
 * coercion the rename would just move the -32602 from the key to the value. */
export type ArgKind = 'number' | 'boolean' | 'other';
export type ArgShape = ReadonlyMap<string, ArgKind>;

const snakeToCamel = (key: string): string => key.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());

function coerceRenamedValue(value: unknown, kind: ArgKind | undefined): unknown {
  if (typeof value !== 'string') return value;
  const v = value.trim();
  if (kind === 'number' && /^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (kind === 'boolean' && /^(true|false)$/i.test(v)) return v.toLowerCase() === 'true';
  return value;
}

export function normalizeCallArguments(
  shape: ArgShape,
  args: Record<string, unknown>,
): { args: Record<string, unknown>; renamed: [string, string][] } {
  const renamed: [string, string][] = [];
  let out: Record<string, unknown> | undefined;
  for (const key of Object.keys(args)) {
    if (shape.has(key) || !key.includes('_')) continue;
    const camel = snakeToCamel(key);
    if (camel !== key && shape.has(camel) && !(camel in args)) {
      out ??= { ...args };
      out[camel] = coerceRenamedValue(out[key], shape.get(camel));
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
  shapeFor: (tool: string) => ArgShape | undefined,
  log: (line: string) => void = (l) => process.stderr.write(`${l}\n`),
  onRename?: (tool: string, renames: number) => void,
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
  try { onRename?.(m.params.name, renamed.length); } catch { /* observers never break dispatch */ }
  return {
    ...(msg as Record<string, unknown>),
    params: { ...(m.params as Record<string, unknown>), arguments: normalized },
  } as unknown as JSONRPCMessage;
}

export interface StrictArgOptions {
  mode: UnknownArgMode;
  /** full declared key list for a tool, in declaration order */
  declaredFor: (tool: string) => readonly string[] | undefined;
  /** sibling spellings of a concept elsewhere in the same service */
  siblingsFor?: (tool: string, keys: string[]) => SiblingSpelling[];
  /** Replacement text for the SDK's bare "Tool X not found". Still answered as
   * a JSON-RPC error, which is what the spec prescribes for an unknown tool;
   * only the message improves. */
  unknownTool?: (tool: string) => string;
  onDrop?: (tool: string, resolvedKeys: string[]) => void;
}

export type ScreenOutcome =
  | { action: 'forward'; msg: JSONRPCMessage }
  | { action: 'reject'; response: JSONRPCMessage };

/**
 * Screen a normalized tools/call for undeclared keys. `warn` forwards exactly
 * as before and only reports; `reject` answers with the taxonomy envelope and
 * never reaches the handler, so nothing is sent to Google on a guess.
 */
export function screenMessage(
  msg: JSONRPCMessage,
  opts: StrictArgOptions,
  log: (line: string) => void = (l) => process.stderr.write(`${l}\n`),
): ScreenOutcome {
  if (opts.mode === 'off') return { action: 'forward', msg };
  const m = msg as ToolCallLike & { id?: string | number };
  if (m.method !== 'tools/call' || typeof m.params?.name !== 'string') return { action: 'forward', msg };
  const args = m.params.arguments;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { action: 'forward', msg };
  const tool = m.params.name;
  const declared = opts.declaredFor(tool);
  // Unregistered tool. The spec keeps this a PROTOCOL error (unknown tool is
  // not something the model can fix by adjusting arguments), so the channel
  // stays a JSON-RPC error; only the message gets the did-you-mean and the
  // gated-service next step. Without `unknownTool`, or on a notification,
  // the SDK's own "not found" still answers.
  if (!declared) {
    if (!opts.unknownTool || m.id === undefined) return { action: 'forward', msg };
    return {
      action: 'reject',
      response: {
        jsonrpc: '2.0',
        id: m.id,
        error: { code: -32602, message: opts.unknownTool(tool) },
      } as unknown as JSONRPCMessage,
    };
  }

  const screened = screenArguments(tool, args as Record<string, unknown>, declared);
  if (screened.unknown.length === 0 && screened.redundant.length === 0) return { action: 'forward', msg };

  const all = [...screened.unknown.map((u) => u.sent), ...screened.redundant];
  // Key names only; argument VALUES never reach the log.
  log(`[args] ${tool}: undeclared ${all.join(', ')}${opts.mode === 'warn' ? ' (dropped)' : ' (rejected)'}`);
  try {
    // Only ever a DECLARED key or the literal placeholder, so the metrics
    // closed-vocabulary rule holds: the caller's key is never persisted.
    opts.onDrop?.(tool, screened.unknown.map((u) => u.suggestions[0] ?? '_unmatched'));
  } catch { /* observers never break dispatch */ }

  if (opts.mode === 'warn' || screened.unknown.length === 0) return { action: 'forward', msg };
  // Nothing to answer (a malformed notification): dispatch as before.
  if (m.id === undefined) return { action: 'forward', msg };

  const account = (args as { account?: unknown }).account;
  const siblings = screened.unknown.some((u) => u.suggestions.length > 0)
    ? []
    : (opts.siblingsFor?.(tool, screened.unknown.map((u) => u.sent)) ?? []);
  const envelope = unknownArgEnvelope(
    tool,
    screened.unknown,
    declared,
    typeof account === 'string' ? account : undefined,
    siblings,
  );
  return {
    action: 'reject',
    response: {
      jsonrpc: '2.0',
      id: m.id,
      result: { content: [{ type: 'text', text: JSON.stringify(envelope) }], isError: true },
    } as unknown as JSONRPCMessage,
  };
}

type OnMessage = (<T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void) | undefined;

/** Wrap a server-side transport so tools/call argument keys are normalized
 * before the SDK validates them. The Protocol assigns `onmessage` during
 * connect(); the interceptor lives in that setter, so the wrapper works
 * identically for stdio and (per-request, stateless) HTTP transports. */
export function withArgNormalization(
  transport: Transport,
  shapeFor: (tool: string) => ArgShape | undefined,
  log?: (line: string) => void,
  onRename?: (tool: string, renames: number) => void,
  strict?: StrictArgOptions,
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
        ? (message, extra) => {
            // Rename FIRST: a snake_case twin of a declared key is a fix, not
            // an unknown argument, so it must never reach the screen.
            const normalized = normalizeMessage(message, shapeFor, log, onRename);
            if (!strict) return handler(normalized, extra);
            const outcome = screenMessage(normalized, strict, log);
            if (outcome.action === 'forward') return handler(outcome.msg as typeof message, extra);
            // Last-resort fallback: dispatch as before rather than hang the
            // caller. The stderr line and the counter already fired above.
            // `send` is async, so a rejected promise needs catching too: a
            // bare `void` left the client waiting for a frame that never came.
            const fallback = () => handler(normalized as typeof message, extra);
            try {
              // Answer on the INNER transport so the metrics tap still sees the
              // frame and clears its pending id.
              void Promise.resolve(transport.send(outcome.response)).catch(fallback);
            } catch {
              fallback();
            }
          }
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
  // v2-only, called by Protocol.connect() before start(). A no-op today (both
  // sides default to the same exported constant), but a proxy that silently
  // eats a member the SDK calls is a bug waiting for the first caller that
  // passes supportedProtocolVersions explicitly.
  if (transport.setSupportedProtocolVersions) {
    wrapper.setSupportedProtocolVersions = (v: string[]) => transport.setSupportedProtocolVersions!(v);
  }
  return wrapper;
}

// ---------------------------------------------------------------------------
// The same wire seam owns one OUTBOUND job. withValidationEnvelope converts the
// SDK's bare validation prose back into the 6.0.0 envelope. It must be wrapped
// INNERMOST, below the metrics tap: outbound runs outermost-first, so this is
// the LAST thing to touch the frame and the tap above it still classifies the
// ORIGINAL prose as schema_validation.
// ---------------------------------------------------------------------------

export interface ValidationEnvelopeOptions {
  /** Membership against the REGISTERED tool set: the name on the frame is
   * ultimately client-supplied, and it must never enter an envelope unchecked. */
  isKnownTool?: (name: string) => boolean;
  /** The account the call WOULD have run as. The registry injects the default
   * AFTER validation, so a validation failure never got that far. */
  defaultAccount?: () => string | undefined;
}

const MAX_ACCOUNT_CHARS = 64;
const MAX_ISSUE_CHARS = 800;
const MAX_PROSE_CHARS = 500;
const ENVELOPE_PENDING_CAP = 1_000;

interface PendingCall { tool: string; account?: string }

export function validationEnvelope(tool: string, issues: string, account: string | undefined) {
  return {
    error: 'validation_error',
    message: `${tool} arguments failed validation: ${sliceClean(issues, MAX_ISSUE_CHARS)}`,
    hint: `Fix the argument named in the message and call again. This tool's inputSchema in tools/list lists every accepted argument, its type and its allowed values. Nothing was sent to Google.`,
    retriable: false,
    account: account ?? '',
  };
}

/** Floor for the OTHER bare prose the same SDK catch produces: an output-schema
 * failure. Nothing is known about the cause, so it says exactly that. */
export function outputFailureEnvelope(tool: string, text: string, account: string | undefined) {
  return {
    error: 'internal',
    message: `${tool} returned a result the protocol rejected: ${sliceClean(text, MAX_PROSE_CHARS)}`,
    hint: 'A server-side failure, not a rejected argument. Retry once; if it repeats, the message above is the signal to report.',
    retriable: false,
    account: account ?? '',
  };
}

export function rewriteValidationFrame(
  message: JSONRPCMessage,
  pending: Map<string | number, PendingCall>,
  opts: ValidationEnvelopeOptions,
): JSONRPCMessage {
  const m = message as {
    id?: string | number;
    method?: unknown;
    result?: { isError?: boolean; content?: { type?: string; text?: string }[] };
  };
  // Responses only. A server-initiated REQUEST (elicitation, sampling) also
  // carries an id, from a different id space, and evicting on it would drop a
  // real pending call.
  if (m.id === undefined || m.method !== undefined) return message;
  const call = pending.get(m.id);
  pending.delete(m.id);
  if (m.result?.isError !== true) return message;
  const content = m.result.content;
  if (!content || content.length !== 1 || content[0]?.type !== 'text') return message;
  const text = content[0].text;
  if (typeof text !== 'string' || text.startsWith('{')) return message;
  const parsed = isSchemaValidationText(text) ? VALIDATION_PROSE.exec(text) : null;
  // Anything the SDK did not author is a handler's own answer. Leave it alone.
  if (!parsed && !SDK_OUTPUT_PROSE.test(text)) return message;
  const tool = parsed?.[1] ?? call?.tool;
  if (!tool || (opts.isKnownTool && !opts.isKnownTool(tool))) return message;
  const account = call?.account ?? opts.defaultAccount?.();
  const envelope = parsed
    ? validationEnvelope(tool, parsed[2], account)
    : outputFailureEnvelope(tool, text, account);
  return {
    ...(message as Record<string, unknown>),
    result: { ...m.result, content: [{ type: 'text', text: JSON.stringify(envelope) }] },
  } as unknown as JSONRPCMessage;
}

export function withValidationEnvelope(transport: Transport, opts: ValidationEnvelopeOptions = {}): Transport {
  const pending = new Map<string | number, PendingCall>();
  const wrapper = {
    start: () => transport.start(),
    send: (message: JSONRPCMessage, options?: Parameters<Transport['send']>[1]) => {
      let out = message;
      try {
        out = rewriteValidationFrame(message, pending, opts);
      } catch { /* the seam may never break the wire */ }
      return transport.send(out, options);
    },
    close: () => transport.close(),
  } as Transport;
  Object.defineProperty(wrapper, 'onmessage', {
    get: () => transport.onmessage,
    set: (handler: OnMessage) => {
      transport.onmessage = handler
        ? (message, extra) => {
            try {
              const m = message as { id?: string | number; method?: unknown; params?: { name?: unknown; arguments?: unknown } };
              if (m.method === 'tools/call' && m.id !== undefined && typeof m.params?.name === 'string') {
                if (pending.size >= ENVELOPE_PENDING_CAP) pending.clear();
                const args = m.params.arguments;
                const raw = args && typeof args === 'object' ? (args as { account?: unknown }).account : undefined;
                pending.set(m.id, {
                  tool: m.params.name,
                  account: typeof raw === 'string' ? sliceClean(raw, MAX_ACCOUNT_CHARS) : undefined,
                });
              }
            } catch { /* never break dispatch */ }
            handler(message, extra);
          }
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
