import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs, { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync, readdirSync, readlinkSync, linkSync, utimesSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileStamp, getTokenDir, resolveAccounts } from '../src/accounts.js';
import { ConfigFileError } from '../src/config-file.js';
import { loadConfigFile, mutateConfigFile, CONFIG_VERSION } from '../src/config-file.js';
import { __setLockIdentityForTest, atomicWriteWithLock, withFileLock } from '../src/fs-atomic.js';
import { runMigrateConfig } from '../src/migrate-config.js';

let base: string;
let cfgPath: string;

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), 'cfgreg-'));
  cfgPath = path.join(base, 'config.json');
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const spyExit = () => {
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('exit-called');
  });
  return { stderr, exit };
};

describe('resolveAccounts', () => {
  it('BR-2: non-empty GOOGLE_ACCOUNTS takes the whole registry from env', () => {
    writeFileSync(
      cfgPath,
      JSON.stringify({ version: 1, accounts: { fileacct: { email: 'f@x.com' } } }),
    );
    const set = resolveAccounts({ GOOGLE_ACCOUNTS: 'work:w@x.com' } as NodeJS.ProcessEnv, cfgPath);
    expect(set.source).toBe('env');
    expect(set.aliases).toEqual(['work']);
    expect(set.configs.work.source).toBe('env');
  });

  it('loads the registry from config.json when env is unset', () => {
    writeFileSync(
      cfgPath,
      JSON.stringify({
        version: 1,
        accounts: { work: { email: 'w@x.com', scopeProfile: 'base' }, pers: { email: 'p@x.com', admin: true } },
      }),
    );
    const set = resolveAccounts({} as NodeJS.ProcessEnv, cfgPath);
    expect(set.source).toBe('file');
    expect(set.aliases).toEqual(['work', 'pers']);
    expect(set.configs.work.scopeProfile).toBe('base');
    expect(set.configs.pers.admin).toBe(true);
    expect(set.configs.work.source).toBe('config');
    expect(set.configs.work.encPath.endsWith('work.enc')).toBe(true);
    expect(set.stamp).toMatch(/^1:/);
  });

  it('GOOGLE_ADMIN_ACCOUNTS env overrides file admin flags when set', () => {
    writeFileSync(
      cfgPath,
      JSON.stringify({ version: 1, accounts: { a: { email: 'a@x.com', admin: true }, b: { email: 'b@x.com' } } }),
    );
    const set = resolveAccounts({ GOOGLE_ADMIN_ACCOUNTS: 'b' } as NodeJS.ProcessEnv, cfgPath);
    expect(set.configs.a.admin).toBe(false);
    expect(set.configs.b.admin).toBe(true);
  });

  it('empty registry is non-fatal at module-load severity (gap #23): returns an empty set, never exits', () => {
    // The refuse-to-start moved off module load so the bootstrap/diagnostic CLIs
    // (doctor/reset/import/config check) can run on a fresh install. The SERVER
    // still refuses empty via assertServerAccountsConfigured(); the dispatch
    // reload ('throw') still raises (see the reload-safety test below).
    const { exit } = spyExit();
    const set = resolveAccounts({} as NodeJS.ProcessEnv, cfgPath);
    expect(set.aliases).toEqual([]);
    expect(set.configs).toEqual({});
    expect(set.source).toBe('file');
    expect(exit).not.toHaveBeenCalled();
  });

  it('first-run shim materializes config.json from env, and only once', () => {
    const env = { GOOGLE_ACCOUNTS: 'work:w@x.com,ops:o@x.com', GOOGLE_ADMIN_ACCOUNTS: 'ops' } as NodeJS.ProcessEnv;
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    resolveAccounts(env, cfgPath);
    expect(existsSync(cfgPath)).toBe(true);
    const written = JSON.parse(readFileSync(cfgPath, 'utf8'));
    expect(written).toEqual({
      version: CONFIG_VERSION,
      accounts: { work: { email: 'w@x.com' }, ops: { email: 'o@x.com', admin: true } },
    });
    // 0o600 is ACL-wise a no-op on Windows (mode reads 0o666 there).
    if (process.platform !== 'win32') expect(statSync(cfgPath).mode & 0o777).toBe(0o600);
    const mtime = statSync(cfgPath).mtimeMs;
    resolveAccounts(env, cfgPath);
    expect(statSync(cfgPath).mtimeMs).toBe(mtime);
  });

  it('keeps the v5 guards on env entries', () => {
    expect(() => resolveAccounts({ GOOGLE_ACCOUNTS: 'bad entry' } as NodeJS.ProcessEnv, cfgPath)).toThrow(
      'Expected format: alias:email',
    );
    expect(() => resolveAccounts({ GOOGLE_ACCOUNTS: '../evil:e@x.com' } as NodeJS.ProcessEnv, cfgPath)).toThrow(
      'Allowed characters',
    );
    expect(() => resolveAccounts({ GOOGLE_ACCOUNTS: 'a:1@x.com,a:2@x.com' } as NodeJS.ProcessEnv, cfgPath)).toThrow(
      'Duplicate alias',
    );
  });
});

