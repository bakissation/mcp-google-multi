// Human confirmation for escape-hatch writes over the stateless HTTP transport.
//
// HTTP serves every call on a disposable transport, so the stdio mechanism (a
// server-to-client elicitation request while the tool call is open) has nothing
// to ride on. Two replacements, neither of which keeps a session:
//
//  * Modern clients (protocol 2026-07-28): the handler returns `input_required`
//    with an elicitation, the client asks its human and retries the same call
//    with the answer. The state that comes back is HMAC-signed, expires, and is
//    bound to the verified subject and to a hash of the exact call, so an
//    accepted answer cannot be replayed on a different call.
//  * Everyone else, opt-in (MCP_HTTP_CONFIRM_TOKEN=1): a two-step token. The
//    first call is refused with a summary and a short-lived single-use token;
//    the retry must carry the token and the identical call. This proves the
//    model was handed the summary, NOT that a human agreed: it is a speed bump
//    for an agent that can show the summary to its user, not a consent proof.

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createRequestStateCodec, inputRequired, inputResponse, CLIENT_CAPABILITIES_META_KEY } from '@modelcontextprotocol/server';
import type { JSONRPCMessage, MessageExtraInfo, ServerContext, Transport } from '@modelcontextprotocol/server';

/** The `_meta` key a confirm token travels under once lifted out of the call's
 * arguments (see liftConfirmToken); keeps the token out of every tool schema. */
export const CONFIRM_TOKEN_META = 'mcp-google-multi/confirmToken';
/** The argument name a caller uses for the token. Never in a tool's inputSchema. */
export const CONFIRM_TOKEN_ARG = 'confirmToken';

const DEFAULT_TTL_SECONDS = 300;
const MAX_TTL_SECONDS = 900;
const USED_CAP = 2_000;
const INPUT_KEY = 'confirm';

// One random key per process unless an operator pins one (needed only when
// several replicas must accept each other's tokens and signed state).
let processKey: Buffer | undefined;
function keyFrom(env: NodeJS.ProcessEnv): Buffer {
  const pinned = env.MCP_CONFIRM_KEY?.trim();
  if (pinned && Buffer.byteLength(pinned) >= 32) return Buffer.from(pinned);
  processKey ??= randomBytes(32);
  return processKey;
}

export function confirmTokenEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.MCP_HTTP_CONFIRM_TOKEN ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

