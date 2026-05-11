import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { google } from 'googleapis';
import { ACCOUNTS } from '../accounts.js';
import type { Account } from '../accounts.js';
import { getClient } from '../client.js';
import { handleGoogleApiError } from './_errors.js';
import { adminWritesEnabled } from '../auth.js';

const accountEnum = z.enum(ACCOUNTS);

/**
 * Admin SDK tools require Workspace super-admin (or delegated admin) privileges on the target account.
 * Personal `@gmail.com` accounts will 403 on every endpoint.
 *
 * Writes are gated behind GOOGLE_ALLOW_ADMIN_WRITES=true to prevent accidents on small orgs
 * (a stray users.update on a 3-person Workspace is a bad day).
 */
export function registerAdminTools(server: McpServer): void {
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
        startTime: z.string().optional().describe('RFC 3339 lower bound'),
        endTime: z.string().optional().describe('RFC 3339 upper bound'),
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
    async ({ account, applicationName, userKey, startTime, endTime, eventName, actorIpAddress, filters, orgUnitID, groupIdFilter, customerId, maxResults, pageToken }) => {
      try {
        const auth = await getClient(account as Account);
        const reports = google.admin({ version: 'reports_v1', auth });
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

  // ─── Alert Center ──────────────────────────────────────────────────────

  server.registerTool(
    'alertcenter_alerts_list',
    {
      description: 'List Workspace security alerts (suspicious login, phishing, leaked password, Drive exfil, etc.)',
      inputSchema: {
        account: accountEnum.describe('Google account alias (must be a Workspace admin)'),
        pageSize: z.number().min(1).max(1000).optional(),
        pageToken: z.string().optional(),
        filter: z.string().optional().describe('Filter expression, e.g. "type = \\"Suspicious login\\""'),
        orderBy: z.string().optional(),
        customerId: z.string().optional(),
      },
    },
    async ({ account, pageSize, pageToken, filter, orderBy, customerId }) => {
      try {
        const auth = await getClient(account as Account);
        const alertcenter = google.alertcenter({ version: 'v1beta1', auth });
        const res = await alertcenter.alerts.list({
          pageSize: pageSize ?? 50,
          pageToken,
          filter,
          orderBy,
          customerId,
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
    'alertcenter_alert_get',
    {
      description: 'Get a single alert by ID',
      inputSchema: {
        account: accountEnum.describe('Google account alias (must be a Workspace admin)'),
        alertId: z.string().describe('Alert ID'),
        customerId: z.string().optional(),
      },
    },
    async ({ account, alertId, customerId }) => {
      try {
        const auth = await getClient(account as Account);
        const alertcenter = google.alertcenter({ version: 'v1beta1', auth });
        const res = await alertcenter.alerts.get({ alertId, customerId });
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
        query: z.string().optional().describe('Search query, e.g. "name:John"'),
        maxResults: z.number().min(1).max(500).optional(),
        pageToken: z.string().optional(),
        orderBy: z.enum(['email', 'familyName', 'givenName']).optional(),
        showDeleted: z.boolean().optional(),
        projection: z.enum(['basic', 'custom', 'full']).optional(),
      },
    },
    async ({ account, customer, domain, query, maxResults, pageToken, orderBy, showDeleted, projection }) => {
      try {
        const auth = await getClient(account as Account);
        const directory = google.admin({ version: 'directory_v1', auth });
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
        userKey: z.string().describe('User email or ID'),
        projection: z.enum(['basic', 'custom', 'full']).optional(),
      },
    },
    async ({ account, userKey, projection }) => {
      try {
        const auth = await getClient(account as Account);
        const directory = google.admin({ version: 'directory_v1', auth });
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

  server.registerTool(
    'admin_users_update',
    {
      description: 'Update a Workspace user (PATCH semantics). GATED: requires GOOGLE_ALLOW_ADMIN_WRITES=true to prevent accidental destructive ops on small orgs.',
      inputSchema: {
        account: accountEnum.describe('Google account alias (must be a Workspace admin)'),
        userKey: z.string().describe('User email or ID'),
        givenName: z.string().optional(),
        familyName: z.string().optional(),
        suspended: z.boolean().optional(),
        password: z.string().optional(),
        changePasswordAtNextLogin: z.boolean().optional(),
        orgUnitPath: z.string().optional(),
      },
    },
    async ({ account, userKey, givenName, familyName, suspended, password, changePasswordAtNextLogin, orgUnitPath }) => {
      try {
        if (!adminWritesEnabled()) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                error: 'admin_writes_disabled',
                hint: 'Admin write operations are disabled by default. Set GOOGLE_ALLOW_ADMIN_WRITES=true in .env and restart to enable.',
              }),
            }],
            isError: true,
          };
        }
        const auth = await getClient(account as Account);
        const directory = google.admin({ version: 'directory_v1', auth });
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
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'No fields to update' }) }], isError: true };
        }

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
        const auth = await getClient(account as Account);
        const directory = google.admin({ version: 'directory_v1', auth });
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
        groupKey: z.string().describe('Group email or ID'),
        roles: z.string().optional().describe('Comma-separated roles to include (OWNER, MANAGER, MEMBER)'),
        includeDerivedMembership: z.boolean().optional(),
        maxResults: z.number().min(1).max(200).optional(),
        pageToken: z.string().optional(),
      },
    },
    async ({ account, groupKey, roles, includeDerivedMembership, maxResults, pageToken }) => {
      try {
        const auth = await getClient(account as Account);
        const directory = google.admin({ version: 'directory_v1', auth });
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

function handleAdminError(error: any, account: Account) {
  return handleGoogleApiError(error, account, "Admin tools require Workspace super-admin privileges AND the account must be listed in GOOGLE_ADMIN_ACCOUNTS (then re-authenticated). Personal Gmail accounts cannot use these endpoints.");
}