describe('resolveAccounts tokenDir threading (S1.6)', () => {
  it('opts.tokenDir scopes every tokenPath/encPath; default stays the global dir', () => {
    writeFileSync(cfgPath, JSON.stringify({ version: 1, accounts: { work: { email: 'w@x.com' } } }));
    const scoped = resolveAccounts({} as NodeJS.ProcessEnv, cfgPath, 'exit', { tokenDir: path.join(base, 'tenant-tokens') });
    expect(scoped.configs.work.encPath).toBe(path.join(base, 'tenant-tokens', 'work.enc'));
    expect(scoped.configs.work.tokenPath).toBe(path.join(base, 'tenant-tokens', 'work', 'token.json'));
    const global = resolveAccounts({} as NodeJS.ProcessEnv, cfgPath);
    expect(global.configs.work.encPath).toBe(path.join(getTokenDir(), 'work.enc'));
  });

  it('env-sourced accounts honor opts.tokenDir too', () => {
    const set = resolveAccounts({ GOOGLE_ACCOUNTS: 'work:w@x.com' } as NodeJS.ProcessEnv, cfgPath, 'exit', { tokenDir: path.join(base, 't') });
    expect(set.configs.work.encPath).toBe(path.join(base, 't', 'work.enc'));
  });
});

describe('resolveAccounts emptyOk (a context with nothing linked yet)', () => {
  it("'throw' refuses an empty set by default but returns one with emptyOk", () => {
    writeFileSync(cfgPath, JSON.stringify({ version: 1, accounts: {} }));
    expect(() => resolveAccounts({} as NodeJS.ProcessEnv, cfgPath, 'throw')).toThrow(/E_NO_ACCOUNTS_CONFIGURED/);
    const set = resolveAccounts({} as NodeJS.ProcessEnv, cfgPath, 'throw', { emptyOk: true });
    expect(set.aliases).toEqual([]);
    expect(set.source).toBe('file');
  });

  it('a missing file is an empty set with emptyOk', () => {
    expect(resolveAccounts({} as NodeJS.ProcessEnv, path.join(base, 'absent.json'), 'throw', { emptyOk: true }).aliases).toEqual([]);
  });

  it('an invalid file still throws with emptyOk', () => {
    writeFileSync(cfgPath, JSON.stringify({ version: 1, accounts: {}, clientSecret: 'x' }));
    expect(() => resolveAccounts({} as NodeJS.ProcessEnv, cfgPath, 'throw', { emptyOk: true })).toThrow();
  });
});

describe('fileStamp (exported for tenant-scoped resolvers, S1.6)', () => {
  it('stamps version:mtime for an existing file and version:0 for a missing one', () => {
    writeFileSync(cfgPath, '{}');
    const stamped = fileStamp(cfgPath, CONFIG_VERSION);
    expect(stamped).toBe(`${CONFIG_VERSION}:${statSync(cfgPath).mtimeMs}`);
    expect(fileStamp(path.join(base, 'nope.json'), CONFIG_VERSION)).toBe(`${CONFIG_VERSION}:0`);
  });
});