function ttlSecondsFrom(env: NodeJS.ProcessEnv): number {
  const n = Number(env.MCP_CONFIRM_TTL_SECONDS);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TTL_SECONDS;
  return Math.min(Math.floor(n), MAX_TTL_SECONDS);
}

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
    .join(',')}}`;
}

/** Hash of the exact call a confirmation covers, bound to who is asking. */
export function callHash(call: unknown, subject: string): string {
  return createHash('sha256').update(stable({ call, subject })).digest('hex').slice(0, 32);
}

export type TokenVerdict = { ok: true } | { ok: false; reason: 'malformed' | 'expired' | 'mismatch' | 'used' };

const b64u = (b: Buffer | string): string => Buffer.from(b).toString('base64url');

/** Stateless-signed, single-use-per-process confirm tokens. */
export class ConfirmTokens {
  private readonly used = new Map<string, number>();
  constructor(
    private readonly key: Buffer,
    private readonly ttlSeconds: number,
    private readonly now: () => number = Date.now,
  ) {}

  private mac(body: string): string {
    return createHmac('sha256', this.key).update(`confirm.v1.${body}`).digest('base64url');
  }

  mint(hash: string): { token: string; expiresInSeconds: number } {
    const nonce = randomBytes(12).toString('base64url');
    const exp = Math.floor(this.now() / 1000) + this.ttlSeconds;
    const body = b64u(JSON.stringify({ n: nonce, e: exp, h: hash }));
    return { token: `c1.${body}.${this.mac(body)}`, expiresInSeconds: this.ttlSeconds };
  }

  consume(token: string, hash: string): TokenVerdict {
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== 'c1') return { ok: false, reason: 'malformed' };
    const body = parts[1];
    const want = Buffer.from(this.mac(body));
    const got = Buffer.from(parts[2]);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return { ok: false, reason: 'malformed' };
    let claim: { n?: unknown; e?: unknown; h?: unknown };
    try {
      claim = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
      return { ok: false, reason: 'malformed' };
    }
    if (typeof claim.n !== 'string' || typeof claim.e !== 'number' || typeof claim.h !== 'string') return { ok: false, reason: 'malformed' };
    const nowS = Math.floor(this.now() / 1000);
    if (claim.e < nowS) return { ok: false, reason: 'expired' };
    if (claim.h !== hash) return { ok: false, reason: 'mismatch' };
    if (this.used.has(claim.n)) return { ok: false, reason: 'used' };
    if (this.used.size >= USED_CAP) {
      for (const [n, e] of this.used) if (e < nowS) this.used.delete(n);
      // Still full of live entries: dropping the oldest keeps memory bounded;
      // an evicted nonce can only be replayed until its own expiry.
      if (this.used.size >= USED_CAP) this.used.delete(this.used.keys().next().value as string);
    }
    this.used.set(claim.n, claim.e);
    return { ok: true };
  }
}

type Ctx = ServerContext | undefined;

/** The verified subject the HTTP host stamped on the request. */
export function subjectOf(ctx: Ctx): string {
  const sub = (ctx?.http?.authInfo?.extra as { sub?: unknown } | undefined)?.sub;
  return typeof sub === 'string' ? sub : '';
}

/** True when the request arrived on the modern (per-request envelope) wire. */
export function isModernCall(ctx: Ctx): boolean {
  return ctx?.mcpReq?.envelope !== undefined;
}

function clientCanElicit(ctx: Ctx): boolean {
  const env = ctx?.mcpReq?.envelope as Record<string, unknown> | undefined;
  const caps = env?.[CLIENT_CAPABILITIES_META_KEY] as { elicitation?: unknown } | undefined;
  return caps?.elicitation !== undefined && caps.elicitation !== null;
}

export interface ConfirmRefusal {
  error: 'confirmation_required' | 'confirmation_invalid';
  message: string;
  hint: string;
  retriable: boolean;
  account?: string;
  confirmToken?: string;
  expiresInSeconds?: number;
  summary?: string;
}

export type ConfirmOutcome =
  | { action: 'accept' | 'decline' | 'cancel' }
  /** Hand this back from the tool handler as its result. */
  | { action: 'respond'; result: unknown }
  /** Neither mechanism applies here; fall back to the plain refusal. */
  | { action: 'unavailable' };

export interface HttpConfirmOptions {
  /** Offer the two-step token to callers that cannot be asked directly. */
  tokens?: boolean;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

export class HttpConfirm {
  readonly tokensEnabled: boolean;
  private readonly tokens: ConfirmTokens;
  private readonly codec;

  constructor(opts: HttpConfirmOptions = {}) {
    const env = opts.env ?? process.env;
    this.tokensEnabled = opts.tokens ?? confirmTokenEnabled(env);
    const key = keyFrom(env);
    const ttl = ttlSecondsFrom(env);
    this.tokens = new ConfirmTokens(key, ttl, opts.now);
    this.codec = createRequestStateCodec<{ h: string }>({
      key,
      ttlSeconds: ttl,
      bind: (ctx) => `confirm\0${subjectOf(ctx)}`,
    });
  }

  /**
   * Decide a confirmation for an HTTP call. `call` is whatever uniquely
   * identifies the write (account, method, params, body); `message` is the
   * human-readable summary the caller shows.
   */
  async confirm(ctx: Ctx, message: string, call: unknown, account: string): Promise<ConfirmOutcome> {
    if (!ctx) return { action: 'unavailable' };
    const hash = callHash(call, subjectOf(ctx));
    if (isModernCall(ctx) && clientCanElicit(ctx)) return this.modernStep(ctx, message, hash);
    if (this.tokensEnabled) return this.tokenStep(ctx, message, hash, account);
    return { action: 'unavailable' };
  }

  private async modernStep(ctx: ServerContext, message: string, hash: string): Promise<ConfirmOutcome> {
    const view = inputResponse(ctx.mcpReq.inputResponses, INPUT_KEY);
    if (view.kind === 'elicit') {
      const raw = ctx.mcpReq.requestState<string>();
      let claim: { h: string } | undefined;
      if (typeof raw === 'string') {
        try {
          claim = await this.codec.verify(raw, ctx);
        } catch {
          claim = undefined;
        }
      }
      if (claim) {
        if (claim.h !== hash) return { action: 'respond', result: refusal({ error: 'confirmation_invalid', message: 'The confirmation was given for a different call than this one, so nothing was sent.', hint: 'Call the tool again with the arguments you want and confirm that call.', retriable: false }) };
        return { action: view.action };
      }
      // Missing or unverifiable state (expired, tampered): ask again.
    }
    const requestState = await this.codec.mint({ h: hash }, ctx);
    return {
      action: 'respond',
      result: inputRequired({
        inputRequests: { [INPUT_KEY]: inputRequired.elicit({ message, requestedSchema: { type: 'object', properties: {} } }) },
        requestState,
      }),
    };
  }

  private tokenStep(ctx: ServerContext, message: string, hash: string, account: string): ConfirmOutcome {
    const supplied = (ctx.mcpReq._meta as Record<string, unknown> | undefined)?.[CONFIRM_TOKEN_META];
    if (typeof supplied === 'string') {
      const verdict = this.tokens.consume(supplied, hash);
      if (verdict.ok) return { action: 'accept' };
      const why =
        verdict.reason === 'expired'
          ? 'The confirmation token has expired.'
          : verdict.reason === 'used'
            ? 'The confirmation token was already used.'
            : verdict.reason === 'mismatch'
              ? 'The confirmation token was issued for a different call than this one.'
              : 'The confirmation token is not valid.';
      return {
        action: 'respond',
        result: refusal({
          error: 'confirmation_invalid',
          message: `${why} Nothing was sent to Google.`,
          hint: `Call the tool again without ${CONFIRM_TOKEN_ARG} to get a fresh summary and token, show the summary to the user, and retry with the identical arguments plus the new ${CONFIRM_TOKEN_ARG} once they agree.`,
          retriable: true,
          account,
        }),
      };
    }
    const { token, expiresInSeconds } = this.tokens.mint(hash);
    return {
      action: 'respond',
      result: refusal({
        error: 'confirmation_required',
        message: 'This write needs the user\'s explicit approval before it is sent. Nothing was sent to Google.',
        hint: `Show the summary below to the user. Only if they agree, call this tool again with the identical arguments plus ${CONFIRM_TOKEN_ARG}. The token works once and expires.`,
        retriable: true,
        account,
        confirmToken: token,
        expiresInSeconds,
        summary: message,
      }),
    };
  }
}

function refusal(body: ConfirmRefusal) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(body) }], isError: true };
}

/**
 * Wire seam: move `confirmToken` out of a tools/call's arguments into
 * `params._meta`, so it never reaches argument validation or any tool schema.
 * Returns the message untouched when there is nothing to lift.
 */
export function liftConfirmToken<T>(message: T): T {
  const m = message as { method?: unknown; params?: { arguments?: unknown; _meta?: unknown } };
  if (m?.method !== 'tools/call') return message;
  const args = m.params?.arguments;
  if (!args || typeof args !== 'object' || Array.isArray(args) || !Object.hasOwn(args, CONFIRM_TOKEN_ARG)) return message;
  const { [CONFIRM_TOKEN_ARG]: token, ...rest } = args as Record<string, unknown>;
  const meta = { ...((m.params?._meta as Record<string, unknown> | undefined) ?? {}) };
  if (typeof token === 'string') meta[CONFIRM_TOKEN_META] = token;
  return { ...(message as object), params: { ...m.params, arguments: rest, _meta: meta } } as T;
}

type OnMessage = (<T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void) | undefined;

/** Transport wrapper applying liftConfirmToken to every inbound frame. */
export function withConfirmTokenLift(transport: Transport): Transport {
  const wrapper = {
    start: () => transport.start(),
    send: (message: JSONRPCMessage, options?: Parameters<Transport['send']>[1]) => transport.send(message, options),
    close: () => transport.close(),
  } as Transport;
  Object.defineProperty(wrapper, 'onmessage', {
    get: () => transport.onmessage,
    set: (handler: OnMessage) => {
      transport.onmessage = handler ? (message, extra) => handler(liftConfirmToken(message), extra) : undefined;
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
  if (transport.setProtocolVersion) wrapper.setProtocolVersion = (v: string) => transport.setProtocolVersion!(v);
  if (transport.setSupportedProtocolVersions) {
    wrapper.setSupportedProtocolVersions = (v: string[]) => transport.setSupportedProtocolVersions!(v);
  }
  return wrapper;
}
