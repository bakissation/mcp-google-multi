import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildMethodIndex,
  clearDiscoveryMemoryCache,
  cudFromMethod,
  expandPath,
  loadMethodIndex,
  resolveApiAliases,
  searchMethods,
} from '../src/discovery-client.js';

const FIXTURE = {
  rootUrl: 'https://gmail.googleapis.com/',
  servicePath: '',
  resources: {
    users: {
      methods: {
        getProfile: {
          id: 'gmail.users.getProfile',
          httpMethod: 'GET',
          path: 'gmail/v1/users/{userId}/profile',
          description: 'Gets the current user profile.\nSecond line dropped.',
          parameters: { userId: { location: 'path', required: true, type: 'string' } },
          scopes: ['scope-a'],
        },
      },
      resources: {
        messages: {
          methods: {
            send: {
              id: 'gmail.users.messages.send',
              httpMethod: 'POST',
              path: 'gmail/v1/users/{userId}/messages/send',
              description: 'Sends a message.',
              parameters: { userId: { location: 'path', required: true, type: 'string' } },
            },
            batchGet: {
              id: 'gmail.users.messages.batchGet',
              httpMethod: 'POST',
              path: 'gmail/v1/users/{userId}/messages/batchGet',
              description: 'Batch read.',
            },
          },
        },
      },
    },
  },
};

describe('buildMethodIndex', () => {
  const index = buildMethodIndex(FIXTURE as never, 'gmail');

  it('walks nested resources and keeps first-line descriptions', () => {
    expect(index.map((m) => m.id).sort()).toEqual([
      'gmail.users.getProfile',
      'gmail.users.messages.batchGet',
      'gmail.users.messages.send',
    ]);
    const profile = index.find((m) => m.id === 'gmail.users.getProfile')!;
    expect(profile.description).toBe('Gets the current user profile.');
    expect(profile.baseUrl).toBe('https://gmail.googleapis.com/');
    expect(profile.requiredParams).toEqual(['userId']);
  });
});

describe('cudFromMethod', () => {
  it.each([
    ['GET', 'gmail.users.getProfile', 'read'],
    ['DELETE', 'gmail.users.messages.delete', 'delete'],
    ['PATCH', 'gmail.users.labels.patch', 'update'],
    ['PUT', 'gmail.users.labels.update', 'update'],
    ['POST', 'gmail.users.messages.send', 'create'],
    ['POST', 'gmail.users.messages.batchGet', 'read'],
    ['POST', 'sheets.spreadsheets.values.batchGet', 'read'],
    ['POST', 'gmail.users.watch', 'create'],
    ['POST', 'drive.files.export', 'read'],
    ['POST', 'gmail.users.messages.batchDelete', 'delete'],
    ['POST', 'gmail.users.messages.trash', 'delete'],
    ['POST', 'gmail.users.messages.untrash', 'update'],
    ['POST', 'gmail.users.messages.modify', 'update'],
    ['POST', 'gmail.users.settings.cse.keypairs.obliterate', 'delete'],
    ['POST', 'calendar.calendars.clear', 'delete'],
    ['POST', 'tasks.tasks.clear', 'delete'],
    ['POST', 'people.people.batchDeleteContacts', 'delete'],
    ['POST', 'searchconsole.urlInspection.index.inspect', 'read'],
    ['POST', 'analyticsdata.properties.runReport', 'read'],
    ['POST', 'analyticsdata.properties.runRealtimeReport', 'read'],
    ['POST', 'analyticsdata.properties.batchRunPivotReports', 'read'],
    ['POST', 'analyticsdata.properties.checkCompatibility', 'read'],
    ['POST', 'analyticsadmin.properties.runAccessReport', 'read'],
    ['POST', 'analyticsadmin.properties.customDimensions.archive', 'delete'],
    ['POST', 'analyticsadmin.accounts.provisionAccountTicket', 'create'],
    ['POST', 'script.scripts.run', 'create'],

    // Teardown: each one removes something that already existed, so `create`
    // was both wrong and the most permissive class available.
    ['POST', 'meet.spaces.endActiveConference', 'delete'],
    ['POST', 'cloudidentity.devices.wipe', 'delete'],
    ['POST', 'directory.users.signOut', 'delete'],
    ['POST', 'directory.verificationCodes.invalidate', 'delete'],
    ['POST', 'admin.channels.stop', 'delete'],
    ['POST', 'vault.operations.cancel', 'delete'],
    ['POST', 'cloudsearch.settings.searchapplications.reset', 'delete'],
    ['POST', 'reseller.resellernotify.unregister', 'delete'],
    ['POST', 'cloudsearch.indexing.datasources.items.unreserve', 'delete'],

    // `cancelWipe` calls OFF a pending wipe. It must beat the `cancel` rule,
    // which is why the update list is tested before the delete list.
    ['POST', 'cloudidentity.devices.deviceUsers.cancelWipe', 'update'],

    // State transitions on something that exists: reversible, create nothing.
    ['POST', 'vault.matters.close', 'update'],
    ['POST', 'vault.matters.reopen', 'update'],
    ['POST', 'drivelabels.labels.disable', 'update'],
    ['POST', 'drivelabels.labels.enable', 'update'],
    ['POST', 'drive.drives.hide', 'update'],
    ['POST', 'directory.users.makeAdmin', 'update'],
    ['POST', 'directory.twoStepVerification.turnOff', 'update'],
    ['POST', 'reseller.subscriptions.suspend', 'update'],
    ['POST', 'reseller.subscriptions.activate', 'update'],
    ['POST', 'reseller.subscriptions.changeSeats', 'update'],
    ['POST', 'classroom.courses.courseWork.studentSubmissions.turnIn', 'update'],
    ['POST', 'classroom.invitations.accept', 'update'],
    ['POST', 'chat.spaces.completeImport', 'update'],

    // Without `(batch)?` on the update list every batchUpdate* POST fell
    // through to `create`, i.e. overwriting data was classified as additive.
    ['POST', 'people.people.batchUpdateContacts', 'update'],
    ['POST', 'sheets.spreadsheets.values.batchUpdateByDataFilter', 'update'],

    // A POST purely because the request carries a body.
    ['POST', 'cloudsearch.query.suggest', 'read'],
  ])('%s %s → %s', (httpMethod, id, expected) => {
    expect(cudFromMethod({ httpMethod, id })).toBe(expected);
  });
});