describe('loadConfigFile', () => {
  it('returns null when the file does not exist', () => {
    expect(loadConfigFile(cfgPath)).toBeNull();
  });

  it('E_CONFIG_INVALID on malformed JSON', () => {
    writeFileSync(cfgPath, '{nope');
    const { stderr } = spyExit();
    expect(() => loadConfigFile(cfgPath)).toThrow('exit-called');
    expect(String(stderr.mock.calls[0]?.[0])).toContain('E_CONFIG_INVALID');
  });

  it('E_CONFIG_INVALID on a secret-shaped or unknown key (strict schema)', () => {
    writeFileSync(cfgPath, JSON.stringify({ version: 1, clientSecret: 'oops' }));
    const { stderr } = spyExit();
    expect(() => loadConfigFile(cfgPath)).toThrow('exit-called');
    expect(String(stderr.mock.calls[0]?.[0])).toContain('E_CONFIG_INVALID');
  });

  it('E_CONFIG_INVALID on a path-traversal alias key', () => {
    writeFileSync(cfgPath, JSON.stringify({ version: 1, accounts: { '../evil': { email: 'e@x.com' } } }));
    const { stderr } = spyExit();
    expect(() => loadConfigFile(cfgPath)).toThrow('exit-called');
    expect(String(stderr.mock.calls[0]?.[0])).toContain('E_CONFIG_INVALID');
  });

  it('E_CONFIG_VERSION_UNSUPPORTED on a newer schema version', () => {
    writeFileSync(cfgPath, JSON.stringify({ version: 2, accounts: {} }));
    const { stderr } = spyExit();
    expect(() => loadConfigFile(cfgPath)).toThrow('exit-called');
    expect(String(stderr.mock.calls[0]?.[0])).toContain('E_CONFIG_VERSION_UNSUPPORTED');
  });
});

describe('mutateConfigFile', () => {
  it('applies the mutation to the latest on-disk state, atomically', () => {
    writeFileSync(cfgPath, JSON.stringify({ version: 1, accounts: { a: { email: 'a@x.com' } } }));
    mutateConfigFile((c) => {
      c.accounts = { ...c.accounts, b: { email: 'b@x.com' } };
      return c;
    }, cfgPath);
    const after = loadConfigFile(cfgPath);
    expect(Object.keys(after?.accounts ?? {})).toEqual(['a', 'b']);
    if (process.platform !== 'win32') expect(statSync(cfgPath).mode & 0o777).toBe(0o600);
  });
});

const procStart = (pid: number | 'self') => {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
};

