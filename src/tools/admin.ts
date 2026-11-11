import type { ToolRegistry } from '../registry.js';
import { z } from 'zod';
import { coerceBoolean } from './_coerce.js';
import { admin as adminClient } from '@googleapis/admin';
import { accountArgLive } from '../accounts.js';
import type { Account } from '../accounts.js';
import { getAdminAccounts, getFullAdminAccounts } from '../auth.js';
import { getClient, type CuratedToolDeps } from '../client.js';
import { escapeHatchGate } from './_escape-hatch.js';
import { isAllowed, writeDisabledResult } from '../write-control.js';
import { escapeHatchNames } from './google-api.js';
import { handleGoogleApiError, invalidParams, safeMessage, stringifyEnvelope } from './_errors.js';


const GMAIL_REPORT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Gmail audit queries need both bounds, at most 30 days apart; other
 * applications take either bound. With only startTime the end is "now". */
export function resolveReportsWindow(
  applicationName: string,
  startTime: string | undefined,
  endTime: string | undefined,
  now: number = Date.now(),
): { endTime: string | undefined } | { problem: string; hint: string } {
  const start = startTime === undefined ? undefined : Date.parse(startTime);
  const end = endTime === undefined ? undefined : Date.parse(endTime);
  if (start !== undefined && Number.isNaN(start)) {
    return { problem: '`startTime` is not an RFC 3339 timestamp.', hint: 'Use a value such as 2026-10-01T00:00:00Z.' };
  }
  if (end !== undefined && Number.isNaN(end)) {
    return { problem: '`endTime` is not an RFC 3339 timestamp.', hint: 'Use a value such as 2026-10-31T00:00:00Z.' };
  }
  const effectiveEnd = endTime ?? (start !== undefined ? new Date(now).toISOString() : undefined);
  if (applicationName !== 'gmail') return { endTime: effectiveEnd };
  if (start === undefined) {
    return {
      problem: 'Gmail audit queries need a time window and `startTime` was not given.',
      hint: 'Pass startTime, and optionally endTime (it defaults to now). The window may span at most 30 days.',
    };
  }
  const span = Date.parse(effectiveEnd as string) - start;
  if (span > GMAIL_REPORT_WINDOW_MS) {
    return {
      problem: 'The Gmail audit window is longer than 30 days.',
      hint: 'Google allows at most 30 days between startTime and endTime for Gmail. Query one 30-day window at a time.',
    };
  }
  return { endTime: effectiveEnd };
}

