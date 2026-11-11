import { z } from 'zod';
import type { McpServer } from "@modelcontextprotocol/server";
import type { ToolRegistry } from '../registry.js';
import { getAccountSet, invalidateAccountSet, refreshAccountSetIfStale } from '../accounts.js';
import { ALIAS_RE, mutateConfigFile } from '../config-file.js';
import { writeToken } from '../token-store.js';
import { resolveScopesForAccount } from '../auth.js';
import { BUNDLE_CATALOG, closestBundle, isAdminBundle, isKnownBundle, orgOnlyRefusal, refusedBundlesFor, resolveBundleAliases } from '../scope-catalog.js';
import { openUrl } from '../open-url.js';
import { coerceBoolean } from './_coerce.js';
import { safeMessage, stringifyEnvelope } from './_errors.js';
import {
  buildConsentClient, openLoopbackConsent, hasClientCredentials, TESTING_MODE_WARNING,
} from '../oauth-consent.js';
import {
  detectClients, buildServerEntry, renderInstruction, applyFileEntry, resolveMode,
  DEFAULT_SERVER_NAME, type ClientId, type Mode,
} from '../client-config.js';

// Elicitation-driven account_add / account_reauth, built on the mutable
// config.json registry; HTTP-transport consent is owned by the OAuth AS, not this file.

export interface AddForm {
  alias: string;
  email: string;
  allBundles: boolean;
  forms: boolean;
  chat: boolean;
  otherBundles: string;
  admin: boolean;
}

// Each common bundle gets its own checkbox since MCP elicitation has no
// multi-select; the long tail stays a comma-separated field, `allBundles` grants all.
const CHECKBOX_BUNDLES = ['forms', 'chat'] as const;

/** Every optional bundle (admin is granted via its own checkbox, admin_readonly only by name, neither by allBundles),
 * less those Google refuses for the account at `email` when one is given. */
export function allOptionalBundles(email?: string): string[] {
  const all = Object.keys(BUNDLE_CATALOG).filter((n) => !isAdminBundle(n));
  if (email === undefined) return all;
  const refused = new Set(refusedBundlesFor(email, all));
  return all.filter((n) => !refused.has(n));
}

/** elicitation/create form schema (flat primitives only, per the MCP spec). */
export function addFormSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      alias: { type: 'string', title: 'Account alias', description: 'Short id, e.g. "work" (letters, digits, _ or -).' },
      email: { type: 'string', title: 'Google email', description: 'The account\'s Google address (used as the login hint).' },
      allBundles: { type: 'boolean', title: 'All optional scopes', description: 'Grant every optional bundle (biggest consent screen). Overrides the individual choices below.', default: false },
      forms: { type: 'boolean', title: 'Google Forms', description: 'Build forms and read their responses.', default: false },
      chat: { type: 'boolean', title: 'Google Chat', description: 'Read/send Chat messages and manage spaces (Workspace only).', default: false },
      otherBundles: { type: 'string', title: 'Other scope bundles (comma-separated)', description: 'Advanced, optional: e.g. "slides,gmail_settings". See docs for the full list. Leave blank for base + the checkboxes above.' },
      admin: { type: 'boolean', title: 'Grant Workspace admin scopes', description: 'Only for a Workspace super-admin account. Adds admin scopes.', default: false },
    },
    required: ['alias', 'email'],
  };
}

export type AddValidation =
  | { ok: true; alias: string; email: string; bundles: string[]; admin: boolean }
  | { ok: false; slug: string; message: string; hint?: string; alias?: string };

/** Validate the collected form against the alias rules, dup check, and the
 * bundle catalog. Pure (no I/O) for unit testing. */