describe('fs-atomic', () => {
  it('atomicWriteWithLock writes content with 0600 and leaves no droppings', () => {
    const p = path.join(base, 'x.json');
    atomicWriteWithLock(p, 'hello');
    expect(readFileSync(p, 'utf8')).toBe('hello');
    if (process.platform !== 'win32') expect(statSync(p).mode & 0o777).toBe(0o600);
    const leftovers = [
      ...['.x.json.lock'],
    ].filter((f) => existsSync(path.join(base, f)));
    expect(leftovers).toEqual([]);
  });

  it('recovers a corrupt (non-PID) lock file instead of timing out', () => {
    const p = path.join(base, 'y.json');
    writeFileSync(path.join(base, '.y.json.lock'), 'garbage');
    let ran = false;
    withFileLock(p, () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  const SELF_ID = (() => {
    try {
      if (readlinkSync('/proc/self') !== String(process.pid)) throw new Error('foreign /proc');
      const ns = /^pid:\[(\d+)\]$/.exec(readlinkSync('/proc/self/ns/pid'))![1];
      const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').replace(/[^0-9a-f]/g, '').slice(0, 8);
      return { ns, start: procStart('self'), boot };
    } catch {
      return { ns: 'host', start: '0', boot: '0' };
    }
  })();
  const VERIFIED = SELF_ID.ns !== 'host';
  const OTHER_NS = SELF_ID.ns === 'host' ? '4026531836' : String(Number(SELF_ID.ns) + 1);
  const OTHER_BOOT = SELF_ID.boot === 'deadbeef' ? 'feedface' : 'deadbeef';
  const lockOf = (p: string) => path.join(path.dirname(p), `.${path.basename(p)}.lock`);
  const droppings = (p: string) => readdirSync(base).filter((n) => n.startsWith(path.basename(lockOf(p))));
  const absentPid = () => {
    for (let pid = 4_194_303; pid > 1; pid--) {
      try {
        process.kill(pid, 0);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ESRCH') return pid;
      }
    }
    throw new Error('no free pid');
  };
  type Identity = { ns: string; start: string; boot: string };
  // A lock another holder left behind: the bare-pid body, plus (for a writer
  // that names its process instance) the owner file still linked to it.
  const plantLock = (p: string, o: { pid: number; id?: Identity; mtimeMs: number }) => {
    const lock = lockOf(p);
    writeFileSync(lock, String(o.pid), { mode: 0o600 });
    if (o.id) linkSync(lock, `${lock}.${o.pid}.${o.id.ns}.${o.id.start}.${o.id.boot}.${'ab'.repeat(6)}.owner`);
    utimesSync(lock, new Date(o.mtimeMs), new Date(o.mtimeMs));
    return lock;
  };
  // Each Date.now() call advances 6 s: the 5 s timeout fires on the first
  // wait, while the lock's age is still measured against the clock.
  const fastClock = (from = Date.now()) => {
    let t = from;
    vi.spyOn(Date, 'now').mockImplementation(() => (t += 6_000));
  };
  const expectKept = (p: string, lock: string, pid: number, clockFrom?: number) => {
    fastClock(clockFrom);
    let ran = false;
    expect(() => withFileLock(p, () => void (ran = true))).toThrow(/Timed out waiting/);
    expect(ran).toBe(false);
    expect(readFileSync(lock, 'utf8')).toBe(String(pid));
  };
  const expectBroken = (p: string) => {
    let ran = false;
    withFileLock(p, () => void (ran = true));
    expect(ran).toBe(true);
    expect(droppings(p)).toEqual([]);
  };
  const clearLock = (p: string) => {
    for (const n of droppings(p)) rmSync(path.join(base, n));
  };

  it('while held, the owner file is linked to the lock and names this process instance; after release, and after a throw in fn, both are gone', () => {
    const p = path.join(base, 'h.json');
    withFileLock(p, () => {
      const owners = droppings(p).filter((n) => n.endsWith('.owner'));
      expect(owners).toHaveLength(1);
      const { ns, start, boot } = SELF_ID;
      expect(owners[0]).toMatch(new RegExp(`^\\.h\\.json\\.lock\\.${process.pid}\\.${ns}\\.${start}\\.${boot}\\.[0-9a-f]{12}\\.owner$`));
      expect(statSync(path.join(base, owners[0])).ino).toBe(statSync(lockOf(p)).ino);
      expect(readFileSync(lockOf(p), 'utf8')).toBe(String(process.pid));
    });
    expect(droppings(p)).toEqual([]);
    expect(() =>
      withFileLock(p, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(droppings(p)).toEqual([]);
  });

  describe.runIf(VERIFIED)('a holder in this namespace and boot is checked by pid and start time', () => {
    it('breaks a lock whose pid now belongs to another process, as after a container restart that reuses the namespace id and the pid', () => {
      const p = path.join(base, 'a.json');
      plantLock(p, { pid: process.ppid, id: { ...SELF_ID, start: '1' }, mtimeMs: Date.now() });
      fastClock();
      expectBroken(p);
    });

    it('breaks a lock naming this pid from an earlier process', () => {
      const p = path.join(base, 'a.json');
      plantLock(p, { pid: process.pid, id: { ...SELF_ID, start: '1' }, mtimeMs: Date.now() });
      fastClock();
      expectBroken(p);
    });

    it('keeps a lock this very process holds, however old', () => {
      const p = path.join(base, 'a.json');
      expectKept(p, plantLock(p, { pid: process.pid, id: SELF_ID, mtimeMs: Date.now() - 120_000 }), process.pid);
    });

    it('does not break a live holder whose lock reuses the dead lock\'s inode: the owner file names the holder', () => {
      const p = path.join(base, 'a.json');
      const lock = plantLock(p, { pid: process.pid, id: { ...SELF_ID, start: '1' }, mtimeMs: Date.now() });
      const deadOwner = droppings(p).find((n) => n.endsWith('.owner'))!;
      const liveOwner = `${path.basename(lock)}.${process.pid}.${SELF_ID.ns}.${SELF_ID.start}.${SELF_ID.boot}.${'ef'.repeat(6)}.owner`;
      const realWrite = fs.writeFileSync.bind(fs);
      vi.spyOn(fs, 'writeFileSync').mockImplementation(((target: string, ...rest: unknown[]) => {
        // Between the waiter's judgement and its break, this process broke the
        // dead lock itself and took a new one that got the same inode.
        if (String(target).endsWith('.break') && existsSync(path.join(base, deadOwner))) {
          linkSync(lock, path.join(base, liveOwner));
          rmSync(path.join(base, deadOwner));
        }
        return (realWrite as (...a: unknown[]) => void)(target, ...rest);
      }) as unknown as typeof fs.writeFileSync);
      fastClock();
      let ran = false;
      expect(() => withFileLock(p, () => void (ran = true))).toThrow(/Timed out waiting/);
      expect(ran).toBe(false);
      expect(existsSync(lock)).toBe(true);
      expect(existsSync(path.join(base, liveOwner))).toBe(true);
    });

    it('with a /proc that belongs to another PID namespace, the owner file still names the namespace and boot', () => {
      const p = path.join(base, 'h.json');
      const realReadlink = fs.readlinkSync.bind(fs);
      vi.spyOn(fs, 'readlinkSync').mockImplementation(((target: string, options?: never) =>
        target === '/proc/self' ? '999999' : realReadlink(target, options)) as unknown as typeof fs.readlinkSync);
      try {
        __setLockIdentityForTest();
        withFileLock(p, () => {
          const { ns, boot } = SELF_ID;
          expect(droppings(p).find((n) => n.endsWith('.owner'))).toMatch(new RegExp(`\\.${process.pid}\\.${ns}\\.0\\.${boot}\\.[0-9a-f]{12}\\.owner$`));
        });
      } finally {
        vi.restoreAllMocks();
        __setLockIdentityForTest();
      }
    });

    it('a holder that recorded no start time is judged by the probe and the lease', () => {
      const p = path.join(base, 'a.json');
      expectKept(p, plantLock(p, { pid: process.ppid, id: { ...SELF_ID, start: '0' }, mtimeMs: Date.now() - 30_000 }), process.ppid);
      vi.restoreAllMocks();
      clearLock(p);
      plantLock(p, { pid: process.ppid, id: { ...SELF_ID, start: '0' }, mtimeMs: Date.now() - 61_000 });
      expectBroken(p);
    });

    for (const [part, unknown] of [['start time', { start: '0' }], ['boot id', { boot: '0' }], ['namespace', { ns: 'host' }]] as const) {
      it(`a waiter that cannot read its own ${part} uses the probe, the own-pid rule and the lease`, () => {
        const self = { ...SELF_ID, ...unknown };
        __setLockIdentityForTest(self);
        try {
          const p = path.join(base, 'a.json');
          // Would read as alive by start time: this pid, this very start tick.
          plantLock(p, { pid: process.pid, id: { ...self, start: SELF_ID.start }, mtimeMs: performance.timeOrigin - 10_000 });
          fastClock();
          expectBroken(p);
          vi.restoreAllMocks();
          expectKept(p, plantLock(p, { pid: process.ppid, id: { ...self, start: procStart(process.ppid) }, mtimeMs: Date.now() - 30_000 }), process.ppid);
        } finally {
          __setLockIdentityForTest();
        }
      });
    }

    it('keeps a lock another live process holds, however old; breaks one whose pid is gone', () => {
      const p = path.join(base, 'a.json');
      expectKept(p, plantLock(p, { pid: process.ppid, id: { ...SELF_ID, start: procStart(process.ppid) }, mtimeMs: Date.now() - 120_000 }), process.ppid);
      vi.restoreAllMocks();
      clearLock(p);
      plantLock(p, { pid: absentPid(), id: SELF_ID, mtimeMs: Date.now() });
      expectBroken(p);
    });
  });

  describe('without /proc, a holder is checked by the pid probe and the lease', () => {
    const HOST = { ns: 'host', start: '0', boot: '0' };
    beforeEach(() => __setLockIdentityForTest(HOST));
    afterEach(() => __setLockIdentityForTest());

    it('the owner file names no namespace, start time or boot', () => {
      const p = path.join(base, 'h.json');
      withFileLock(p, () => {
        expect(droppings(p).filter((n) => n.endsWith('.owner'))[0]).toMatch(new RegExp(`^\\.h\\.json\\.lock\\.${process.pid}\\.host\\.0\\.0\\.[0-9a-f]{12}\\.owner$`));
      });
    });

    it('breaks a lock naming this pid that was written before this process started, and keeps one written since', () => {
      const p = path.join(base, 'a.json');
      plantLock(p, { pid: process.pid, id: HOST, mtimeMs: performance.timeOrigin - 10_000 });
      fastClock();
      expectBroken(p);
      vi.restoreAllMocks();
      expectKept(p, plantLock(p, { pid: process.pid, id: HOST, mtimeMs: Date.now() }), process.pid);
    });

    it('keeps another live pid inside the lease, breaks it after, and breaks a gone pid at once', () => {
      const p = path.join(base, 'a.json');
      expectKept(p, plantLock(p, { pid: process.ppid, id: HOST, mtimeMs: Date.now() - 30_000 }), process.ppid);
      vi.restoreAllMocks();
      clearLock(p);
      plantLock(p, { pid: process.ppid, id: HOST, mtimeMs: Date.now() - 61_000 });
      expectBroken(p);
      plantLock(p, { pid: absentPid(), id: HOST, mtimeMs: Date.now() });
      expectBroken(p);
    });
  });

  it('keeps a lock from another namespace that names this pid and predates this process, inside the lease', () => {
    const p = path.join(base, 'a.json');
    const mtimeMs = performance.timeOrigin - 10_000;
    expectKept(p, plantLock(p, { pid: process.pid, id: { ...SELF_ID, ns: OTHER_NS }, mtimeMs }), process.pid, mtimeMs + 30_000);
  });

  it('keeps a lock from another namespace that names a pid absent here, inside the lease', () => {
    const p = path.join(base, 'a.json');
    const pid = absentPid();
    expectKept(p, plantLock(p, { pid, id: { ...SELF_ID, ns: OTHER_NS }, mtimeMs: Date.now() - 30_000 }), pid);
  });

  it('breaks a lock from another namespace older than the lease, and removes its owner file', () => {
    const p = path.join(base, 'a.json');
    plantLock(p, { pid: process.pid, id: { ...SELF_ID, ns: OTHER_NS }, mtimeMs: Date.now() - 61_000 });
    expectBroken(p);
  });

  it('judges a lock from another boot by the lease alone', () => {
    const p = path.join(base, 'a.json');
    const id = { ...SELF_ID, boot: OTHER_BOOT };
    expectKept(p, plantLock(p, { pid: process.pid, id, mtimeMs: Date.now() - 30_000 }), process.pid);
    vi.restoreAllMocks();
    clearLock(p);
    plantLock(p, { pid: process.pid, id, mtimeMs: Date.now() - 61_000 });
    expectBroken(p);
  });

  it('a lock without an owner file keeps today\'s behavior: another live pid is kept inside the lease; one older than the lease is broken', () => {
    const p = path.join(base, 'a.json');
    expectKept(p, plantLock(p, { pid: process.ppid, mtimeMs: Date.now() - 30_000 }), process.ppid);
    vi.restoreAllMocks();
    plantLock(p, { pid: process.ppid, mtimeMs: Date.now() - 61_000 });
    expectBroken(p);
    plantLock(p, { pid: absentPid(), mtimeMs: Date.now() });
    expectBroken(p);
  });

  it('an owner file that is not linked to the lock does not describe it', () => {
    const p = path.join(base, 'a.json');
    const pid = absentPid();
    writeFileSync(`${lockOf(p)}.${pid}.${OTHER_NS}.1.${OTHER_BOOT}.${'cd'.repeat(6)}.owner`, String(pid));
    plantLock(p, { pid, mtimeMs: Date.now() });
    fastClock();
    let ran = false;
    withFileLock(p, () => void (ran = true));
    expect(ran).toBe(true);
  });

  it('a lock without an owner file is broken only if its mtime is unchanged under the breaker', () => {
    const p = path.join(base, 'a.json');
    const lock = plantLock(p, { pid: process.ppid, mtimeMs: Date.now() - 61_000 });
    const realWrite = fs.writeFileSync.bind(fs);
    let swapped = false;
    vi.spyOn(fs, 'writeFileSync').mockImplementation(((target: string, ...rest: unknown[]) => {
      // Between the judgement and the break, a new holder (same pid body,
      // same freed inode) took the lock.
      if (String(target).endsWith('.break') && !swapped) {
        swapped = true;
        utimesSync(lock, new Date(), new Date());
      }
      return (realWrite as (...a: unknown[]) => void)(target, ...rest);
    }) as unknown as typeof fs.writeFileSync);
    fastClock();
    let ran = false;
    expect(() => withFileLock(p, () => void (ran = true))).toThrow(/Timed out waiting/);
    expect(swapped).toBe(true);
    expect(ran).toBe(false);
    expect(existsSync(lock)).toBe(true);
  });

  it('a holder whose lock was broken does not remove its successor\'s lock on release', () => {
    const p = path.join(base, 'a.json');
    withFileLock(p, () => {
      clearLock(p);
      writeFileSync(lockOf(p), '4242');
    });
    expect(readFileSync(lockOf(p), 'utf8')).toBe('4242');
    expect(droppings(p)).toEqual([path.basename(lockOf(p))]);
  });

  it('on a filesystem that gives each name of a file its own inode number, the lock is still released', () => {
    const realLstat = fs.lstatSync.bind(fs);
    vi.spyOn(fs, 'lstatSync').mockImplementation(((target: string, options?: { bigint?: boolean }) => {
      const st = realLstat(target, options as never) as fs.BigIntStats;
      if (!String(target).endsWith('.owner') || typeof st?.ino !== 'bigint') return st;
      return Object.assign(Object.create(Object.getPrototypeOf(st) as object) as fs.BigIntStats, st, { ino: st.ino + 1n });
    }) as unknown as typeof fs.lstatSync);
    fastClock();
    const p = path.join(base, 'a.json');
    let runs = 0;
    withFileLock(p, () => void runs++);
    withFileLock(p, () => void runs++);
    expect(runs).toBe(2);
    expect(droppings(p)).toEqual([]);
  });

  it('one waiter at a time breaks a dead lock: a fresh breaker file holds the others off, a stale one is cleared', () => {
    const p = path.join(base, 'a.json');
    const breaker = `${lockOf(p)}.break`;
    const pid = absentPid();
    const lock = plantLock(p, { pid, mtimeMs: Date.now() });
    writeFileSync(breaker, '1');
    // The first reading sets the deadline; every later one is 5 s on, at
    // the breaker's own mtime, so the breaker is fresh when the wait times out.
    const at = statSync(breaker).mtimeMs;
    let first = true;
    vi.spyOn(Date, 'now').mockImplementation(() => (first ? ((first = false), at - 5_000) : at));
    let ran = false;
    expect(() => withFileLock(p, () => void (ran = true))).toThrow(/Timed out waiting/);
    expect(ran).toBe(false);
    expect(readFileSync(lock, 'utf8')).toBe(String(pid));
    expect(existsSync(breaker)).toBe(true);
    vi.restoreAllMocks();
    utimesSync(breaker, new Date(Date.now() - 10_000), new Date(Date.now() - 10_000));
    expectBroken(p);
  });

  it('a breaker file dated in the future, or not a regular file, is cleared', () => {
    const p = path.join(base, 'a.json');
    const breaker = `${lockOf(p)}.break`;
    plantLock(p, { pid: absentPid(), mtimeMs: Date.now() });
    writeFileSync(breaker, '1');
    utimesSync(breaker, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
    expectBroken(p);
    if (process.platform === 'win32') return;
    plantLock(p, { pid: absentPid(), mtimeMs: Date.now() });
    symlinkSync(path.join(base, 'nowhere'), breaker);
    // At once, not once the symlink itself is 2 s old.
    const t0 = performance.now();
    expectBroken(p);
    expect(performance.now() - t0).toBeLessThan(1_000);
  });

  it('a breaker removes only its own breaker file', () => {
    const p = path.join(base, 'a.json');
    const breaker = `${lockOf(p)}.break`;
    plantLock(p, { pid: absentPid(), mtimeMs: Date.now() });
    const realRm = fs.rmSync.bind(fs);
    vi.spyOn(fs, 'rmSync').mockImplementation(((target: string, options?: object) => {
      // Another waiter clears this breaker as stale and starts its own.
      if (target === lockOf(p) && existsSync(breaker) && readFileSync(breaker, 'utf8') !== 'other') {
        realRm(breaker);
        writeFileSync(breaker, 'other');
      }
      return realRm(target, options as never);
    }) as unknown as typeof fs.rmSync);
    let ran = false;
    withFileLock(p, () => void (ran = true));
    expect(ran).toBe(true);
    expect(readFileSync(breaker, 'utf8')).toBe('other');
  });

  it.skipIf(process.platform === 'win32')('a dangling symlink at the lock path is broken, not spun on', () => {
    const p = path.join(base, 'a.json');
    symlinkSync(path.join(base, 'nowhere'), lockOf(p));
    fastClock();
    expectBroken(p);
  });
});

describe('reload safety (dispatch path must never exit)', () => {
  it("onInvalid 'throw' raises ConfigFileError instead of exiting on a corrupt file", () => {
    writeFileSync(cfgPath, '{mid-edit');
    const exit = vi.spyOn(process, 'exit');
    expect(() => resolveAccounts({} as NodeJS.ProcessEnv, cfgPath, 'throw')).toThrow(ConfigFileError);
    expect(exit).not.toHaveBeenCalled();
  });

  it("onInvalid 'throw' raises on a deleted/empty registry instead of exiting", () => {
    const exit = vi.spyOn(process, 'exit');
    expect(() => resolveAccounts({} as NodeJS.ProcessEnv, cfgPath, 'throw')).toThrow(
      /E_NO_ACCOUNTS_CONFIGURED/,
    );
    expect(exit).not.toHaveBeenCalled();
  });
});

describe('runMigrateConfig', () => {
  it('synthesizes accounts{} with the admin fold and is idempotent', () => {
    const env = {
      GOOGLE_ACCOUNTS: 'work:w@x.com,ops:o@x.com',
      GOOGLE_ADMIN_ACCOUNTS: 'ops',
      XDG_CONFIG_HOME: base,
    } as NodeJS.ProcessEnv;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    runMigrateConfig(env);
    const p = path.join(base, 'mcp-google-multi', 'config.json');
    const cfg = JSON.parse(readFileSync(p, 'utf8'));
    expect(cfg.accounts).toEqual({ work: { email: 'w@x.com' }, ops: { email: 'o@x.com', admin: true } });
    expect(env.GOOGLE_ACCOUNTS).toBe('work:w@x.com,ops:o@x.com');
    log.mockClear();
    runMigrateConfig(env);
    expect(log.mock.calls.some((c) => String(c[0]).includes('nothing to do'))).toBe(true);
  });

  it('preserves file-only fields for retained aliases (merge, not replace)', () => {
    const dir = path.join(base, 'mcp-google-multi');
    const p = path.join(dir, 'config.json');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      p,
      JSON.stringify({ version: 1, accounts: { work: { email: 'w@x.com', scopeProfile: 'custom', admin: true } } }),
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    runMigrateConfig({ GOOGLE_ACCOUNTS: 'work:w@x.com', XDG_CONFIG_HOME: base } as NodeJS.ProcessEnv);
    const cfg = JSON.parse(readFileSync(p, 'utf8'));
    expect(cfg.accounts.work).toEqual({ email: 'w@x.com', scopeProfile: 'custom', admin: true });
    expect(log.mock.calls.some((c) => String(c[0]).includes('nothing to do'))).toBe(true);
  });

  it('does nothing without GOOGLE_ACCOUNTS', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    runMigrateConfig({ XDG_CONFIG_HOME: base } as NodeJS.ProcessEnv);
    expect(existsSync(path.join(base, 'mcp-google-multi', 'config.json'))).toBe(false);
    expect(log.mock.calls.some((c) => String(c[0]).includes('nothing to migrate'))).toBe(true);
  });
});
