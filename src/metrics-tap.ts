import { PROTOCOL_VERSION_META_KEY, CLIENT_INFO_META_KEY, type Transport, type JSONRPCMessage, type MessageExtraInfo } from "@modelcontextprotocol/server";
import type { Metrics } from './usage-metrics.js';
import { isSchemaValidationText } from './arg-normalize.js';

// Pre-handler failure tap: a JSON-RPC ERROR frame is counted here and ONLY
// here, never by the registry wrapper. See docs/internals.md.

type OnMessage = (<T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void) | undefined;

const PENDING_CAP = 1_000;

// This tap sees the ORIGINAL prose; withValidationEnvelope sits BELOW it and
// converts the same frame for the client, so the two stay independent.
export { isSchemaValidationText };

/**
 * @param isKnownTool membership test against the REGISTERED tool set. The
 * name on a `tools/call` frame is client-supplied, so a shape check alone
 * would let a shape-valid but invented name reach disk and break the
 * closed-vocabulary guarantee. A validation failure against a name the server
 * never registered is a not-found, and is counted as one.
 */
export function tapUsageMetrics(transport: Transport, metrics: Metrics, isKnownTool: (name: string) => boolean = () => false): Transport {
  const pending = new Map<string | number, string>();
  const recordValidation = (tool: string | undefined): void => {
    if (tool !== undefined && isKnownTool(tool)) metrics.recordRpc('schema_validation', tool);
    else metrics.recordRpc('tool_not_found');
  };
  const wrapper = {
    start: () => transport.start(),
    send: (message: JSONRPCMessage, options?: Parameters<Transport['send']>[1]) => {
      try {
        const m = message as {
          id?: string | number;
          error?: { code?: number; message?: string };
          result?: { isError?: boolean; content?: { text?: string }[] };
        };
        // Responses only: a server-initiated REQUEST carries an id from a
        // different id space, and evicting on it would drop a real pending call.
        if (m.id !== undefined && (message as { method?: unknown }).method === undefined) {
          const tool = pending.get(m.id);
          pending.delete(m.id);
          if (m.error && typeof m.error.code === 'number') {
            if (m.error.code === -32602) {
              if (/unknown tool|not found/i.test(m.error.message ?? '')) metrics.recordRpc('tool_not_found');
              else recordValidation(tool);
            } else {
              metrics.recordRpc(m.error.code);
            }
          } else if (m.result?.isError === true) {
            const first = m.result.content?.[0]?.text;
            if (typeof first === 'string' && isSchemaValidationText(first)) {
              recordValidation(tool);
            }
          }
        }
      } catch { /* the tap may never break the wire */ }
      return transport.send(message, options);
    },
    close: () => transport.close(),
  } as Transport;
  Object.defineProperty(wrapper, 'onmessage', {
    get: () => transport.onmessage,
    set: (handler: OnMessage) => {
      transport.onmessage = handler
        ? (message, extra) => {
            try {
              const m = message as { id?: string | number; method?: unknown; params?: { name?: unknown; protocolVersion?: unknown; clientInfo?: unknown; _meta?: Record<string, unknown> } };
              // 2025-era clients announce themselves once, in `initialize`; 2026-07-28
              // clients repeat the same in every request's _meta envelope.
              if (m.method === 'initialize') metrics.recordClient(m.params?.protocolVersion, m.params?.clientInfo);
              else if (m.id !== undefined && m.params?._meta?.[PROTOCOL_VERSION_META_KEY] !== undefined) {
                metrics.recordClient(m.params._meta[PROTOCOL_VERSION_META_KEY], m.params._meta[CLIENT_INFO_META_KEY]);
              }
              if (m.id !== undefined && m.method === 'tools/call' && typeof m.params?.name === 'string') {
                if (pending.size >= PENDING_CAP) pending.clear();
                pending.set(m.id, m.params.name);
              }
            } catch { /* never break the wire */ }
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
  // v2-only; see the same forward in arg-normalize.ts. Both proxies compose,
  // so a member dropped by either layer never reaches the real transport.
  if (transport.setSupportedProtocolVersions) {
    wrapper.setSupportedProtocolVersions = (v: string[]) => transport.setSupportedProtocolVersions!(v);
  }
  return wrapper;
}
