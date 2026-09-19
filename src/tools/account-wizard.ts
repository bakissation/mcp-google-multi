import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolRegistry } from '../registry.js';
import { getAccountSet, invalidateAccountSet } from '../accounts.js';
import { mutateConfigFile } from '../config-file.js';
import { writeToken } from '../token-store.js';
import { resolveScopesForAccount } from '../auth.js';
import { BUNDLE_CATALOG, closestBundle, resolveBundleAliases } from '../scope-catalog.js';
import { openUrl } from '../open-url.js';
import {
  buildConsentClient, awaitLoopbackConsent, hasClientCredentials,
} from '../oauth-consent.js';
import {
  detectClients, buildServerEntry, renderInstruction, applyFileEntry, resolveMode,
  DEFAULT_SERVER_NAME, type ClientId, type Mode,
} from '../client-config.js';

// B7: the elicitation-driven account_add / account_reauth wizard. It rebuilds
// interactive account management on the mutable config.json registry so a
// running server can add an account without the deployer editing env + running
// a CLI. Google consent reuses the loopback flow (leg C); the HTTP-transport
// consent path (${BASE}/authorize) is owned by the OAuth AS and lands with that
// cluster — account_add over http is gated behind it.

const ALIAS_RE = /^[a-zA-Z0-9_-]+$/;

export interface AddForm {
  alias: string;
  email: string;
  allBundles: boolean;
  forms: boolean;
  chat: boolean;
  otherBundles: string;
  admin: boolean;
}

// The common optional bundles get their own checkbox (MCP elicitation has no
// multi-select, so a boolean per bundle IS the checklist); the long tail stays
// a comma-separated field for power users, and `allBundles` grants every one.
const CHECKBOX_BUNDLES = ['forms', 'chat'] as const;

/** Every optional bundle (admin is granted via its own checkbox, not here). */
export function allOptionalBundles(): string[] {
  return Object.keys(BUNDLE_CATALOG).filter((n) => n !== 'admin');
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
  | { ok: false; slug: string; message: string };

/** Validate the collected form against the alias rules, dup check, and the
 * bundle catalog. Pure (no I/O) for unit testing. */
export function validateAddForm(input: Partial<AddForm>, existingAliases: string[]): AddValidation {
  const alias = (input.alias ?? '').trim();
  const email = (input.email ?? '').trim();
  if (!ALIAS_RE.test(alias)) {
    return { ok: false, slug: 'E_VALIDATION', message: `Invalid alias "${alias}". Use letters, digits, "_" or "-".` };
  }
  if (existingAliases.includes(alias)) {
    return { ok: false, slug: 'E_ALIAS_EXISTS', message: `Alias "${alias}" already exists; use account_reauth to re-authenticate it, or pick another name.` };
  }
  if (email === '') {
    return { ok: false, slug: 'E_VALIDATION', message: 'Email is required (used as the Google login hint).' };
  }
  if (input.allBundles === true) {
    // "All optional scopes" supersedes the individual picks.
    return { ok: true, alias, email, bundles: allOptionalBundles(), admin: input.admin === true };
  }
  const picked = CHECKBOX_BUNDLES.filter((b) => input[b] === true);
  const rawOther = (input.otherBundles ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const bundles = [...new Set(resolveBundleAliases([...picked, ...rawOther]))];
  for (const b of bundles) {
    if (b === 'admin') {
      return { ok: false, slug: 'E_UNKNOWN_BUNDLE', message: '"admin" is not a bundle — use the admin checkbox instead.' };
    }
    if (!(b in BUNDLE_CATALOG)) {
      const hint = closestBundle(b);
      return { ok: false, slug: 'E_UNKNOWN_BUNDLE', message: `Unknown bundle "${b}"${hint ? ` — did you mean "${hint}"?` : ''}. Known: ${Object.keys(BUNDLE_CATALOG).filter((n) => n !== 'admin').join(', ')}.` };
    }
  }
  return { ok: true, alias, email, bundles, admin: input.admin === true };
}

/** Scopes requested by the profile but NOT granted at consent (granular
 * consent / unchecked bundles). Pure. */
export function scopeGrantDiff(requested: string[], grantedScope: string | undefined): string[] {
  const granted = new Set((grantedScope ?? '').split(' ').filter(Boolean));
  return requested.filter((s) => !granted.has(s));
}

/** Persist a new account row (+ a per-account scope profile when bundles/admin
 * were chosen) through the atomic registry mutation path (BR2). */
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

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], ...(isError ? { isError: true } : {}) };
}

