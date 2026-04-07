import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { google } from 'googleapis';
import { ACCOUNTS } from '../accounts.js';
import type { Account } from '../accounts.js';
import { getClient } from '../client.js';

const accountEnum = z.enum(ACCOUNTS);

const PERSON_FIELDS = 'names,emailAddresses,phoneNumbers,organizations,addresses,photos,memberships';

function formatContact(person: any) {
  return {
    resourceName: person.resourceName,
    name: person.names?.[0]?.displayName ?? '',
    givenName: person.names?.[0]?.givenName ?? '',
    familyName: person.names?.[0]?.familyName ?? '',
    emails: (person.emailAddresses ?? []).map((e: any) => ({
      value: e.value,
      type: e.type ?? '',
    })),
    phones: (person.phoneNumbers ?? []).map((p: any) => ({
      value: p.value,
      type: p.type ?? '',
    })),
    organizations: (person.organizations ?? []).map((o: any) => ({
      name: o.name ?? '',
      title: o.title ?? '',
      department: o.department ?? '',
    })),
    addresses: (person.addresses ?? []).map((a: any) => ({
      formattedValue: a.formattedValue ?? '',
      type: a.type ?? '',
    })),
    photo: person.photos?.[0]?.url ?? '',
  };
}

export function registerContactsTools(server: McpServer): void {
  // contacts_search
  server.registerTool(
    'contacts_search',
    {
      description: 'Search contacts by name, email, phone, or organization',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        query: z.string().describe('Search query (prefix matching on names, emails, phones, organizations)'),
        pageSize: z.number().min(1).max(30).default(10).optional()
          .describe('Max results (1-30, default: 10)'),
      },
    },
    async ({ account, query, pageSize }) => {
      try {
        const auth = await getClient(account as Account);
        const people = google.people({ version: 'v1', auth });

        // Warmup request required by the People API
        await people.people.searchContacts({
          query: '',
          readMask: 'names',
        });

        const res = await people.people.searchContacts({
          query,
          readMask: PERSON_FIELDS,
          pageSize: pageSize ?? 10,
        });

        const contacts = (res.data.results ?? []).map((r: any) => formatContact(r.person));
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(contacts, null, 2) }],
        };
      } catch (error: any) {
        return handleContactsError(error, account as Account);
      }
    },
  );

  // contacts_get
  server.registerTool(
    'contacts_get',
    {
      description: 'Get a single contact by resource name',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        resourceName: z.string().describe('Contact resource name (e.g. "people/c1234567890")'),
      },
    },
    async ({ account, resourceName }) => {
      try {
        const auth = await getClient(account as Account);
        const people = google.people({ version: 'v1', auth });
        const res = await people.people.get({
          resourceName,
          personFields: PERSON_FIELDS,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(formatContact(res.data), null, 2) }],
        };
      } catch (error: any) {
        return handleContactsError(error, account as Account);
      }
    },
  );

  // contacts_list
  server.registerTool(
    'contacts_list',
    {
      description: 'List all contacts (paginated)',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        pageSize: z.number().min(1).max(1000).default(100).optional()
          .describe('Number of contacts per page (default: 100)'),
        pageToken: z.string().optional().describe('Page token for pagination'),
        sortOrder: z.enum([
          'LAST_MODIFIED_ASCENDING',
          'LAST_MODIFIED_DESCENDING',
          'FIRST_NAME_ASCENDING',
          'LAST_NAME_ASCENDING',
        ]).default('FIRST_NAME_ASCENDING').optional()
          .describe('Sort order (default: FIRST_NAME_ASCENDING)'),
      },
    },
    async ({ account, pageSize, pageToken, sortOrder }) => {
      try {
        const auth = await getClient(account as Account);
        const people = google.people({ version: 'v1', auth });
        const res = await people.people.connections.list({
          resourceName: 'people/me',
          personFields: PERSON_FIELDS,
          pageSize: pageSize ?? 100,
          pageToken: pageToken ?? undefined,
          sortOrder: sortOrder ?? 'FIRST_NAME_ASCENDING',
        });
        const contacts = (res.data.connections ?? []).map(formatContact);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            contacts,
            totalItems: res.data.totalItems,
            nextPageToken: res.data.nextPageToken ?? null,
          }, null, 2) }],
        };
      } catch (error: any) {
        return handleContactsError(error, account as Account);
      }
    },
  );

  // contacts_create
  server.registerTool(
    'contacts_create',
    {
      description: 'Create a new contact',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        givenName: z.string().describe('First name'),
        familyName: z.string().optional().describe('Last name'),
        email: z.string().optional().describe('Email address'),
        emailType: z.enum(['home', 'work', 'other']).default('work').optional()
          .describe('Email type (default: work)'),
        phone: z.string().optional().describe('Phone number'),
        phoneType: z.enum(['home', 'work', 'mobile', 'other']).default('mobile').optional()
          .describe('Phone type (default: mobile)'),
        organization: z.string().optional().describe('Company/organization name'),
        jobTitle: z.string().optional().describe('Job title'),
      },
    },
    async ({ account, givenName, familyName, email, emailType, phone, phoneType, organization, jobTitle }) => {
      try {
        const auth = await getClient(account as Account);
        const people = google.people({ version: 'v1', auth });

        const requestBody: any = {
          names: [{ givenName, familyName: familyName ?? '' }],
        };
        if (email) {
          requestBody.emailAddresses = [{ value: email, type: emailType ?? 'work' }];
        }
        if (phone) {
          requestBody.phoneNumbers = [{ value: phone, type: phoneType ?? 'mobile' }];
        }
        if (organization || jobTitle) {
          requestBody.organizations = [{
            name: organization ?? '',
            title: jobTitle ?? '',
          }];
        }

        const res = await people.people.createContact({
          personFields: PERSON_FIELDS,
          requestBody,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(formatContact(res.data), null, 2) }],
        };
      } catch (error: any) {
        return handleContactsError(error, account as Account);
      }
    },
  );

  // contacts_update
  server.registerTool(
    'contacts_update',
    {
      description: 'Update an existing contact (reads current etag automatically)',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        resourceName: z.string().describe('Contact resource name (e.g. "people/c1234567890")'),
        givenName: z.string().optional().describe('Updated first name'),
        familyName: z.string().optional().describe('Updated last name'),
        email: z.string().optional().describe('Updated email address'),
        emailType: z.enum(['home', 'work', 'other']).default('work').optional()
          .describe('Email type'),
        phone: z.string().optional().describe('Updated phone number'),
        phoneType: z.enum(['home', 'work', 'mobile', 'other']).default('mobile').optional()
          .describe('Phone type'),
        organization: z.string().optional().describe('Updated company/organization name'),
        jobTitle: z.string().optional().describe('Updated job title'),
      },
    },
    async ({ account, resourceName, givenName, familyName, email, emailType, phone, phoneType, organization, jobTitle }) => {
      try {
        const auth = await getClient(account as Account);
        const people = google.people({ version: 'v1', auth });

        // Fetch current contact to get etag
        const current = await people.people.get({
          resourceName,
          personFields: PERSON_FIELDS,
        });
        const etag = current.data.etag;

        const requestBody: any = { etag };
        const updateFields: string[] = [];

        if (givenName !== undefined || familyName !== undefined) {
          requestBody.names = [{
            givenName: givenName ?? current.data.names?.[0]?.givenName ?? '',
            familyName: familyName ?? current.data.names?.[0]?.familyName ?? '',
          }];
          updateFields.push('names');
        }
        if (email !== undefined) {
          requestBody.emailAddresses = [{ value: email, type: emailType ?? 'work' }];
          updateFields.push('emailAddresses');
        }
        if (phone !== undefined) {
          requestBody.phoneNumbers = [{ value: phone, type: phoneType ?? 'mobile' }];
          updateFields.push('phoneNumbers');
        }
        if (organization !== undefined || jobTitle !== undefined) {
          requestBody.organizations = [{
            name: organization ?? current.data.organizations?.[0]?.name ?? '',
            title: jobTitle ?? current.data.organizations?.[0]?.title ?? '',
          }];
          updateFields.push('organizations');
        }

        if (updateFields.length === 0) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({
              error: 'No fields to update. Provide at least one of: givenName, familyName, email, phone, organization, jobTitle',
            }, null, 2) }],
            isError: true,
          };
        }

        const res = await people.people.updateContact({
          resourceName,
          updatePersonFields: updateFields.join(','),
          personFields: PERSON_FIELDS,
          requestBody,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(formatContact(res.data), null, 2) }],
        };
      } catch (error: any) {
        return handleContactsError(error, account as Account);
      }
    },
  );

  // contacts_delete
  server.registerTool(
    'contacts_delete',
    {
      description: 'Delete a contact (permanent, cannot be undone)',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        resourceName: z.string().describe('Contact resource name (e.g. "people/c1234567890")'),
      },
    },
    async ({ account, resourceName }) => {
      try {
        const auth = await getClient(account as Account);
        const people = google.people({ version: 'v1', auth });
        await people.people.deleteContact({ resourceName });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            deleted: resourceName,
          }, null, 2) }],
        };
      } catch (error: any) {
        return handleContactsError(error, account as Account);
      }
    },
  );

  // contacts_groups_list
  server.registerTool(
    'contacts_groups_list',
    {
      description: 'List all contact groups (labels)',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        pageSize: z.number().min(1).max(1000).default(100).optional()
          .describe('Max groups to return (default: 100)'),
      },
    },
    async ({ account, pageSize }) => {
      try {
        const auth = await getClient(account as Account);
        const people = google.people({ version: 'v1', auth });
        const res = await people.contactGroups.list({
          pageSize: pageSize ?? 100,
          groupFields: 'name,groupType,memberCount',
        });
        const groups = (res.data.contactGroups ?? []).map((g: any) => ({
          resourceName: g.resourceName,
          name: g.name,
          groupType: g.groupType,
          memberCount: g.memberCount ?? 0,
        }));
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(groups, null, 2) }],
        };
      } catch (error: any) {
        return handleContactsError(error, account as Account);
      }
    },
  );

  // contacts_group_members
  server.registerTool(
    'contacts_group_members',
    {
      description: 'List members of a contact group',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        groupResourceName: z.string().describe('Contact group resource name (e.g. "contactGroups/abc123")'),
        maxMembers: z.number().min(1).max(1000).default(100).optional()
          .describe('Max member resource names to return (default: 100)'),
      },
    },
    async ({ account, groupResourceName, maxMembers }) => {
      try {
        const auth = await getClient(account as Account);
        const people = google.people({ version: 'v1', auth });

        // Get group with member resource names
        const groupRes = await people.contactGroups.get({
          resourceName: groupResourceName,
          maxMembers: maxMembers ?? 100,
        });

        const memberResourceNames = groupRes.data.memberResourceNames ?? [];
        if (memberResourceNames.length === 0) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({
              group: groupRes.data.name,
              members: [],
            }, null, 2) }],
          };
        }

        // Batch get the actual contact details
        const membersRes = await people.people.getBatchGet({
          resourceNames: memberResourceNames,
          personFields: PERSON_FIELDS,
        });

        const members = (membersRes.data.responses ?? [])
          .filter((r: any) => r.person)
          .map((r: any) => formatContact(r.person));

        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            group: groupRes.data.name,
            members,
          }, null, 2) }],
        };
      } catch (error: any) {
        return handleContactsError(error, account as Account);
      }
    },
  );

  // contacts_group_create
  server.registerTool(
    'contacts_group_create',
    {
      description: 'Create a new contact group (label)',
      inputSchema: {
        account: accountEnum.describe('Google account alias'),
        name: z.string().describe('Name for the contact group'),
      },
    },
    async ({ account, name }) => {
      try {
        const auth = await getClient(account as Account);
        const people = google.people({ version: 'v1', auth });
        const res = await people.contactGroups.create({
          requestBody: {
            contactGroup: { name },
          },
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            resourceName: res.data.resourceName,
            name: res.data.name,
            groupType: res.data.groupType,
          }, null, 2) }],
        };
      } catch (error: any) {
        return handleContactsError(error, account as Account);
      }
    },
  );
}

function handleContactsError(error: any, account: Account) {
  if (error.code === 401) {
    return {
      content: [{
        type: 'text' as const,
        text: `Authentication error for account "${account}". Run: node dist/index.js auth --account ${account}`,
      }],
      isError: true,
    };
  }
  if (error.code === 429) {
    const retryAfter = error.response?.headers?.['retry-after'] ?? 'unknown';
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ error: 'rate_limited', retryAfter }),
      }],
      isError: true,
    };
  }
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({ error: error.message ?? String(error), code: error.code }),
    }],
    isError: true,
  };
}
