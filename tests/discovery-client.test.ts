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
