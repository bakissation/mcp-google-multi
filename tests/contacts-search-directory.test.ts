import { describe, it, expect } from 'vitest';
import { toolHarness, parseResult, type GoogleRequest } from './_tool-harness.js';

const person = (id: string, name: string, email: string) => ({
  resourceName: `people/${id}`,
  names: [{ displayName: name }],
  emailAddresses: [{ value: email }],
  organizations: [{ name: 'Example Inc', title: 'Engineer' }],
  addresses: [{ formattedValue: '1 Example Street' }],
});

const directory = (req: GoogleRequest): unknown => {
  void req;
  return {
    people: [person('1', 'Ada Example', 'ada@example.com'), person('2', 'Bob Example', 'bob@example.com')],
    nextPageToken: 'next-1',
    totalSize: 42,
  };
};

describe('contacts_search_directory', () => {
  it('searches profiles and domain contacts and returns a paged list', async () => {
    const h = toolHarness({ respond: directory });
    const res = await h.call('contacts_search_directory', { account: 'test', query: 'exam' });
    expect(res.isError).toBeFalsy();
    const out = parseResult(res);
    expect(out.people).toHaveLength(2);
    expect(out.people[0]).toMatchObject({ name: 'Ada Example' });
    expect(JSON.stringify(out)).toContain('ada@example.com');
    expect(JSON.stringify(out)).not.toContain('Example Street');
    expect(out.nextPageToken).toBe('next-1');

    const req = h.requests()[0];
    expect(req.url).toContain('searchDirectoryPeople');
    expect(req.params).toMatchObject({
      query: 'exam',
      pageSize: 10,
      sources: ['DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE', 'DIRECTORY_SOURCE_TYPE_DOMAIN_CONTACT'],
    });
    expect(String(req.params.readMask)).toContain('emailAddresses');
  });

  it('can limit the search to user profiles and pass paging through', async () => {
    const h = toolHarness({ respond: directory });
    await h.call('contacts_search_directory', {
      account: 'test', query: 'ada', pageSize: 5, pageToken: 'tok', includeDomainContacts: false,
    });
    expect(h.requests()[0].params).toMatchObject({
      pageSize: 5,
      pageToken: 'tok',
      sources: ['DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE'],
    });
  });

  it('returns an empty list when nobody matches', async () => {
    const h = toolHarness({ respond: () => ({}) });
    const out = parseResult(await h.call('contacts_search_directory', { account: 'test', query: 'zzz' }));
    expect(out.people).toEqual([]);
  });

  it('points at the directory bundle when the scope is missing', async () => {
    const h = toolHarness({
      respond: () => {
        throw Object.assign(new Error('Insufficient Permission'), {
          code: 403,
          errors: [{ reason: 'insufficientPermissions' }],
        });
      },
    });
    const res = await h.call('contacts_search_directory', { account: 'test', query: 'ada' });
    expect(res.isError).toBe(true);
    const out = parseResult(res);
    expect(out.error).toBe('insufficient_scope');
    expect(JSON.stringify(out)).toContain('directory');
  });

  it('rejects an empty query before calling Google', async () => {
    const h = toolHarness({ respond: directory });
    const res = await h.call('contacts_search_directory', { account: 'test', query: '' });
    expect(res.isError).toBe(true);
    expect(h.request).not.toHaveBeenCalled();
  });
});