describe('expandPath', () => {
  it('expands and encodes simple params', () => {
    expect(expandPath('gmail/v1/users/{userId}/profile', { userId: 'a b@c' })).toBe(
      'gmail/v1/users/a%20b%40c/profile',
    );
  });

  it('preserves slashes for reserved {+param} expansion', () => {
    expect(expandPath('v1/{+name}/messages', { name: 'spaces/AAA' })).toBe('v1/spaces/AAA/messages');
  });

  it('throws on missing params', () => {
    expect(() => expandPath('users/{userId}', {})).toThrow(/userId/);
  });

  // An empty id collapses its segment and Google routes the trailing-slash URL
  // to the collection, so a `get` silently answers with a LIST.
  it.each(['', '   '])('throws on a blank path param (%j)', (value) => {
    expect(() => expandPath('v3/sites/{siteUrl}', { siteUrl: value })).toThrow(/"siteUrl" is empty/);
  });

  it('throws on a blank segment inside a {+param}', () => {
    expect(() => expandPath('v1/{+name}/messages', { name: 'spaces//AAA' })).toThrow(/"name" is empty/);
  });

  // `..` survives encodeURIComponent, so without this guard one argument
  // retargets the call at a different endpoint on the same host.
  it.each(['.', '..'])('throws on a %j path param', (value) => {
    expect(() => expandPath('calendars/primary/events/{eventId}', { eventId: value })).toThrow(
      /path segment/,
    );
  });

  it('throws on a dot segment inside a {+param}', () => {
    expect(() => expandPath('v1/{+resourceName}', { resourceName: '../v1/contactGroups' })).toThrow(
      /"\.\." path segment/,
    );
  });

  it('still accepts dots inside a segment', () => {
    expect(expandPath('v1/{+name}/x', { name: 'spaces/a.b.c' })).toBe('v1/spaces/a.b.c/x');
    expect(expandPath('files/{fileId}', { fileId: 'my.file.txt' })).toBe('files/my.file.txt');
  });
});

describe('searchMethods', () => {
  const index = buildMethodIndex(FIXTURE as never, 'gmail');

  it('ranks id matches above description matches', () => {
    const results = searchMethods(index, 'send message');
    expect(results[0].id).toBe('gmail.users.messages.send');
  });

  it('returns nothing for unmatched tokens', () => {
    expect(searchMethods(index, 'zzz-no-match')).toEqual([]);
  });
});