// Admin SDK requires Workspace super-admin (or delegated admin) on the account — personal @gmail.com accounts 403 on every endpoint.
export function registerAdminTools(server: ToolRegistry, deps: CuratedToolDeps = {}): void {
  // Per-registry, live account enum + injectable client: the schema follows
  // the registry's account view at parse time, not a process-global default.
  const accountEnum = accountArgLive(() => server.accountAliases()).optional();
  const getClientFn = deps.getClientFn ?? getClient;
  // ─── Reports / audit log ───────────────────────────────────────────────

  server.registerTool(
    'reports_activities_list',
    {
      description: 'List Admin Activity audit log entries. Filter by application (login, drive, gmail, admin, token, etc.), user, date range, event. The single most useful admin endpoint for SMB visibility.',
      inputSchema: {
        account: accountEnum.describe('Google account alias (must be a Workspace admin)'),
        applicationName: z.enum([
          'access_transparency', 'admin', 'calendar', 'chat', 'drive', 'gcp', 'gmail',
          'gplus', 'groups', 'groups_enterprise', 'jamboard', 'login', 'meet', 'mobile',
          'rules', 'saml', 'token', 'user_accounts', 'context_aware_access', 'chrome',
          'data_studio', 'keep', 'vault', 'classroom', 'assignments', 'cloud_search',
          'tasks', 'data_migration', 'meet_hardware', 'directory_sync', 'ldap',
          'profile', 'contacts', 'takeout',
        ]).describe('Which application\'s activity to query'),
        userKey: z.string().default('all').optional().describe('User profile ID, email, or "all" (default)'),
        startTime: z.string().optional().describe('RFC 3339 lower bound. Gmail needs it, with at most 30 days to endTime.'),
        endTime: z.string().optional().describe('RFC 3339 upper bound (defaults to now when only startTime is given)'),
        eventName: z.string().optional().describe('Specific event name to filter'),
        actorIpAddress: z.string().optional(),
        filters: z.string().optional().describe('Comma-separated event-parameter filters with relational operators'),
        orgUnitID: z.string().optional(),
        groupIdFilter: z.string().optional(),
        customerId: z.string().optional(),
        maxResults: z.number().min(1).max(1000).optional(),
        pageToken: z.string().optional(),
      },
    },
    async ({ account, applicationName, userKey, startTime, endTime: endTimeArg, eventName, actorIpAddress, filters, orgUnitID, groupIdFilter, customerId, maxResults, pageToken }) => {
      const window = resolveReportsWindow(applicationName, startTime, endTimeArg);
      if ('problem' in window) return invalidParams(account as Account, window.problem, window.hint);
      const endTime = window.endTime;
      try {
        const auth = await getClientFn(account as Account);
        const reports = adminClient({ version: 'reports_v1', auth });
        const res = await reports.activities.list({
          applicationName,
          userKey: userKey ?? 'all',
          startTime,
          endTime,
          eventName,
          actorIpAddress,
          filters,
          orgUnitID,
          groupIdFilter,
          customerId,
          maxResults: maxResults ?? 100,
          pageToken,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        return handleAdminError(error, account as Account);
      }
    },
  );

  // ─── Directory: users ─────────────────────────────────────────────────

  server.registerTool(
    'admin_users_list',
    {
      description: 'List users in the Workspace customer. Filter by domain or customer=my_customer.',
      inputSchema: {
        account: accountEnum.describe('Google account alias (must be a Workspace admin)'),
        customer: z.string().default('my_customer').optional(),
        domain: z.string().optional(),
        query: z.string().optional().describe(
          'Directory search query: space-separated clauses of field+operator+value, ANDed together. ' +
          '"=" is exact match, ":" is a contains/startsWith match. Searchable fields include email, name ' +
          '(matches the concatenated givenName+familyName), givenName, familyName, isAdmin, isDelegatedAdmin, ' +
          'orgName, orgTitle, orgDepartment, manager, directManager, addressCountry. Prefix/wildcard matching ' +
          'is a trailing "*" on a ":" clause, e.g. "email:admin*" for every address starting with "admin". ' +
          'Examples: \'name:John\', \'isAdmin=true\', \'orgTitle:Manager orgName=Engineering\'.',
        ),
        maxResults: z.number().min(1).max(500).optional(),
        pageToken: z.string().optional(),
        orderBy: z.enum(['email', 'familyName', 'givenName']).optional(),
        showDeleted: coerceBoolean.optional(),
        projection: z.enum(['basic', 'custom', 'full']).optional(),
      },
    },
    async ({ account, customer, domain, query, maxResults, pageToken, orderBy, showDeleted, projection }) => {
      try {
        const auth = await getClientFn(account as Account);
        const directory = adminClient({ version: 'directory_v1', auth });
        const res = await directory.users.list({
          customer: customer ?? 'my_customer',
          domain,
          query,
          maxResults: maxResults ?? 100,
          pageToken,
          orderBy,
          showDeleted: showDeleted !== undefined ? (showDeleted ? 'true' : 'false') : undefined,
          projection: projection ?? 'basic',
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        return handleAdminError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'admin_users_get',
    {
      description: 'Get a single Workspace user by email or user ID',
      inputSchema: {
        account: accountEnum.describe('Google account alias (must be a Workspace admin)'),
        userKey: z.string().min(1).describe('User email or ID'),
        projection: z.enum(['basic', 'custom', 'full']).optional(),
      },
    },
    async ({ account, userKey, projection }) => {
      try {
        const auth = await getClientFn(account as Account);
        const directory = adminClient({ version: 'directory_v1', auth });
        const res = await directory.users.get({
          userKey,
          projection: projection ?? 'basic',
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        return handleAdminError(error, account as Account);
      }
    },
  );

  // `escapeHatch` and `requiredScopes` are registry extensions the SDK config type does not
  // carry. Passing the config as a variable (not a fresh literal) skips the excess-property
  // check while keeping `server.registerTool(` visible to scripts/extract-curated-method-map.ts.
  const usersUpdateConfig = {
    description: 'Update a Workspace user (PATCH semantics). Can suspend a user or set a password, so it asks for confirmation like the Google API escape hatch (runs without asking only under full-writes).',
    // Same gate as the generated admin.users.patch twin: the handler asks a
    // human under safe-writes, so the registry's name-based gate stands aside.
    escapeHatch: true,
    requiredScopes: ['https://www.googleapis.com/auth/admin.directory.user'],
    inputSchema: {
      account: accountEnum.describe('Google account alias (must be a Workspace admin)'),
      userKey: z.string().min(1).describe('User email or ID'),
      givenName: z.string().optional(),
      familyName: z.string().optional(),
      suspended: coerceBoolean.optional(),
      password: z.string().optional(),
      changePasswordAtNextLogin: coerceBoolean.optional(),
      orgUnitPath: z.string().optional(),
    },
  };
  server.registerTool(
    'admin_users_update',
    usersUpdateConfig,
    async (args, ctx) => {
      const { account, userKey, givenName, familyName, suspended, password, changePasswordAtNextLogin, orgUnitPath } = args as {
        account: string;
        userKey: string;
        givenName?: string;
        familyName?: string;
        suspended?: boolean;
        password?: string;
        changePasswordAtNextLogin?: boolean;
        orgUnitPath?: string;
      };
      try {
        const requestBody: any = {};
        if (givenName !== undefined || familyName !== undefined) {
          requestBody.name = {};
          if (givenName !== undefined) requestBody.name.givenName = givenName;
          if (familyName !== undefined) requestBody.name.familyName = familyName;
        }
        if (suspended !== undefined) requestBody.suspended = suspended;
        if (password !== undefined) requestBody.password = password;
        if (changePasswordAtNextLogin !== undefined) requestBody.changePasswordAtNextLogin = changePasswordAtNextLogin;
        if (orgUnitPath !== undefined) requestBody.orgUnitPath = orgUnitPath;

        if (Object.keys(requestBody).length === 0) {
          return invalidParams(
            account as Account,
            'No fields to update: every optional field was omitted, so the request would have been a no-op.',
            'Pass at least one of: givenName, familyName, suspended, password, changePasswordAtNextLogin, orgUnitPath.',
          );
        }

        // The default read-only profile refused this curated write before it asked; keep that.
        // Asking is for safe-writes and above (the escape hatch's own model).
        const ref = { name: 'admin_users_update', service: 'admin', cud: 'update' as const };
        if (server.policy.profile === 'read-only' && !isAllowed(ref, server.policy)) {
          return writeDisabledResult(ref, server.policy, account as string);
        }

        const names = escapeHatchNames('admin', 'directory.users.patch');
        const gate = await escapeHatchGate(
          server,
          names.deny,
          names.primary,
          { service: 'admin', cud: 'update', scopes: ['https://www.googleapis.com/auth/admin.directory.user'] },
          server.policy,
          {
            account: account as string,
            accountEmail: server.accountSet().configs[account as string]?.email,
            methodId: 'directory.users.patch',
            httpMethod: 'PATCH',
            pathParams: { userKey },
            queryParams: {},
            body: requestBody,
          },
          ctx,
        );
        if (gate) return gate;

        const auth = await getClientFn(account as Account);
        const directory = adminClient({ version: 'directory_v1', auth });
        const res = await directory.users.patch({ userKey, requestBody });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        return handleAdminError(error, account as Account);
      }
    },
  );

  // ─── Directory: groups ────────────────────────────────────────────────

  server.registerTool(
    'admin_groups_list',
    {
      description: 'List groups in the Workspace customer',
      inputSchema: {
        account: accountEnum.describe('Google account alias (must be a Workspace admin)'),
        customer: z.string().default('my_customer').optional(),
        domain: z.string().optional(),
        userKey: z.string().optional().describe('Only return groups containing this user'),
        query: z.string().optional(),
        maxResults: z.number().min(1).max(200).optional(),
        pageToken: z.string().optional(),
      },
    },
    async ({ account, customer, domain, userKey, query, maxResults, pageToken }) => {
      try {
        const auth = await getClientFn(account as Account);
        const directory = adminClient({ version: 'directory_v1', auth });
        const res = await directory.groups.list({
          customer: customer ?? 'my_customer',
          domain,
          userKey,
          query,
          maxResults: maxResults ?? 100,
          pageToken,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        return handleAdminError(error, account as Account);
      }
    },
  );

  server.registerTool(
    'admin_group_members_list',
    {
      description: 'List members of a Workspace group',
      inputSchema: {
        account: accountEnum.describe('Google account alias (must be a Workspace admin)'),
        groupKey: z.string().min(1).describe('Group email or ID'),
        roles: z.string().optional().describe('Comma-separated roles to include (OWNER, MANAGER, MEMBER)'),
        includeDerivedMembership: coerceBoolean.optional(),
        maxResults: z.number().min(1).max(200).optional(),
        pageToken: z.string().optional(),
      },
    },
    async ({ account, groupKey, roles, includeDerivedMembership, maxResults, pageToken }) => {
      try {
        const auth = await getClientFn(account as Account);
        const directory = adminClient({ version: 'directory_v1', auth });
        const res = await directory.members.list({
          groupKey,
          roles,
          includeDerivedMembership,
          maxResults: maxResults ?? 100,
          pageToken,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res.data, null, 2) }],
        };
      } catch (error: any) {
        return handleAdminError(error, account as Account);
      }
    },
  );
}

export function handleAdminError(error: any, account: Account) {
  // Google answers a group address passed as a user key with a terse 400.
  const raw = error?.code ?? error?.status ?? error?.response?.status;
  const status = typeof raw === 'string' ? Number(raw) : raw;
  const text = String(error?.response?.data?.error?.message ?? error?.message ?? '');
  if (status === 400 && /type not supported:\s*userKey/i.test(text)) {
    return {
      content: [{
        type: 'text' as const,
        text: stringifyEnvelope({
          error: 'bad_request',
          message: safeMessage(error),
          hint: 'userKey must be a user\'s primary email address or user ID. A group address is not a user: list groups with admin_groups_list and read a group\'s members with admin_group_members_list.',
          retriable: false,
          account,
        }),
      }],
      isError: true as const,
    };
  }
  const readOnly = getAdminAccounts().includes(account) && !getFullAdminAccounts().includes(account);
  const admin = readOnly
    ? 'This account has read-only admin (admin_readonly). Writes need the admin bundle or admin: true on the account, then a re-authorization.'
    : 'Admin tools require Workspace super-admin privileges AND the account must be listed as an admin account (then re-authenticated). Personal Gmail accounts cannot use these endpoints.';
  return handleGoogleApiError(error, account, { scope: admin, resource: admin, bundle: 'admin' });
}
