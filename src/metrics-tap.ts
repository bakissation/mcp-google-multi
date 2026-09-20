import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage, MessageExtraInfo } from '@modelcontextprotocol/sdk/types.js';
import type { Metrics } from './usage-metrics.js';

// Pre-handler failure tap (metrics spec section 3), following the
// withArgNormalization proxy shape at the same two wrap sites. Inbound:
// request id -> tool name for tools/call (name only; the transport's
// method-only, no-params, no-PII rule). Outbound: a JSON-RPC ERROR frame
// means no handler ran, so it is counted here and ONLY here; handler results
// (isError envelopes included) return as results and are counted by the
// registry wrapper. That partition is the no-double-counting guarantee.
//
// -32602 splits on the SDK's message: an unknown tool carries a client-typed
// name (free text, never recorded), a schema rejection carries a registered
// tool's name (safe to attribute).

type OnMessage = (<T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void) | undefined;

const PENDING_CAP = 1_000;

export function tapUsageMetrics(transport: Transport, metrics: Metrics): Transport {
  const pending = new Map<string | number, string>();
  const wrapper = {
    start: () => transport.start(),
    send: (message: JSONRPCMessage, options?: Parameters<Transport['send']>[1]) => {
      try {
        const m = message as {
          id?: string | number;
          error?: { code?: number; message?: string };
          result?: { isError?: boolean; content?: { text?: string }[] };
        };
        if (m.id !== undefined) {
          const tool = pending.get(m.id);
          pending.delete(m.id);
          if (m.error && typeof m.error.code === 'number') {
            if (m.error.code === -32602) {
              if (/unknown tool|not found/i.test(m.error.message ?? '')) metrics.recordRpc('tool_not_found');
              else metrics.recordRpc('schema_validation', tool);
            } else {
              metrics.recordRpc(m.error.code);
            }
          } else if (m.result?.isError === true) {
            // SDK 1.x synthesizes input-validation failures as isError RESULTS
            // ("MCP error -32602: ..."), skipping the handler entirely, so the
            // registry wrapper never sees them either. Handler envelopes are
            // JSON text and never carry this prefix, so nothing double counts.
            const first = m.result.content?.[0]?.text;
            if (typeof first === 'string' && first.startsWith('MCP error -32602:')) {
              if (/tool \S+ not found|unknown tool/i.test(first)) metrics.recordRpc('tool_not_found');
              else metrics.recordRpc('schema_validation', tool);
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
              const m = message as { id?: string | number; method?: unknown; params?: { name?: unknown } };
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
  return wrapper;
}
