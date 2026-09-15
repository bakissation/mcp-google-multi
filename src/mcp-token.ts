// B13 token model (oauth-authorization-server.md §Data model): the MCP access
// token (HS256 JWT, jose-only — AS==RS so no JWKS), the signed self-contained
// `state` and authorization code, the in-memory single-use replay guard, and
// the opaque rotated refresh-token store. Keyed by the provisioned MCP_JWT_KEY
// (B5), so tokens survive a restart as long as the key persists.

import { randomBytes } from 'node:crypto';
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
}

export async function signAccessToken(p: AccessTokenParams): Promise<string> {
  const ttl = p.ttlSec ?? ACCESS_TTL_DEFAULT;
  return new SignJWT({ scope: 'mcp:use', purpose: 'mcp_access' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(p.base)
    .setSubject('owner')
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
  return { sub: String(payload.sub), scope: String(payload.scope ?? ''), jti: String(payload.jti ?? '') };
}

// --- Signed state + authorization code (self-contained artifacts) -----------

export interface StatePayload {
  flow: 'owner_gate' | 'alias_reauth';
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  client_state?: string;
  resource: string;
  alias?: string;
}

export interface CodePayload {
  redirect_uri: string;
  code_challenge: string;
  resource: string;
  sub: 'owner';
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
  sub: 'owner';
  issuedAt: number;
  family: string;
}

const SPENT_CAP = 2000;

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
    if (!existsSync(this.path)) return { active: {}, spent: {} };
    try {
      const d = decryptToken(readFileSync(this.path, 'utf-8'), this.masterKey) as unknown as Partial<RefreshData>;
      return { active: d.active ?? {}, spent: d.spent ?? {} };
    } catch {
      return { active: {}, spent: {} };
    }
  }

  private save(data: RefreshData): void {
    // bound the spent set (drop oldest-inserted) so it can't grow forever.
    const keys = Object.keys(data.spent);
    if (keys.length > SPENT_CAP) {
      for (const k of keys.slice(0, keys.length - SPENT_CAP)) delete data.spent[k];
    }
    atomicWriteFileSync(this.path, encryptToken(data, this.masterKey), 0o600);
  }

  issue(nowMs: number, family?: string): string {
    return withFileLock(this.path, () => {
      const token = randomBytes(32).toString('base64url');
      const data = this.load();
      data.active[token] = { sub: 'owner', issuedAt: nowMs, family: family ?? randomBytes(12).toString('hex') };
      this.save(data);
      return token;
    });
  }

  /** Rotate a presented refresh token; null if unknown OR if the presented
   * token was already rotated away (reuse => the family is revoked). */
  rotate(oldToken: string, nowMs: number): string | null {
    return withFileLock(this.path, () => {
      const data = this.load();
      const rec = data.active[oldToken];
      if (!rec) {
        // Reuse of a rotated-away token signals theft: revoke the whole family.
        const fam = data.spent[oldToken];
        if (fam) {
          for (const [t, r] of Object.entries(data.active)) if (r.family === fam) delete data.active[t];
          this.save(data);
        }
        return null;
      }
      delete data.active[oldToken];
      data.spent[oldToken] = rec.family;
      const next = randomBytes(32).toString('base64url');
      data.active[next] = { sub: 'owner', issuedAt: nowMs, family: rec.family };
      this.save(data);
      return next;
    });
  }
}
