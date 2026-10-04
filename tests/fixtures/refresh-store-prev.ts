// The RefreshStore of the release before generation-counted families
// (dev after the own-key fix), vendored verbatim below the imports for the
// downgrade round trip in tests/mcp-token.test.ts. Do not edit the class.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { encryptToken, decryptToken } from '../../src/token-store.js';
import { atomicWriteFileSync, withFileLock } from '../../src/fs-atomic.js';

export interface RefreshRecord {
  sub: string;
  issuedAt: number;
  family: string;
}

const SPENT_CAP = 2000;

function ownEntries(o: unknown): [string, unknown][] {
  // An own `__proto__` key (JSON.parse makes one) would set the prototype when copied.
  return o !== null && typeof o === 'object' && !Array.isArray(o) ? Object.entries(o).filter(([k]) => k !== '__proto__') : [];
}

function isLegacyRecord(r: unknown): r is RefreshRecord {
  if (r === null || typeof r !== 'object') return false;
  const x = r as Record<string, unknown>;
  return typeof x.sub === 'string' && x.sub !== '' && typeof x.family === 'string' && typeof x.issuedAt === 'number' && Number.isFinite(x.issuedAt);
}

interface RefreshData {
  active: Record<string, RefreshRecord>;
  /** rotated-away token -> family, for reuse detection (OAuth 2.1 §4.14). */
  spent: Record<string, string>;
}

/**
 * Persisted (encrypted under MASTER_KEY) opaque refresh-token store. Rotates on
 * every use (a stolen token is usable at most once), and detects REUSE of a
 * rotated-away token as theft: the whole token family is revoked (#7 / C14).
 * All read-modify-write goes through a file lock so concurrent stdio+HTTP
 * processes can't lost-update or double-spend (#12).
 */
export class RefreshStore {
  constructor(
    private readonly path: string,
    private readonly masterKey: string,
  ) {}

  private load(): RefreshData {
    const data: RefreshData = { active: {}, spent: {} };
    if (!existsSync(this.path)) return data;
    let d: Partial<Record<keyof RefreshData, unknown>>;
    try {
      d = decryptToken(readFileSync(this.path, 'utf-8'), this.masterKey) as unknown as typeof d;
    } catch {
      return data;
    }
    // Only well-formed own entries survive, so no lookup can land on an
    // inherited key or a record without a subject.
    for (const [t, r] of ownEntries(d?.active)) {
      if (isLegacyRecord(r)) data.active[t] = { sub: r.sub, issuedAt: r.issuedAt, family: r.family };
    }
    for (const [t, fam] of ownEntries(d?.spent)) if (typeof fam === 'string') data.spent[t] = fam;
    return data;
  }

  private save(data: RefreshData): void {
    // A family with no active token has nothing left to revoke. Over the cap,
    // the subject holding the most spent tokens loses its oldest (ties: the
    // oldest entry), so a subject's rotations, across all its families, only
    // push out its own history (docs/internals.md). Insertion order = rotation
    // order.
    const owner = new Map<string, string>();
    for (const r of Object.values(data.active)) owner.set(r.family, r.sub);
    const order = Object.keys(data.spent);
    const held = new Map<string, { at: number[]; head: number }>();
    let total = 0;
    order.forEach((t, i) => {
      const sub = owner.get(data.spent[t]);
      if (sub === undefined) {
        delete data.spent[t];
        return;
      }
      const h = held.get(sub);
      if (h) h.at.push(i);
      else held.set(sub, { at: [i], head: 0 });
      total += 1;
    });
    while (total > SPENT_CAP) {
      let most = { at: [] as number[], head: 0 };
      let mostN = 0;
      for (const h of held.values()) {
        const n = h.at.length - h.head;
        if (n > mostN || (n === mostN && n > 0 && h.at[h.head] < most.at[most.head])) {
          most = h;
          mostN = n;
        }
      }
      delete data.spent[order[most.at[most.head++]]];
      total -= 1;
    }
    atomicWriteFileSync(this.path, encryptToken(data, this.masterKey), 0o600);
  }

  issue(nowMs: number, sub: string, family?: string): string {
    return withFileLock(this.path, () => {
      const token = randomBytes(32).toString('base64url');
      const data = this.load();
      data.active[token] = { sub, issuedAt: nowMs, family: family ?? randomBytes(12).toString('hex') };
      this.save(data);
      return token;
    });
  }

  /** Rotate a presented refresh token; null if unknown OR if the presented
   * token was already rotated away (reuse => the family is revoked). The
   * record's sub is copied forward and returned so the caller can mint the
   * matching access token without trusting anything client-supplied.
   *
   * `accept` (optional) is called inside the store lock, before any mutation,
   * with the record's sub. false: every active record of that sub is dropped
   * and null returned. A throw: nothing is mutated and the error propagates,
   * so the presented token stays valid. Absent: unchanged. */
  rotate(oldToken: string, nowMs: number, accept?: (sub: string) => boolean): { token: string; sub: string } | null {
    return withFileLock(this.path, () => {
      const data = this.load();
      const rec = Object.hasOwn(data.active, oldToken) ? data.active[oldToken] : undefined;
      if (!rec) {
        // Reuse of a rotated-away token signals theft: revoke the whole family.
        const fam = Object.hasOwn(data.spent, oldToken) ? data.spent[oldToken] : undefined;
        if (fam) {
          for (const [t, r] of Object.entries(data.active)) if (r.family === fam) delete data.active[t];
          this.save(data);
        }
        return null;
      }
      if (accept && !accept(rec.sub)) {
        for (const [t, r] of Object.entries(data.active)) if (r.sub === rec.sub) delete data.active[t];
        this.save(data);
        return null;
      }
      delete data.active[oldToken];
      data.spent[oldToken] = rec.family;
      const next = randomBytes(32).toString('base64url');
      data.active[next] = { sub: rec.sub, issuedAt: nowMs, family: rec.family };
      this.save(data);
      return { token: next, sub: rec.sub };
    });
  }

  /** Drop every ACTIVE record minted under `sub` (linear scan under the store
   * lock); the save then drops the spent entries of every family left with no
   * active token. Returns the number of active tokens dropped. */
  purgeTenant(sub: string): number {
    return withFileLock(this.path, () => {
      const data = this.load();
      let dropped = 0;
      for (const [t, r] of Object.entries(data.active)) {
        if (r.sub === sub) {
          delete data.active[t];
          dropped += 1;
        }
      }
      if (dropped > 0) this.save(data);
      return dropped;
    });
  }
}
