import { vi } from 'vitest';
import { z } from 'zod';
import { buildRegistry } from '../src/compose.js';
import type { IdentityContext } from '../src/identity.js';
import type { AccountSet } from '../src/accounts.js';
import type { ScopeProfile } from '../src/scope-catalog.js';
import type { Policy } from '../src/write-control.js';

// The real registry and its wrappers over a fake Google HTTP client (non-owner context, so no host-file tools).

export type ToolResult = { content: { type?: string; text: string }[]; isError?: boolean };
export type GoogleRequest = { url: string; method?: string; data?: unknown; params?: Record<string, unknown> };
type Handler = (args: Record<string, unknown>, extra?: unknown) => Promise<ToolResult>;

export interface AccountRow {
  email: string;
  admin?: boolean;
  scopeProfile?: string;
}

export function accountSet(
  rows: Record<string, AccountRow>,
  opts: { defaultAccount?: string; scopeProfiles?: Record<string, ScopeProfile> } = {},
): AccountSet {
  const configs: AccountSet['configs'] = {};
  for (const [alias, r] of Object.entries(rows)) {
    configs[alias] = {
      email: r.email,
      tokenPath: `/nonexistent/${alias}/token.json`,
      encPath: `/nonexistent/${alias}.enc`,
      source: 'config',
      ...(r.admin ? { admin: true } : {}),
      ...(r.scopeProfile ? { scopeProfile: r.scopeProfile } : {}),
    };
  }
  return {
    aliases: Object.keys(rows),
    configs,
    scopeProfiles: { base: { bundles: [] }, ...opts.scopeProfiles },
    source: 'file',
    stamp: '1:0',
    ...(opts.defaultAccount ? { defaultAccount: opts.defaultAccount, defaultAccountSource: 'config' as const } : {}),
  };
}

/** Simulated client response to a server-side elicitation request
 * (registry.elicitConfirmation -> server.server.elicitInput). 'unsupported'
 * (the default) declares NO elicitation capability at all, so
 * elicitConfirmation's fast-fail check refuses before ever calling
 * elicitInput; 'accept' | 'decline' | 'cancel' resolve with that action; a
 * function gets the raw prompt message and decides per call. 'throws' and
 * 'unexpected' both declare the capability (unlike 'unsupported') but then
 * have the call itself misbehave once attempted: 'throws' simulates a
 * capable client whose answer never arrives (a timeout, a dropped
 * connection), 'unexpected' simulates a result whose action is neither
 * accept/decline/cancel, which registry.elicitConfirmation treats the same
 * way (refuse, never proceed without a real answer). */
export type ElicitMode =
  | 'accept'
  | 'decline'
  | 'cancel'
  | 'unsupported'
  | 'throws'
  | 'unexpected'
  | ((message: string) => 'accept' | 'decline' | 'cancel');

export function fakeServer(opts: { elicit?: ElicitMode } = {}) {
  const handlers: Record<string, Handler> = {};
  const schemas: Record<string, z.ZodRawShape> = {};
  const elicitInput = vi.fn(async (params: { message: string }) => {
    const mode = opts.elicit ?? 'unsupported';
    const action = typeof mode === 'function' ? mode(params.message) : mode;
    if (action === 'unsupported') {
      throw new Error('elicitation not supported by this client (test harness default)');
    }
    if (action === 'throws') {
      throw new Error('simulated: no answer arrived (timeout or dropped connection)');
    }
    if (action === 'unexpected') {
      return { action: 'something_else' };
    }
    return { action };
  });
  // registry.elicitConfirmation checks this BEFORE ever calling elicitInput
  // (same fast-fail pattern account-wizard.ts's form elicitation uses), so
  // the capability must be advertised whenever the harness is told to
  // simulate a client that can actually answer, including one that then
  // fails mid-call ('throws'/'unexpected') rather than never having the
  // capability at all ('unsupported').
  const elicitationCapable = (opts.elicit ?? 'unsupported') !== 'unsupported';
  const server = {
    registerTool: (name: string, config: { inputSchema?: z.ZodRawShape }, handler: Handler) => {
      handlers[name] = handler;
      schemas[name] = config.inputSchema ?? {};
      return 'ok';
    },
    sendToolListChanged: vi.fn(),
    server: {
      setRequestHandler: () => {},
      getClientCapabilities: () => (elicitationCapable ? { elicitation: { form: {} } } : undefined),
      elicitInput,
    },
  };
  return { server, handlers, schemas, elicitInput };
}

export interface HarnessOptions {
  subject?: string;
  /** Defaults to one account, alias "test", which is also the default account. */
  accounts?: AccountSet;
  /** Granted scope string on every account's token. */
  scope?: string;
  policy?: Partial<Policy>;
  /** Response data for a Google request; throw to simulate a Google error. */
  respond?: (req: GoogleRequest) => unknown;
  /** Full control over the raw client response, when respond is not enough. */
  requestImpl?: (req: GoogleRequest) => Promise<unknown>;
  mode?: 'eager' | 'lazy';
  /** Simulated response to a server-side elicitation (escape hatch ask). */
  elicit?: ElicitMode;
}

export const DEFAULT_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';

export function toolHarness(opts: HarnessOptions = {}) {
  const subject = opts.subject ?? 'harness';
  const accounts = opts.accounts ?? accountSet({ test: { email: 'test@harness.example' } }, { defaultAccount: 'test' });
  const request = vi.fn(
    opts.requestImpl ??
      (async (req: GoogleRequest) => ({ data: opts.respond ? await opts.respond(req) : {}, headers: new Headers(), status: 200 })),
  );
  const getClient = vi.fn(async () => ({ request }));
  const token = {
    access_token: `at-${subject}`,
    refresh_token: `rt-${subject}`,
    scope: opts.scope ?? DEFAULT_SCOPE,
    token_type: 'Bearer',
    expiry_date: Date.now() + 3_600_000,
  };
  const tokenStore = {
    readToken: vi.fn(() => token),
    writeToken: vi.fn(),
    updateToken: vi.fn(),
    hasToken: vi.fn(() => true),
  };
  const ctx = {
    subject,
    accounts,
    policy: { profile: 'full-writes', readOnly: false, allow: [], deny: [], ...opts.policy },
    getClient,
    tokenStore,
  } as unknown as IdentityContext;
  const { server, handlers, schemas, elicitInput } = fakeServer({ elicit: opts.elicit });
  const registry = buildRegistry(server as never, ctx, opts.mode ?? 'eager');

  /** Validates args against the tool's registered schema, as the SDK does, then calls it. */
  async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    const handler = handlers[name];
    if (!handler) throw new Error(`tool not registered: ${name}`);
    try {
      return handler(z.object(schemas[name]).parse(args) as Record<string, unknown>, {});
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        const account = (args as Record<string, unknown>)?.account as string | undefined;
        const flat = error.flatten();
        const messages = [
          ...flat.formErrors,
          ...Object.entries(flat.fieldErrors).flatMap(([field, msgs]) => msgs.map(m => `${field}: ${m}`)),
        ];
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: 'invalid_params',
            message: messages.join('; '),
            ...(account ? { account } : {}),
          }, null, 2) }],
          isError: true,
        };
      }
      throw error;
    }
  }

  const requests = (): GoogleRequest[] => request.mock.calls.map(([r]) => r as GoogleRequest);

  return { ctx, call, requests, request, getClient, tokenStore, handlers, schemas, elicitInput, registry };
}

export const parseResult = (r: ToolResult) => JSON.parse(r.content[0].text);