export function validateAddForm(input: Partial<AddForm>, existingAliases: string[]): AddValidation {
  const alias = (input.alias ?? '').trim();
  const email = (input.email ?? '').trim();
  if (!ALIAS_RE.test(alias)) {
    return { ok: false, slug: 'E_VALIDATION', message: `Invalid alias "${alias}".`, hint: 'Use letters, digits, "_" or "-".', alias };
  }
  if (existingAliases.includes(alias)) {
    return { ok: false, slug: 'E_ALIAS_EXISTS', message: `Alias "${alias}" already exists.`, hint: 'Use account_reauth to re-authenticate it, or pick another name.', alias };
  }
  if (email === '') {
    return { ok: false, slug: 'E_VALIDATION', message: 'Email is required.', hint: "It is used as the Google login hint, so it must be the account's real Google address.", alias };
  }
  if (input.allBundles === true) {
    return { ok: true, alias, email, bundles: allOptionalBundles(email), admin: input.admin === true };
  }
  const picked = CHECKBOX_BUNDLES.filter((b) => input[b] === true);
  const rawOther = (input.otherBundles ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const bundles = [...new Set(resolveBundleAliases([...picked, ...rawOther]))];
  for (const b of bundles) {
    if (b === 'admin') {
      return { ok: false, slug: 'E_UNKNOWN_BUNDLE', message: '"admin" is not a scope bundle.', hint: 'Use the admin checkbox instead, or pass "admin": true.', alias };
    }
    if (!isKnownBundle(b)) {
      const closest = closestBundle(b);
      const known = allOptionalBundles(email).join(', ');
      return {
        ok: false,
        slug: 'E_UNKNOWN_BUNDLE',
        message: `Unknown bundle "${b}".`,
        hint: `${closest ? `Did you mean "${closest}"? ` : ''}Known bundles: ${known}.`,
        alias,
      };
    }
  }
  const refused = refusedBundlesFor(email, bundles);
  if (refused.length > 0) {
    const names = refused.map((b) => `"${b}"`).join(', ');
    if (orgOnlyRefusal(email) === 'external') {
      return {
        ok: false,
        slug: 'E_VALIDATION',
        message: `Google does not let an account outside this server's Workspace organisation grant ${names}.`,
        hint: `${email} is not in GOOGLE_HOME_DOMAINS. Leave ${names} out (Google would reject the whole consent with invalid_scope), or use an account from the home organisation for it.`,
        alias,
      };
    }
    return {
      ok: false,
      slug: 'E_VALIDATION',
      message: `Google does not let a personal account grant ${names}.`,
      hint: 'Leave it out, or link a Google Workspace account for it.',
      alias,
    };
  }
  return { ok: true, alias, email, bundles, admin: input.admin === true };
}

/** URL-mode elicitation params. `elicitationId` is REQUIRED by the spec
 * schema; omitting it made every url-mode request fail client-side
 * validation, so the branch silently never worked. Pure, so the shape is
 * testable against the SDK's own schema without a live client. */
export function urlElicitationParams(alias: string, url: string, elicitationId: string): {
  mode: 'url'; elicitationId: string; message: string; url: string;
} {
  return {
    mode: 'url',
    elicitationId,
    message: `Authorize the "${alias}" Google account in your browser.`,
    url,
  };
}

/** Map direct tool arguments onto the elicitation form shape: the argument-
 * mode fallback for clients without form elicitation. All bundle picks travel
 * through otherBundles, which validateAddForm resolves and validates. Pure. */
export function argsToAddForm(a: { alias?: string; account?: string; email?: string; bundles?: string; allBundles?: boolean; admin?: boolean }): Partial<AddForm> {
  return {
    alias: a.alias ?? a.account ?? '',
    email: a.email ?? '',
    allBundles: a.allBundles === true,
    otherBundles: a.bundles ?? '',
    admin: a.admin === true,
  };
}

/** Scopes requested by the profile but NOT granted at consent (granular
 * consent / unchecked bundles). Pure. */
export function scopeGrantDiff(requested: string[], grantedScope: string | undefined): string[] {
  const granted = new Set((grantedScope ?? '').split(' ').filter(Boolean));
  return requested.filter((s) => !granted.has(s));
}

function writeAccountRow(alias: string, email: string, bundles: string[], admin: boolean): void {
  mutateConfigFile((current) => {
    const next = { ...current, accounts: { ...(current.accounts ?? {}) } };
    const row: { email: string; scopeProfile?: string; admin?: boolean } = { email };
    if (bundles.length > 0) {
      next.scopeProfiles = { ...(next.scopeProfiles ?? {}), [alias]: { bundles } };
      row.scopeProfile = alias;
    }
    if (admin) row.admin = true;
    next.accounts[alias] = row;
    return next;
  });
}

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

// Errors use the shared envelope so clients can branch on slug; success stays
// plain prose (a human-readable report, not data).
function errorResult(slug: string, message: string, hint?: string, account?: string) {
  return {
    content: [{ type: 'text' as const, text: stringifyEnvelope({
      error: slug,
      message,
      ...(hint ? { hint } : {}),
      retriable: false,
      ...(account ? { account } : {}),
    }) }],
    isError: true as const,
  };
}

interface ConsentFailure { ok: false; slug: string; message: string; hint?: string }

/** HTTP-transport consent context: set by the HTTP bootstrap. When
 * present, runConsent NEVER binds a server-side loopback listener — the
 * user's browser cannot reach the daemon's loopback — and instead hands out
 * a clientless AS consent URL. The injector decides the flow (single-owner =
 * the legacy alias_reauth link). */
export interface WizardHttpConsent {
  mintConsentUrl: (alias: string) => Promise<string> | string;
}

let httpConsent: WizardHttpConsent | null = null;

export function setWizardHttpConsent(ctx: WizardHttpConsent | null): void {
  httpConsent = ctx;
}

// Services register tools at startup: an account's first-enabled service
// stays unregistered until a restart, so say so rather than claim it just works.
function restartNote(pending: readonly string[]): string {
  if (pending.length === 0) return '';
  const names = pending.map((s) => `"${s}"`).join(', ');
  const what = pending.length > 1 ? `services ${names} register their` : `service ${names} registers its`;
  return `\nThe ${what} tools when the server starts: restart the server to use them. Until then, google_api_call can reach the same API.`;
}

function pendingText(alias: string, url: string, pending: readonly string[]): string {
  return (
    `Account "${alias}" is ready to authorize. Open this link in a browser (it belongs to whoever owns the Google account):\n${url}\n` +
    `On completion the token is stored server-side and the account is usable immediately — no restart. ` +
    `If the link expires, run account_reauth for a fresh one.${restartNote(pending)}\n${TESTING_MODE_WARNING}`
  );
}

async function runConsent(server: McpServer, alias: string): Promise<{ ok: true; missing: string[] } | { ok: 'pending'; url: string } | ConsentFailure> {
  const { randomBytes } = await import('node:crypto');
  const cfg = getAccountSet().configs[alias];
  if (!cfg) {
    return {
      ok: false,
      slug: 'E_VALIDATION',
      message: `Account "${alias}" is not in the live registry.`,
      hint: 'Accounts sourced from GOOGLE_ACCOUNTS are not editable here. Run `mcp-google-multi migrate-config` to move them into config.json.',
    };
  }

  // HTTP: consent completes out-of-band at the AS /callback; never bind a
  // loopback listener; surface the URL up front, elicitation is just a convenience.
  const http = httpConsent;
  if (http) {
    let url: string;
    try {
      url = await http.mintConsentUrl(alias);
    } catch (e: unknown) {
      return { ok: false, slug: 'internal', message: safeMessage(e) };
    }
    const caps = server.server.getClientCapabilities?.() as { elicitation?: { url?: unknown } } | undefined;
    if (caps?.elicitation?.url !== undefined) {
      try {
        await server.server.elicitInput(urlElicitationParams(alias, url, randomBytes(16).toString('hex')));
      } catch {
        // pending text has the recovery URL
      }
    }
    return { ok: 'pending', url };
  }

  // Bind the loopback listener before building the auth URL: the redirect URI
  // needs the assigned port, and listening first avoids a race with the callback.
  const loop = await openLoopbackConsent();
  const client = buildConsentClient(loop.redirect);
  const expectedState = randomBytes(32).toString('hex');
  const scopes = resolveScopesForAccount(alias);
  const url = client.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: scopes, login_hint: cfg.email, state: expectedState });
  const consent = loop.finish(client, expectedState);

  // Capability probe: the spec advertises each elicitation mode as a PRESENT
  // object, not a boolean, so test presence rather than truthiness.
  const caps = server.server.getClientCapabilities?.() as { elicitation?: { url?: unknown } } | undefined;
  let opened = false;
  if (caps?.elicitation?.url !== undefined) {
    try {
      // elicitationId is REQUIRED by the spec; omitting it silently fails
      // client-side validation, falling through to the server-side browser open.
      const r = await server.server.elicitInput(
        urlElicitationParams(alias, url, randomBytes(16).toString('hex')),
      );
      if (r.action !== 'accept') {
        loop.close();
        return {
          ok: false,
          slug: 'confirmation_declined',
          message: 'Consent was cancelled, so no token was stored.',
          hint: 'The account row was kept and diagnose reports its token as "missing". Run account_reauth to finish authorizing it.',
        };
      }
      opened = true;
    } catch {
      // fall through to server-side open
    }
  }
  if (!opened) {
    openUrl(url);
  }

  let tokens: Record<string, unknown>;
  try {
    tokens = await consent;
  } catch (e: unknown) {
    // Always surface the URL: the browser hand-off can succeed and consent
    // still fail (declined, timed out), and the URL is the only recovery.
    return {
      ok: false,
      slug: 'auth_required',
      message: safeMessage(e),
      hint: `The browser hand-off can succeed and consent still fail, so this URL is the only recovery. Open it to authorize: ${url}`,
    };
  }
  writeToken(alias, tokens);
  return { ok: true, missing: scopeGrantDiff(scopes, typeof tokens.scope === 'string' ? tokens.scope : undefined) };
}

