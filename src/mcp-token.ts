// B13 token model (oauth-authorization-server.md §Data model): the MCP access
// token (HS256 JWT, jose-only — AS==RS so no JWKS), the signed self-contained
// `state` and authorization code, the in-memory single-use replay guard, and
// the opaque rotated refresh-token store. Keyed by the provisioned MCP_JWT_KEY
// (B5), so tokens survive a restart as long as the key persists.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { SignJWT, jwtVerify } from 'jose';
import { deriveKey, encryptToken, decryptToken } from './token-store.js';
import { atomicWriteFileSync, withFileLock } from './fs-atomic.js';

export const ACCESS_TTL_DEFAULT = 600; // seconds
export const STATE_TTL_DEFAULT = 600;
export const CODE_TTL_DEFAULT = 60;
export const REPLAY_CAP_DEFAULT = 10_000;

/** Derive the HS256 secret (32 bytes) from the provisioned MCP_JWT_KEY string. */
export function jwtSecretFrom(jwtKey: string): Uint8Array {
  return new Uint8Array(deriveKey(jwtKey));
}

function newJti(): string {
  return randomBytes(16).toString('base64url');
}

// --- MCP access token -------------------------------------------------------

export interface AccessTokenParams {
  base: string;
  secret: Uint8Array;
  ttlSec?: number;
  iat: number; // unix seconds (injected — never Date.now() in a testable core)
  sub: string; // 'owner' in the single-owner deployment; a tenant id under multi-tenancy
}