describe('loadMethodIndex caching', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disc-test-'));
    clearDiscoveryMemoryCache();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    clearDiscoveryMemoryCache();
  });

  const okFetch = (calls: string[]) => async (url: string) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => FIXTURE };
  };

  it('fetches once, then serves from cache', async () => {
    const calls: string[] = [];
    const deps = { fetchFn: okFetch(calls), cacheDir: dir };
    const first = await loadMethodIndex('gmail', deps);
    expect(first).toHaveLength(3);
    expect(calls).toEqual(['https://www.googleapis.com/discovery/v1/apis/gmail/v1/rest']);

    clearDiscoveryMemoryCache();
    await loadMethodIndex('gmail', deps);
    expect(calls).toHaveLength(1);
    expect(fs.existsSync(path.join(dir, 'gmail.json'))).toBe(true);
  });

  it('falls back to the per-service $discovery endpoint when the central directory 404s (newer APIs)', async () => {
    const calls: string[] = [];
    const fetchFn = async (url: string) => {
      calls.push(url);
      if (url.startsWith('https://www.googleapis.com/discovery')) {
        return { ok: false, status: 404, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => FIXTURE };
    };
    const index = await loadMethodIndex('analyticsadmin', { fetchFn, cacheDir: dir });
    expect(index).toHaveLength(3);
    expect(calls).toEqual([
      'https://www.googleapis.com/discovery/v1/apis/analyticsadmin/v1beta/rest',
      'https://analyticsadmin.googleapis.com/$discovery/rest?version=v1beta',
    ]);
    expect(fs.existsSync(path.join(dir, 'analyticsadmin.json'))).toBe(true);
  });

  it('falls back to a stale cache when offline', async () => {
    const calls: string[] = [];
    await loadMethodIndex('gmail', { fetchFn: okFetch(calls), cacheDir: dir });
    clearDiscoveryMemoryCache();

    const failing = async () => {
      throw new Error('offline');
    };
    const stale = await loadMethodIndex('gmail', {
      fetchFn: failing,
      cacheDir: dir,
      now: () => Date.now() + 30 * 24 * 60 * 60 * 1000,
    });
    expect(stale).toHaveLength(3);
  });

  it('retries the fetch after a stale fallback once connectivity returns', async () => {
    const calls: string[] = [];
    await loadMethodIndex('gmail', { fetchFn: okFetch(calls), cacheDir: dir });
    clearDiscoveryMemoryCache();

    let t = Date.now() + 30 * 24 * 60 * 60 * 1000;
    const failing = async () => {
      throw new Error('offline');
    };
    await loadMethodIndex('gmail', { fetchFn: failing, cacheDir: dir, now: () => t });

    t += 6 * 60 * 1000;
    await loadMethodIndex('gmail', { fetchFn: okFetch(calls), cacheDir: dir, now: () => t });
    expect(calls).toHaveLength(2);
  });

  it('errors clearly when offline with no cache', async () => {
    const failing = async () => {
      throw new Error('offline');
    };
    await expect(loadMethodIndex('gmail', { fetchFn: failing, cacheDir: dir })).rejects.toThrow(/no local cache/);
  });

  it('rejects unknown apis', async () => {
    await expect(loadMethodIndex('nope', { cacheDir: dir })).rejects.toThrow(/Unknown api/);
  });
});

describe('resolveApiAliases', () => {
  it('returns an exact SUPPORTED_APIS key as-is', () => {
    expect(resolveApiAliases('gmail')).toEqual(['gmail']);
    expect(resolveApiAliases('admin_directory')).toEqual(['admin_directory']);
  });

  it('normalizes case and punctuation to a real key', () => {
    expect(resolveApiAliases('Search-Console')).toEqual(['searchconsole']);
    expect(resolveApiAliases('Admin Directory')).toEqual(['admin_directory']);
  });

  it('fans an umbrella alias out to every real API behind it', () => {
    expect(resolveApiAliases('analytics')).toEqual(['analyticsadmin', 'analyticsdata']);
    expect(resolveApiAliases('ga4')).toEqual(['analyticsadmin', 'analyticsdata']);
    expect(resolveApiAliases('admin')).toEqual(['admin_directory', 'admin_reports', 'admin_datatransfer']);
  });

  it('maps legacy/common names to the current key', () => {
    expect(resolveApiAliases('webmasters')).toEqual(['searchconsole']);
    expect(resolveApiAliases('contacts')).toEqual(['people']);
  });

  it('returns null for a genuinely unknown name', () => {
    expect(resolveApiAliases('nope')).toBeNull();
  });
});