function s4Text(alias: string, missing: string[], pending: readonly string[]): string {
  const outcome = missing.length === 0
    ? `✔ "${alias}" authenticated; all requested scopes granted. It is now usable without a restart.`
    : `⚠ "${alias}" authenticated, but ${missing.length} requested scope(s) were NOT granted (E_SCOPE_NOT_GRANTED). You may have unchecked some on the consent screen. Re-run account_reauth to grant them. The account is usable for the granted scopes.`;
  return `${outcome}${restartNote(pending)}\n${TESTING_MODE_WARNING}`;
}

const REQUIRES_INTERACTION = { 'anthropic/requiresUserInteraction': true };

export function registerAccountWizardTools(
  registry: ToolRegistry,
  server: McpServer,
  awaitingRestart: () => string[] = () => [],
): void {
  // Registered as meta (like account_list) so onboarding tools are reachable in
  // lazy mode without discover_all; this still preserves requiresUserInteraction and skips fan-out.
  const registerMeta = registry.registerMeta as unknown as (
    name: string,
    config: { description: string; inputSchema: Record<string, unknown>; annotations?: Record<string, unknown>; _meta?: Record<string, unknown> },
    handler: (...a: unknown[]) => unknown,
  ) => void;

  registerMeta(
    'account_add',
    {
      _meta: REQUIRES_INTERACTION,
      annotations: { openWorldHint: true },
      description: 'Add a new Google account: pass alias + email directly (plus optional bundles/allBundles/admin), or pass nothing for an interactive form where the client supports elicitation. Writes the registry and runs Google consent in the browser. No file editing or restart needed to use the account (tools of a service it newly enables register at the next restart). Requires GOOGLE_CLIENT_ID/SECRET (run the `setup` prompt first if missing).',
      inputSchema: {
        alias: z.string().optional().describe('Account alias (letters, digits, _ or -). Pass with email to add directly, skipping the form.'),
        account: z.string().optional().describe('Alias for the new account (same as `alias`; every other tool spells it `account`)'),
        email: z.string().optional().describe("The account's Google address (used as the login hint)"),
        bundles: z.string().optional().describe('Optional scope bundles, comma-separated (e.g. "forms,chat"); blank = base scopes only'),
        allBundles: coerceBoolean.optional().describe('Grant every optional bundle (biggest consent screen); overrides bundles'),
        admin: coerceBoolean.optional().describe('Grant Workspace admin scopes (super-admin accounts only)'),
      },
    },
    async (args: unknown) => {
      try {
        // GOOGLE_ACCOUNTS is the exclusive registry source when set; config.json
        // is ignored, so refuse here rather than write a row nothing reads.
        if (process.env.GOOGLE_ACCOUNTS?.trim()) {
          return errorResult(
            'E_ENV_ACCOUNTS_MODE',
            'Accounts are defined by the GOOGLE_ACCOUNTS environment variable, so a new account cannot be added interactively: config.json is ignored while it is set, and the row would be written where nothing reads it.',
            'Either add the alias to GOOGLE_ACCOUNTS and run account_reauth, or run `mcp-google-multi migrate-config` to move accounts into config.json and unset GOOGLE_ACCOUNTS.',
          );
        }
        if (!hasClientCredentials()) {
          return errorResult(
            'invalid_client',
            'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set, so there is no OAuth client to run consent against.',
            'Run the `setup` prompt (/mcp__google-multi__setup) to create an OAuth client, then set them. See docs/google-cloud-setup.md.',
          );
        }
        // Arguments win over the form so the wizard still works for clients
        // without form elicitation support.
        const a = (args ?? {}) as { alias?: string; account?: string; email?: string; bundles?: string; allBundles?: boolean; admin?: boolean };
        let input: Partial<AddForm>;
        if (a.alias?.trim() || a.account?.trim() || a.email?.trim()) {
          input = argsToAddForm(a);
        } else {
          // Modes are advertised as PRESENT objects, not booleans.
          const caps = server.server.getClientCapabilities?.() as { elicitation?: { form?: unknown } } | undefined;
          if (caps?.elicitation?.form === undefined) {
            return errorResult(
              'elicitation_unsupported',
              'This client does not support the interactive form, and no arguments were supplied, so there is nothing to add.',
              'Call account_add again with arguments instead, e.g. {"alias": "work", "email": "you@example.com"} (optional: "bundles" as a comma-separated list, "allBundles": true, "admin": true).',
            );
          }
          const form = await server.server.elicitInput({ message: 'Add a Google account', requestedSchema: addFormSchema() as never });
          if (form.action !== 'accept') {
            return textResult('confirmation_declined: no account was added.');
          }
          input = (form.content ?? {}) as Partial<AddForm>;
        }
        const validated = validateAddForm(input, getAccountSet().aliases);
        if (!validated.ok) return errorResult(validated.slug, validated.message, validated.hint, validated.alias);

        // Atomic write + make the alias callable without a restart.
        writeAccountRow(validated.alias, validated.email, validated.bundles, validated.admin);
        invalidateAccountSet();
        // Account args already validate against the refreshed registry; the
        // nudge just gets clients to re-fetch tools/list for the new account enum.
        try {
          server.sendToolListChanged();
        } catch {
          // harmless if unsupported
        }

        const consent = await runConsent(server, validated.alias);
        if (consent.ok === 'pending') return textResult(pendingText(validated.alias, consent.url, awaitingRestart()));
        if (!consent.ok) return errorResult(consent.slug, consent.message, consent.hint, validated.alias);
        return textResult(
          `${s4Text(validated.alias, consent.missing, awaitingRestart())}\nTip: run account_write_config to register this server with another MCP client (Claude Desktop / Cursor / Claude Code).`,
        );
      } catch (e: unknown) {
        // safeMessage, not error.message: an arbitrary throw here can carry a
        // token or a whole response body.
        return errorResult('internal', `account_add failed: ${safeMessage(e)}`);
      }
    },
  );

  registerMeta(
    'account_reauth',
    {
      _meta: REQUIRES_INTERACTION,
      annotations: { openWorldHint: true },
      description: 'Re-authenticate an existing Google account (recover a dead refresh token, or grant scopes after a profile change). Runs Google consent in the browser. Pass the account alias.',
      inputSchema: {
        // Plain string (NOT the account enum) so this never joins the
        // multi-account fan-out path; validated against the registry below.
        alias: z.string().min(1).optional().describe('Existing account alias to re-authenticate'),
        // Every other tool spells this `account`; accepting both avoids a dead
        // end no did-you-mean can bridge (too many edits from `alias`).
        account: z.string().min(1).optional().describe('Alias of the account to re-authenticate (same as `alias`)'),
      },
    },
    async (args: unknown) => {
      try {
        const a = args as { alias?: string; account?: string };
        const alias = a.alias ?? a.account ?? '';
        // No default-account wrapper runs for this tool, so pick up a
        // hand-edited config.json here: that edit is why a re-auth is asked for.
        refreshAccountSetIfStale();
        if (!hasClientCredentials()) {
          return errorResult(
            'invalid_client',
            'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set, so there is no OAuth client to run consent against.',
            'Run the `setup` prompt (/mcp__google-multi__setup) to create an OAuth client, then set them. See docs/google-cloud-setup.md.',
          );
        }
        if (!getAccountSet().aliases.includes(alias)) {
          return errorResult(
            'validation_error',
            `Unknown account "${alias}".`,
            `Pass one of the configured aliases: ${getAccountSet().aliases.join(', ')}. Use account_add to create a new one.`,
            alias,
          );
        }
        const consent = await runConsent(server, alias);
        if (consent.ok === 'pending') return textResult(pendingText(alias, consent.url, awaitingRestart()));
        if (!consent.ok) return errorResult(consent.slug, consent.message, consent.hint, alias);
        return textResult(s4Text(alias, consent.missing, awaitingRestart()));
      } catch (e: unknown) {
        return errorResult('internal', `account_reauth failed: ${safeMessage(e)}`);
      }
    },
  );

  registerMeta(
    'account_write_config',
    {
      _meta: REQUIRES_INTERACTION,
      annotations: { openWorldHint: true },
      description:
        "Register this server with your MCP client (Claude Code / Claude Desktop / Cursor) so you don't hand-edit JSON. Default: returns the exact snippet/command to add. Pass write:true to write detected file-based configs in place (backs up first, never clobbers a malformed file). Secrets are never inlined.",
      inputSchema: {
        client: z.enum(['claude-code', 'claude-desktop', 'cursor']).optional().describe('Target one client; default = all detected'),
        name: z.string().optional().describe('Server name in the client config (default mcp-google-multi)'),
        write: z.boolean().optional().describe('Write file-based configs in place (default false = show the snippet only)'),
      },
    },
    async (args: unknown) => {
      try {
        const a = (args ?? {}) as { client?: ClientId; name?: string; write?: boolean };
        const name = a.name?.trim() || DEFAULT_SERVER_NAME;
        let mode: Mode = 'stdio';
        let resourceUri: string | undefined;
        try {
          const { resolveHttpConfig } = await import('../http-config.js');
          const m = resolveMode(resolveHttpConfig());
          mode = m.mode;
          resourceUri = m.resourceUri;
        } catch {
          // fallback to stdio on error
        }
        let entry;
        try {
          entry = buildServerEntry({ name, mode, resourceUri });
        } catch (e) {
          return errorResult('internal', safeMessage(e));
        }
        let clients = detectClients();
        if (a.client) clients = clients.filter((c) => c.id === a.client);
        const present = clients.filter((c) => c.present);
        const targets = a.client ? clients : present.length ? present : clients;

        const blocks: string[] = [];
        for (const client of targets) {
          const instr = renderInstruction(client, name, entry);
          if (client.managed === 'cli') {
            blocks.push(`${client.label}: run\n  ${instr.text}`);
          } else if (a.write && mode === 'http') {
            // Over HTTP this runs on the daemon, not the caller's machine: write:true
            // would edit the operator's own client configs (a tenancy hazard), so snippet only.
            blocks.push(`${client.label}: write:true is ignored over HTTP — this tool runs on the server, not your machine. Add to ${instr.path}\n${instr.text}`);
          } else if (a.write) {
            const res = applyFileEntry(client, name, entry);
            blocks.push(
              res.ok
                ? `${client.label}: ${res.action} "${name}" in ${res.path}${res.backup ? ` (backup ${res.backup})` : ''}`
                : `${client.label}: ${res.message}\n${res.snippet ?? ''}`,
            );
          } else {
            blocks.push(`${client.label}: add to ${instr.path}\n${instr.text}`);
          }
        }
        if (targets.length === 0) {
          blocks.push(`No known MCP client detected. Add this under "mcpServers":\n${JSON.stringify({ [name]: entry }, null, 2)}`);
        }
        const note =
          mode === 'http'
            ? `Remote HTTP (${resourceUri}); authentication is via the OAuth flow, so no secrets are stored in the client config.`
            : 'stdio: secrets stay in ~/.config/mcp-google-multi/.env; the client entry carries none.';
        return textResult(`${blocks.join('\n\n')}\n\n${note}`);
      } catch (e: unknown) {
        return errorResult('internal', `account_write_config failed: ${safeMessage(e)}`);
      }
    },
  );
}