export async function signAccessToken(p: AccessTokenParams): Promise<string> {
  if (typeof p.sub !== 'string' || p.sub === '') throw new Error('signAccessToken: sub must be a non-empty string');
  const ttl = p.ttlSec ?? ACCESS_TTL_DEFAULT;
  return new SignJWT({ scope: 'mcp:use', purpose: 'mcp_access' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(p.base)
    .setSubject(p.sub)
    .setAudience(`${p.base}/mcp`)
    .setIssuedAt(p.iat)
    .setExpirationTime(p.iat + ttl)
    .setJti(newJti())
    .sign(p.secret);
}

export interface AccessClaims {
  sub: string;
  scope: string;
  jti: string;
}

/** Verify an access token for `/mcp`. Throws on bad sig / aud / iss / exp. */
export async function verifyAccessToken(token: string, base: string, secret: Uint8Array): Promise<AccessClaims> {
  const { payload } = await jwtVerify(token, secret, { issuer: base, audience: `${base}/mcp` });
  if (payload.purpose !== 'mcp_access') throw new Error('wrong token purpose');
  if (typeof payload.sub !== 'string' || payload.sub === '') throw new Error('access token has no subject');
  return { sub: payload.sub, scope: String(payload.scope ?? ''), jti: String(payload.jti ?? '') };
}

// --- Signed state + authorization code (self-contained artifacts) -----------

export interface StatePayload {
  flow: 'owner_gate' | 'alias_reauth' | 'alias_add';
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  client_state?: string;
  resource: string;
  alias?: string;
  /** alias_add only: the tenant the new alias binds under. Signed server-side
   * at mint time — never caller-supplied at /authorize or /callback. */
  tenantId?: string;
  /** alias_add only: scope bundles chosen when the link was minted. */
  bundles?: string[];
  /** alias_add only: an opaque value the minting caller chose, signed like
   * tenantId and handed back to its binder (e.g. a server-side link record). */
  nonce?: string;
  /** owner_gate only: base64url sha256 of the browser-binding cookie the
   * Google redirect set; /callback refuses a browser that lacks it. */
  bind?: string;
}

export interface CodePayload {
  redirect_uri: string;
  code_challenge: string;
  resource: string;
  sub: string;
}

async function signArtifact(claims: Record<string, unknown>, purpose: string, base: string, secret: Uint8Array, iat: number, ttlSec: number): Promise<string> {
  return new SignJWT({ ...claims, purpose })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(base)
    .setIssuedAt(iat)
    .setExpirationTime(iat + ttlSec)
    .setJti(newJti())
    .sign(secret);
}

async function verifyArtifact(token: string, purpose: string, base: string, secret: Uint8Array): Promise<Record<string, unknown> & { jti: string }> {
  const { payload } = await jwtVerify(token, secret, { issuer: base });
  if (payload.purpose !== purpose) throw new Error(`wrong artifact purpose (${String(payload.purpose)})`);
  return { ...payload, jti: String(payload.jti ?? '') } as Record<string, unknown> & { jti: string };
}

export function signState(payload: StatePayload, base: string, secret: Uint8Array, iat: number, ttlSec = STATE_TTL_DEFAULT): Promise<string> {
  return signArtifact(payload as unknown as Record<string, unknown>, 'mcp_state', base, secret, iat, ttlSec);
}

export async function verifyState(token: string, base: string, secret: Uint8Array): Promise<StatePayload & { jti: string }> {
  return (await verifyArtifact(token, 'mcp_state', base, secret)) as unknown as StatePayload & { jti: string };
}

// --- alias_reauth link -------------------------------------------------------

/** A re-auth link is handed out in a tool error, so it has to survive until
 * the user clicks it; an hour, not the 10-minute state TTL. */
export const REAUTH_LINK_TTL_SEC = 3600;

function reauthMac(base: string, secret: Uint8Array, alias: string, exp: number): Buffer {
  // The newline-separated input can never be a JWT signing input (two
  // base64url segments and one dot), so the shared key stays unambiguous.
  return createHmac('sha256', secret).update(`alias_reauth\n${base}\n${alias}\n${exp}`).digest();
}

/** Query string of a server-issued alias_reauth link: the alias, an expiry and
 * an HMAC over both. Synchronous, so the error hints that carry it stay so. */
export function signReauthLink(base: string, secret: Uint8Array, alias: string, nowSec: number): string {
  const exp = nowSec + REAUTH_LINK_TTL_SEC;
  return `alias=${encodeURIComponent(alias)}&exp=${exp}&sig=${reauthMac(base, secret, alias, exp).toString('base64url')}`;
}

/** The alias a link was issued for, or null when it is missing, forged or expired. */
export function verifyReauthLink(
  base: string,
  secret: Uint8Array,
  params: { alias: string; exp: string; sig: string },
  nowSec: number,
): string | null {
  const exp = Number(params.exp);
  if (!params.alias || !/^\d+$/.test(params.exp) || exp < nowSec) return null;
  const want = reauthMac(base, secret, params.alias, exp);
  const got = Buffer.from(params.sig, 'base64url');
  return got.length === want.length && timingSafeEqual(got, want) ? params.alias : null;
}

/** A pending-authorization artifact for the DCR consent interstitial (same
 * shape as `state`, distinct purpose so the two can't be confused). */
export function signPending(payload: StatePayload, base: string, secret: Uint8Array, iat: number, ttlSec = STATE_TTL_DEFAULT): Promise<string> {
  return signArtifact(payload as unknown as Record<string, unknown>, 'mcp_pending', base, secret, iat, ttlSec);
}

export async function verifyPending(token: string, base: string, secret: Uint8Array): Promise<StatePayload & { jti: string }> {
  return (await verifyArtifact(token, 'mcp_pending', base, secret)) as unknown as StatePayload & { jti: string };
}

export function signAuthzCode(payload: CodePayload, base: string, secret: Uint8Array, iat: number, ttlSec = CODE_TTL_DEFAULT): Promise<string> {
  return signArtifact(payload as unknown as Record<string, unknown>, 'mcp_code', base, secret, iat, ttlSec);
}

export async function verifyAuthzCode(token: string, base: string, secret: Uint8Array): Promise<CodePayload & { jti: string }> {
  return (await verifyArtifact(token, 'mcp_code', base, secret)) as unknown as CodePayload & { jti: string };
}

// --- Replay guard (C10/C17: single-use, capped, TTL-evicted) ----------------

export class ReplayGuard {
  private readonly seen = new Map<string, number>(); // jti -> expiry (ms)

  constructor(private readonly cap = REPLAY_CAP_DEFAULT) {}

  /** Record a jti as spent. Returns false if it was already spent (replay). */
  consume(jti: string, ttlMs: number, nowMs: number): boolean {
    this.evictExpired(nowMs);
    if (this.seen.has(jti)) return false;
    if (this.seen.size >= this.cap) {
      // drop the oldest-inserted entry to bound memory (C17)
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    this.seen.set(jti, nowMs + ttlMs);
    return true;
  }

  get size(): number {
    return this.seen.size;
  }

  private evictExpired(nowMs: number): void {
    for (const [jti, exp] of this.seen) {
      if (exp <= nowMs) this.seen.delete(jti);
    }
  }
}

// --- Opaque refresh tokens (C14: rotated on every use) ----------------------

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