/** Run Google consent for `alias` and persist the token. Opens the browser via
 * URL-mode elicitation when the client supports it, else server-side + prints
 * the URL. Returns the granted-scope diff for the S4 report. */
async function runConsent(server: McpServer, alias: string): Promise<{ ok: true; missing: string[] } | { ok: false; text: string }> {
  const { randomBytes } = await import('node:crypto');
  const cfg = getAccountSet().configs[alias];
  if (!cfg) return { ok: false, text: `E_VALIDATION: account "${alias}" is not in the live registry (env-sourced accounts are not editable here).` };
  const client = buildConsentClient();
  const expectedState = randomBytes(32).toString('hex');
  const scopes = resolveScopesForAccount(alias);
  const url = client.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: scopes, login_hint: cfg.email, state: expectedState });

  // Start the loopback listener BEFORE opening the browser so it can't miss the
  // redirect. Any startup error (e.g. port in use) surfaces synchronously.
  const consent = awaitLoopbackConsent(client, expectedState);

  const caps = server.server.getClientCapabilities?.();
  let opened = false;
  if ((caps as { elicitation?: { url?: boolean } } | undefined)?.elicitation?.url) {
    try {
      const r = await server.server.elicitInput({ mode: 'url', message: `Authorize the "${alias}" Google account in your browser.`, url } as never);
      if ((r as { action?: string }).action !== 'accept') {
        return { ok: false, text: 'confirmation_declined: consent was cancelled; the account row was kept but no token was stored (doctor will show it as "missing").' };
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
    return { ok: false, text: `${(e as Error).message}${opened ? '' : `\nOpen this URL to authorize:\n${url}`}` };
  }
  writeToken(alias, tokens);
  return { ok: true, missing: scopeGrantDiff(scopes, typeof tokens.scope === 'string' ? tokens.scope : undefined) };
}

function s4Text(alias: string, missing: string[]): string {
  if (missing.length === 0) return `✔ "${alias}" authenticated; all requested scopes granted. It is now usable without a restart.`;
  return `⚠ "${alias}" authenticated, but ${missing.length} requested scope(s) were NOT granted (E_SCOPE_NOT_GRANTED) — you may have unchecked some on the consent screen. Re-run account_reauth to grant them. The account is usable for the granted scopes.`;
}

const REQUIRES_INTERACTION = { 'anthropic/requiresUserInteraction': true };

export function registerAccountWizardTools(registry: ToolRegistry, server: McpServer): void {
  // Registered as META (always-visible, like account_list) so onboarding tools
  // are reachable in lazy mode without discover_all first; registerMeta still
  // preserves the requiresUserInteraction clientMeta and skips the fan-out path.
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
      description: 'Add a new Google account interactively: collects alias/email/scope bundles via a form, writes the registry, and runs Google consent in the browser — no file editing or restart needed. Requires GOOGLE_CLIENT_ID/SECRET (run the `setup` prompt first if missing).',
      inputSchema: {},
    },
    async () => {
      try {
        // Env-sourced registry: GOOGLE_ACCOUNTS is the exclusive source and
        // config.json accounts are ignored, so a wizard add would be a phantom
        // write. Refuse up front (BR-10) rather than write a row nothing reads.
        if (process.env.GOOGLE_ACCOUNTS?.trim()) {
          return textResult('E_ENV_ACCOUNTS_MODE: accounts are defined by the GOOGLE_ACCOUNTS environment variable, so new accounts cannot be added interactively (config.json is ignored while it is set). Either add the alias to GOOGLE_ACCOUNTS and run account_reauth, or run `mcp-google-multi migrate-config` to move accounts into config.json and unset GOOGLE_ACCOUNTS.', true);
        }
        if (!hasClientCredentials()) {
          return textResult('E_CLIENT_CREDENTIALS_MISSING: GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET are not set. Run the `setup` prompt (/mcp__google-multi__setup) to create an OAuth client, then set them.', true);
        }
        const caps = server.server.getClientCapabilities?.() as { elicitation?: { form?: boolean } } | undefined;
        if (!caps?.elicitation?.form) {
          return textResult('This client does not support form elicitation. Add the account from the CLI instead: `npx mcp-google-multi account add --alias <alias> --email <email> [--profile a,b] [--admin]`.', true);
        }

        // S1: collect the registry row.
        const form = await server.server.elicitInput({ message: 'Add a Google account', requestedSchema: addFormSchema() } as never);
        if ((form as { action?: string }).action !== 'accept') {
          return textResult('confirmation_declined: no account was added.');
        }
        const validated = validateAddForm((form as { content?: Partial<AddForm> }).content ?? {}, getAccountSet().aliases);
        if (!validated.ok) return textResult(`${validated.slug}: ${validated.message}`, true);

        // S2: atomic write + make the alias callable without a restart (BR3).
        writeAccountRow(validated.alias, validated.email, validated.bundles, validated.admin);
        invalidateAccountSet();

        // S3 + S4: consent + validate.
        const consent = await runConsent(server, validated.alias);
        if (!consent.ok) return textResult(consent.text, true);
        // B15: offer to register the server with another MCP client.
        return textResult(
          `${s4Text(validated.alias, consent.missing)}\nTip: run account_write_config to register this server with another MCP client (Claude Desktop / Cursor / Claude Code).`,
        );
      } catch (e: unknown) {
        return textResult(`account_add failed: ${(e as Error).message}`, true);
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
        alias: z.string().describe('Existing account alias to re-authenticate'),
      },
    },
    async (args: unknown) => {
      try {
        const alias = (args as { alias?: string }).alias ?? '';
        if (!hasClientCredentials()) {
          return textResult('E_CLIENT_CREDENTIALS_MISSING: GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET are not set.', true);
        }
        if (!getAccountSet().aliases.includes(alias)) {
          return textResult(`E_VALIDATION: unknown account "${alias}". Known: ${getAccountSet().aliases.join(', ')}. Use account_add for a new one.`, true);
        }
        const consent = await runConsent(server, alias);
        if (!consent.ok) return textResult(consent.text, true);
        return textResult(s4Text(alias, consent.missing));
      } catch (e: unknown) {
        return textResult(`account_reauth failed: ${(e as Error).message}`, true);
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
          // stdio fallback on any config error
        }
        let entry;
        try {
          entry = buildServerEntry({ name, mode, resourceUri });
        } catch (e) {
          return textResult((e as Error).message, true);
        }
        let clients = detectClients();
        if (a.client) clients = clients.filter((c) => c.id === a.client);
        const present = clients.filter((c) => c.present);
        const targets = a.client ? clients : present.length ? present : clients;

        const blocks: string[] = [];
        for (const client of targets) {
          const instr = renderInstruction(client, name, entry);
          if (client.managed === 'cli') {
            blocks.push(`${client.label} — run:\n  ${instr.text}`);
          } else if (a.write) {
            const res = applyFileEntry(client, name, entry);
            blocks.push(
              res.ok
                ? `${client.label} — ${res.action} "${name}" in ${res.path}${res.backup ? ` (backup ${res.backup})` : ''}`
                : `${client.label} — ${res.message}\n${res.snippet ?? ''}`,
            );
          } else {
            blocks.push(`${client.label} — add to ${instr.path}:\n${instr.text}`);
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
        return textResult(`account_write_config failed: ${(e as Error).message}`, true);
      }
    },
  );
}
