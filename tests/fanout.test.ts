import { describe, it, expect } from 'vitest';
import { CSV_RE, invalidAccountsResult, parseAccountSelector, runFanout } from '../src/fanout.js';

const ACCOUNTS = ['alpha', 'beta', 'gamma'] as const;

describe('CSV_RE', () => {
  it.each([
    ['alpha,beta', true],
    ['alpha, beta', true],
    ['alpha , beta , gamma', true],
    ['alpha', false],
    ['*', false],
    ['alpha,', false],
    [',alpha', false],
    ['alpha;beta', false],
  ])('%s → %s', (value, expected) => {
    expect(CSV_RE.test(value)).toBe(expected);
  });
});

describe('parseAccountSelector', () => {
  it('expands * to all accounts in order', () => {
    expect(parseAccountSelector('*', ACCOUNTS)).toEqual({ ok: true, fanout: true, aliases: ['alpha', 'beta', 'gamma'] });
  });

  it('passes a single alias through without fan-out', () => {
    expect(parseAccountSelector('beta', ACCOUNTS)).toEqual({ ok: true, fanout: false, aliases: ['beta'] });
  });

  it('parses CSV subsets, trimming and deduping in order', () => {
    expect(parseAccountSelector(' alpha , beta ,alpha', ACCOUNTS)).toEqual({
      ok: true,
      fanout: true,
      aliases: ['alpha', 'beta'],
    });
  });

  it('a CSV that dedupes to one alias is not a fan-out', () => {
    expect(parseAccountSelector('alpha,alpha', ACCOUNTS)).toEqual({ ok: true, fanout: false, aliases: ['alpha'] });
  });

  it('rejects unknown aliases with the bad tokens listed', () => {
    expect(parseAccountSelector('alpha,bogus,nope', ACCOUNTS)).toEqual({ ok: false, invalid: ['bogus', 'nope'] });
  });
});

describe('invalidAccountsResult', () => {
  it('returns a typed validation_error envelope', () => {
    const res = invalidAccountsResult(['bogus'], ACCOUNTS);
    expect(res.isError).toBe(true);
    const payload = JSON.parse(res.content[0].text);
    expect(payload.error).toBe('validation_error');
    expect(payload.message).toContain('bogus');
    expect(payload.hint).toContain('alpha, beta, gamma');
  });
});

describe('runFanout', () => {
  const okHandler = async (args: { account: string }) => ({
    content: [{ type: 'text', text: JSON.stringify({ files: [`${args.account}-file`] }) }],
  });

  it('tags each result with its account and preserves order', async () => {
    const out = await runFanout(okHandler as never, [{ account: '*', query: 'x' }], ['alpha', 'beta']);
    expect(out.isError).toBeUndefined();
    const body = JSON.parse(out.content[0].text);
    expect(body.partial).toBe(false);
    expect(body.results).toEqual([
      { account: 'alpha', ok: true, data: { files: ['alpha-file'] } },
      { account: 'beta', ok: true, data: { files: ['beta-file'] } },
    ]);
  });

  it('isolates per-account failures and flags partial', async () => {
    const mixed = async (args: { account: string }) => {
      if (args.account === 'beta') {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'auth_required', message: 'x', retriable: false, account: 'beta' }) }],
          isError: true,
        };
      }
      return okHandler(args);
    };
    const out = await runFanout(mixed as never, [{ account: '*' }], ['alpha', 'beta']);
    expect(out.isError).toBeUndefined();
    const body = JSON.parse(out.content[0].text);
    expect(body.partial).toBe(true);
    expect(body.results[0]).toMatchObject({ account: 'alpha', ok: true });
    expect(body.results[1]).toMatchObject({ account: 'beta', ok: false, error: { error: 'auth_required' } });
  });

  it('marks the result as an error only when every account fails', async () => {
    const failing = async () => ({ content: [{ type: 'text', text: '{"error":"x"}' }], isError: true });
    const out = await runFanout(failing as never, [{ account: '*' }], ['alpha', 'beta']);
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content[0].text).partial).toBe(true);
  });

  it('catches thrown handlers defensively', async () => {
    const throwing = async () => {
      throw new Error('boom');
    };
    const out = await runFanout(throwing as never, [{ account: '*' }], ['alpha']);
    const body = JSON.parse(out.content[0].text);
    expect(body.results[0]).toMatchObject({ account: 'alpha', ok: false, error: { error: 'internal', message: 'boom' } });
  });

  it('embeds non-JSON text payloads as raw strings', async () => {
    const plain = async () => ({ content: [{ type: 'text', text: 'not json' }] });
    const out = await runFanout(plain as never, [{ account: '*' }], ['alpha']);
    expect(JSON.parse(out.content[0].text).results[0].data).toBe('not json');
  });

  it('bounds concurrency at 5', async () => {
    let inFlight = 0;
    let peak = 0;
    const slow = async (args: { account: string }) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return okHandler(args);
    };
    const aliases = Array.from({ length: 12 }, (_, i) => `a${i}`);
    await runFanout(slow as never, [{ account: '*' }], aliases);
    expect(peak).toBeLessThanOrEqual(5);
  });

  it('rewrites the account arg per alias and preserves other args', async () => {
    const seen: string[] = [];
    const capture = async (args: { account: string; q: string }) => {
      seen.push(`${args.account}:${args.q}`);
      return okHandler(args as never);
    };
    await runFanout(capture as never, [{ account: 'alpha,beta', q: 'keep' }], ['alpha', 'beta']);
    expect(seen.sort()).toEqual(['alpha:keep', 'beta:keep']);
  });
});
