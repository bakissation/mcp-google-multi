import { describe, it, expect } from 'vitest';
import { normalizeProperty, shapeReport, shapeAccountSummaries, shapeMetadata } from '../src/tools/analytics.js';

describe('normalizeProperty', () => {
  it('accepts a bare numeric ID', () => {
    expect(normalizeProperty('213025502')).toEqual({ name: 'properties/213025502' });
  });

  it('accepts the properties/ resource form and trims whitespace', () => {
    expect(normalizeProperty(' properties/213025502 ')).toEqual({ name: 'properties/213025502' });
  });

  it('accepts property 0 (the standard-metadata pseudo property)', () => {
    expect(normalizeProperty('0')).toEqual({ name: 'properties/0' });
  });

  it('rejects a G-… measurement ID with a pointer to the property ID', () => {
    const res = normalizeProperty('G-AB12CD34');
    expect(res).toHaveProperty('hint');
    expect((res as { hint: string }).hint).toContain('measurement ID');
    expect((res as { hint: string }).hint).toContain('analytics_account_summaries');
  });

  it('rejects a UA-… Universal Analytics property', () => {
    const res = normalizeProperty('UA-12345-1');
    expect((res as { hint: string }).hint).toContain('Universal Analytics');
  });

  it('rejects junk with the expected forms', () => {
    const res = normalizeProperty('my-website');
    expect((res as { hint: string }).hint).toContain('numeric property ID');
  });
});

describe('shapeReport', () => {
  const apiResponse = {
    dimensionHeaders: [{ name: 'country' }, { name: 'deviceCategory' }],
    metricHeaders: [
      { name: 'activeUsers', type: 'TYPE_INTEGER' },
      { name: 'sessions', type: 'TYPE_INTEGER' },
    ],
    rows: [
      {
        dimensionValues: [{ value: 'France' }, { value: 'mobile' }],
        metricValues: [{ value: '120' }, { value: '150' }],
      },
      {
        dimensionValues: [{ value: 'France' }, { value: 'desktop' }],
        metricValues: [{ value: '80' }, { value: '95' }],
      },
    ],
    totals: [
      {
        dimensionValues: [{ value: 'RESERVED_TOTAL' }, { value: 'RESERVED_TOTAL' }],
        metricValues: [{ value: '200' }, { value: '245' }],
      },
    ],
    rowCount: 2,
    propertyQuota: { tokensPerDay: { consumed: 1, remaining: 24999 } },
  };

  it('merges each row into one name-keyed object', () => {
    const shaped = shapeReport(apiResponse);
    expect(shaped.rows).toEqual([
      { country: 'France', deviceCategory: 'mobile', activeUsers: '120', sessions: '150' },
      { country: 'France', deviceCategory: 'desktop', activeUsers: '80', sessions: '95' },
    ]);
    expect(shaped.rowCount).toBe(2);
    expect(shaped.dimensionHeaders).toEqual(['country', 'deviceCategory']);
    expect(shaped.metricHeaders).toEqual([
      { name: 'activeUsers', type: 'TYPE_INTEGER' },
      { name: 'sessions', type: 'TYPE_INTEGER' },
    ]);
  });

  it('keeps totals and propertyQuota only when present', () => {
    const shaped = shapeReport(apiResponse);
    expect(shaped.totals).toEqual([
      { country: 'RESERVED_TOTAL', deviceCategory: 'RESERVED_TOTAL', activeUsers: '200', sessions: '245' },
    ]);
    expect(shaped.propertyQuota).toEqual(apiResponse.propertyQuota);
    const bare = shapeReport({ metricHeaders: [{ name: 'activeUsers', type: 'TYPE_INTEGER' }], rows: [] });
    expect(bare).not.toHaveProperty('totals');
    expect(bare).not.toHaveProperty('propertyQuota');
  });

  it('handles an empty response (no matching rows)', () => {
    const shaped = shapeReport({});
    expect(shaped).toEqual({ rowCount: 0, dimensionHeaders: [], metricHeaders: [], rows: [] });
  });
});

describe('shapeAccountSummaries', () => {
  it('nests properties under their account and keeps the numeric-bearing resource names', () => {
    const shaped = shapeAccountSummaries({
      accountSummaries: [
        {
          name: 'accountSummaries/123',
          account: 'accounts/123',
          displayName: 'Acme',
          propertySummaries: [
            { property: 'properties/456', displayName: 'acme.com', propertyType: 'PROPERTY_TYPE_ORDINARY', parent: 'accounts/123' },
            { property: 'properties/789', displayName: 'Rollup', propertyType: 'PROPERTY_TYPE_ROLLUP', parent: 'accounts/123' },
          ],
        },
      ],
    });
    expect(shaped).toEqual({
      accounts: [
        {
          account: 'accounts/123',
          displayName: 'Acme',
          properties: [
            { property: 'properties/456', displayName: 'acme.com' },
            { property: 'properties/789', displayName: 'Rollup', propertyType: 'PROPERTY_TYPE_ROLLUP' },
          ],
        },
      ],
    });
  });

  it('surfaces nextPageToken only when the API returns one', () => {
    expect(shapeAccountSummaries({ nextPageToken: 'abc' })).toEqual({ accounts: [], nextPageToken: 'abc' });
    expect(shapeAccountSummaries({})).not.toHaveProperty('nextPageToken');
  });
});

describe('shapeMetadata', () => {
  it('caps long descriptions and flags custom definitions', () => {
    const long = 'x'.repeat(400);
    const shaped = shapeMetadata({
      dimensions: [
        { apiName: 'country', uiName: 'Country', category: 'Geography', description: long },
        { apiName: 'customEvent:plan', uiName: 'plan', category: 'Custom', customDefinition: true, description: 'short' },
      ],
      metrics: [
        { apiName: 'activeUsers', uiName: 'Active users', category: 'User', type: 'TYPE_INTEGER', description: 'short' },
      ],
    }) as { dimensions: Array<Record<string, unknown>>; metrics: Array<Record<string, unknown>> };
    expect((shaped.dimensions[0].description as string).length).toBe(160);
    expect(shaped.dimensions[0].description as string).toMatch(/\.\.\.$/);
    expect(shaped.dimensions[0]).not.toHaveProperty('custom');
    expect(shaped.dimensions[1].custom).toBe(true);
    expect(shaped.metrics[0]).toEqual({
      apiName: 'activeUsers',
      uiName: 'Active users',
      category: 'User',
      type: 'TYPE_INTEGER',
      description: 'short',
    });
  });
});
