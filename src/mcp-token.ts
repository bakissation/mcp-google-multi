// B13 token model (oauth-authorization-server.md §Data model): the MCP access
// token (HS256 JWT, jose-only — AS==RS so no JWKS), the signed self-contained
// `state` and authorization code, the in-memory single-use replay guard, and
// the rotated refresh-token store. Keyed by the provisioned MCP_JWT_KEY
// (B5), so tokens survive a restart as long as the key persists.

import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
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

// --- Refresh tokens (C14: rotated on every use; H4 F2: generation-counted) --

/** An earlier release's record, keyed by its live token. */
export interface RefreshRecord {
  sub: string;
  issuedAt: number;
  family: string;
}

/** Store files this release writes; an absent `format` is an earlier release's. */
const REFRESH_FORMAT = 2;

// r1 token: "r1." + base64url(fid 16 || gen uint32 BE || rand 16 || HMAC-SHA256
// of those 36 bytes). The dot is outside the base64url alphabet, so an r1
// token can never be read as an earlier release's 43-character token.
const R1_PREFIX = 'r1.';
const R1_LENGTH = 94;
const R1_BODY = 36;
const R1_BYTES = 68;
const R1_MAC_DOMAIN = Buffer.from('mcp-google-multi refresh r1\n');
const R1_KEY_INFO = 'mcp-google-multi:refresh-mac:v1';
const GEN_MAX = 0xffffffff;
const LEGACY_TOKEN = /^[A-Za-z0-9_-]{43}$/;

interface FamilyRecord {
  sub: string;
  /** Generation of the current token (0 at issue). */
  gen: number;
  /** base64url sha256 of the current token's decoded bytes. */
  cur: string;
  /** ms: sign-in; copied forward on every rotation. */
  createdAt: number;
  /** ms: last issue or rotation. */
  usedAt: number;
  /** The earlier-release family this one continues. */
  legacy?: string;
}

interface RefreshData {
  families: Record<string, FamilyRecord>;
  /** Earlier-release records: token -> record. */
  active: Record<string, RefreshRecord>;
  /** Earlier-release rotated-away token -> family, for reuse detection (OAuth 2.1 §4.14). */
  spent: Record<string, string>;
}

const B64URL = /^[A-Za-z0-9_-]+$/;

const sha256 = (b: Buffer | string): Buffer => createHash('sha256').update(b).digest();

/** A non-secret tag for log lines and rate-limit keys: never the token. */
const familyTag = (family: Buffer | string): string => sha256(family).toString('hex').slice(0, 8);

function refreshMacKey(masterKey: string): Buffer {
  return Buffer.from(hkdfSync('sha256', deriveKey(masterKey), Buffer.alloc(0), R1_KEY_INFO, 32));
}

function r1Mac(key: Buffer, body: Buffer): Buffer {
  return createHmac('sha256', key).update(R1_MAC_DOMAIN).update(body).digest();
}

interface R1Token {
  fidBytes: Buffer;
  fid: string;
  gen: number;
  digest: Buffer;
}

/** A token this key minted, or null. Pure CPU: runs before the file lock. */
function parseR1(t: unknown, key: Buffer): R1Token | null {
  if (typeof t !== 'string' || t.length !== R1_LENGTH || !t.startsWith(R1_PREFIX)) return null;
  const text = t.slice(R1_PREFIX.length);
  const buf = Buffer.from(text, 'base64url');
  // The decoder skips stray characters and ignores the last one's pad bits;
  // re-encoding leaves one spelling per token.
  if (buf.length !== R1_BYTES || buf.toString('base64url') !== text) return null;
  if (!timingSafeEqual(buf.subarray(R1_BODY), r1Mac(key, buf.subarray(0, R1_BODY)))) return null;
  const fidBytes = buf.subarray(0, 16);
  return { fidBytes, fid: fidBytes.toString('base64url'), gen: buf.readUInt32BE(16), digest: sha256(buf) };
}

function mintR1(key: Buffer, fid: Buffer, gen: number): { token: string; cur: string } {
  const body = Buffer.alloc(R1_BODY);
  fid.copy(body, 0);
  body.writeUInt32BE(gen, 16);
  randomBytes(16).copy(body, 20);
  const buf = Buffer.concat([body, r1Mac(key, body)]);
  return { token: R1_PREFIX + buf.toString('base64url'), cur: sha256(buf).toString('base64url') };
}

/**
 * The family tag of a refresh token this `masterKey`'s store minted, or null
 * for anything else. Derives the key once; the returned function does no I/O,
 * so a host can key a pre-auth rate limit on it.
 */
export function refreshFamilyTagger(masterKey: string): (token: string) => string | null {
  const key = refreshMacKey(masterKey);
  return (token) => {
    const p = parseR1(token, key);
    return p ? familyTag(p.fidBytes) : null;
  };
}

function ownEntries(o: unknown): [string, unknown][] {
  // An own `__proto__` key (JSON.parse makes one) would set the prototype when copied.
  return o !== null && typeof o === 'object' && !Array.isArray(o) ? Object.entries(o).filter(([k]) => k !== '__proto__') : [];
}

function isLegacyRecord(r: unknown): r is RefreshRecord {
  if (r === null || typeof r !== 'object') return false;
  const x = r as Record<string, unknown>;
  return typeof x.sub === 'string' && x.sub !== '' && typeof x.family === 'string' && typeof x.issuedAt === 'number' && Number.isFinite(x.issuedAt);
}

function isCanonicalB64(s: string, bytes: number): boolean {
  return B64URL.test(s) && Buffer.from(s, 'base64url').length === bytes && Buffer.from(s, 'base64url').toString('base64url') === s;
}

function isFamilyRecord(key: string, r: unknown): r is FamilyRecord {
  if (r === null || typeof r !== 'object') return false;
  const x = r as Record<string, unknown>;
  return (
    isCanonicalB64(key, 16) &&
    typeof x.sub === 'string' && x.sub !== '' &&
    Number.isInteger(x.gen) && (x.gen as number) >= 0 && (x.gen as number) <= GEN_MAX &&
    typeof x.cur === 'string' && x.cur.length === 43 && isCanonicalB64(x.cur, 32) &&
    Number.isFinite(x.createdAt) && Number.isFinite(x.usedAt) &&
    (x.legacy === undefined || typeof x.legacy === 'string')
  );
}

function formatError(file: string, format: unknown): Error {
  const name = basename(file);
  return new Error(`E_REFRESH_STORE_FORMAT: ${name} was written by a newer release (format ${JSON.stringify(format)}): upgrade, or delete ${name} to sign every MCP client out`);
}

/** The decrypted plaintext, or null when the file is absent. Throws when it
 * does not decrypt; the caller decides what that means. */
function readPlain(file: string, masterKey: string): unknown {
  if (!existsSync(file)) return null;
  return decryptToken(readFileSync(file, 'utf-8'), masterKey);
}

// Outside any decrypt catch: a file from a newer release loaded as empty
// would be erased by the next write.
function checkFormat(file: string, d: unknown): void {
  if (d !== null && typeof d === 'object' && Object.hasOwn(d, 'format') && (d as { format: unknown }).format !== REFRESH_FORMAT) {
    throw formatError(file, (d as { format: unknown }).format);
  }
}

/** Only well-formed own entries survive, so no lookup lands on an inherited
 * key and no malformed record reaches a liveness test or the token codec.
 * `dirty` says something was dropped. */
function decodeData(d: unknown): { data: RefreshData; dirty: boolean } {
  const data: RefreshData = { families: {}, active: {}, spent: {} };
  const x = (d ?? {}) as Record<string, unknown>;
  let dropped = 0;
  for (const [k, f] of ownEntries(x.families)) {
    if (isFamilyRecord(k, f)) {
      data.families[k] = { sub: f.sub, gen: f.gen, cur: f.cur, createdAt: f.createdAt, usedAt: f.usedAt, ...(f.legacy === undefined ? {} : { legacy: f.legacy }) };
    } else dropped += 1;
  }
  for (const [t, r] of ownEntries(x.active)) {
    if (isLegacyRecord(r)) data.active[t] = { sub: r.sub, issuedAt: r.issuedAt, family: r.family };
    else dropped += 1;
  }
  for (const [t, fam] of ownEntries(x.spent)) {
    if (typeof fam === 'string') data.spent[t] = fam;
    else dropped += 1;
  }
  return { data, dirty: dropped > 0 };
}

/** Every session of `sub`, in both formats. */
function dropSub(data: RefreshData, sub: string): number {
  let n = 0;
  for (const [k, f] of Object.entries(data.families)) {
    if (f.sub === sub) {
      delete data.families[k];
      n += 1;
    }
  }
  for (const [t, r] of Object.entries(data.active)) {
    if (r.sub === sub) {
      delete data.active[t];
      n += 1;
    }
  }
  return n;
}

/** Boot check for a refresh store file: returns when it is absent or this
 * release can read it; throws when it does not decrypt under `masterKey`
 * (E_REFRESH_STORE_UNREADABLE) or a newer release wrote it
 * (E_REFRESH_STORE_FORMAT). */
export function assertRefreshStoreReadable(file: string, masterKey: string): void {
  let d: unknown;
  try {
    d = readPlain(file, masterKey);
  } catch (e) {
    throw new Error(`E_REFRESH_STORE_UNREADABLE: ${basename(file)} does not decrypt with this MASTER_KEY`, { cause: e });
  }
  checkFormat(file, d);
}

export interface RefreshStoreOptions {
  /** Server-side log for a revoked or dropped family. Never given a token or a subject. */
  log?: (line: string) => void;
}

/**
 * Persisted (encrypted under MASTER_KEY) refresh-token store. Rotates on every
 * use, and a token carries its family and generation under a MAC, so
 * presenting any generation the family has rotated past is REUSE: the family
 * is revoked for the rest of its life (#7 / C14, H4 F2). The store keeps one
 * record per family, whatever its rotation count. Every read-modify-write goes
 * through a file lock so concurrent stdio+HTTP processes can't lost-update or
 * double-spend (#12). See docs/internals.md.
 */
export class RefreshStore {
  private readonly log: (line: string) => void;
  private macKey: Buffer | undefined;
  // Set once a load finds no earlier-release record. Nothing here adds one,
  // so from then on a legacy-shaped token is refused before the lock.
  private legacyEmpty = false;

  constructor(
    private readonly path: string,
    private readonly masterKey: string,
    options: RefreshStoreOptions = {},
  ) {
    this.log = options.log ?? (() => undefined);
  }

  private key(): Buffer {
    return (this.macKey ??= refreshMacKey(this.masterKey));
  }

  private load(): { data: RefreshData; dirty: boolean } {
    let d: unknown;
    try {
      d = readPlain(this.path, this.masterKey);
    } catch {
      d = null;
    }
    checkFormat(this.path, d);
    const loaded = decodeData(d);
    if (Object.keys(loaded.data.active).length === 0 && Object.keys(loaded.data.spent).length === 0) this.legacyEmpty = true;
    return loaded;
  }

  private save(data: RefreshData): void {
    // Earlier-release evidence matters only while its family lives on, as a
    // legacy record or as the family it migrated into.
    const live = new Set<string>();
    for (const r of Object.values(data.active)) live.add(r.family);
    for (const f of Object.values(data.families)) if (f.legacy !== undefined) live.add(f.legacy);
    for (const [t, fam] of Object.entries(data.spent)) if (!live.has(fam)) delete data.spent[t];
    atomicWriteFileSync(this.path, encryptToken({ format: REFRESH_FORMAT, families: data.families, active: data.active, spent: data.spent }, this.masterKey), 0o600);
  }

  // After the write, so a failed save or a throwing accept logs nothing.
  private emit(lines: string[]): void {
    for (const line of lines) {
      try {
        this.log(line);
      } catch {
        // The rotation is already on disk; a log sink must not lose its token.
      }
    }
  }

  private newFamilyId(data: RefreshData): Buffer {
    let fid: Buffer;
    do fid = randomBytes(16);
    while (Object.hasOwn(data.families, fid.toString('base64url')));
    return fid;
  }

  issue(nowMs: number, sub: string): string {
    if (typeof sub !== 'string' || sub === '') throw new Error('RefreshStore.issue: sub must be a non-empty string');
    const key = this.key();
    return withFileLock(this.path, () => {
      const { data } = this.load();
      const fid = this.newFamilyId(data);
      const { token, cur } = mintR1(key, fid, 0);
      data.families[fid.toString('base64url')] = { sub, gen: 0, cur, createdAt: nowMs, usedAt: nowMs };
      this.save(data);
      return token;
    });
  }

  /** Rotate a presented refresh token; null if it is unknown, malformed, or
   * rotated away (reuse => the family is revoked). The record's sub is copied
   * forward and returned so the caller can mint the matching access token
   * without trusting anything client-supplied.
   *
   * `accept` (optional) is called inside the store lock, before any mutation,
   * with the record's sub. false: every session of that sub is dropped and
   * null returned. A throw: nothing is written and the error propagates, so
   * the presented token stays valid. Absent: unchanged. */
  rotate(oldToken: string, nowMs: number, accept?: (sub: string) => boolean): { token: string; sub: string } | null {
    const key = this.key();
    const r1 = parseR1(oldToken, key);
    if (!r1 && !(typeof oldToken === 'string' && LEGACY_TOKEN.test(oldToken) && !this.legacyEmpty)) return null;
    return withFileLock(this.path, () => {
      const { data, dirty } = this.load();
      const lines: string[] = [];
      const done = <T>(result: T, write: boolean): T => {
        if (write) this.save(data);
        this.emit(lines);
        return result;
      };
      const refuse = (sub: string): null => {
        lines.push(`refresh sessions dropped: accept n=${dropSub(data, sub)}`);
        return done(null, true);
      };

      if (r1) {
        const f = Object.hasOwn(data.families, r1.fid) ? data.families[r1.fid] : undefined;
        if (!f) return done(null, dirty);
        const drop = (why: 'reuse' | 'ahead' | 'mismatch' | 'overflow'): null => {
          delete data.families[r1.fid];
          lines.push(`refresh family ${why === 'reuse' ? 'revoked' : 'dropped'}: ${why} tag=${familyTag(r1.fidBytes)}`);
          return done(null, true);
        };
        // Older: a rotated-away token, and the MAC proves this server minted it.
        if (r1.gen < f.gen) return drop('reuse');
        // Newer, or the same generation with another random part: the store
        // lost a write the client saw. Not evidence of theft.
        if (r1.gen > f.gen) return drop('ahead');
        if (!timingSafeEqual(r1.digest, Buffer.from(f.cur, 'base64url'))) return drop('mismatch');
        if (accept && !accept(f.sub)) return refuse(f.sub);
        if (f.gen === GEN_MAX) return drop('overflow');
        const next = mintR1(key, r1.fidBytes, f.gen + 1);
        f.gen += 1;
        f.cur = next.cur;
        f.usedAt = nowMs;
        return done({ token: next.token, sub: f.sub }, true);
      }

      const rec = Object.hasOwn(data.active, oldToken) ? data.active[oldToken] : undefined;
      if (!rec) {
        const fam = Object.hasOwn(data.spent, oldToken) ? data.spent[oldToken] : undefined;
        if (fam === undefined) return done(null, dirty);
        // Reuse of an earlier-release rotated-away token: revoke the family in
        // both formats.
        for (const [t, r] of Object.entries(data.active)) if (r.family === fam) delete data.active[t];
        for (const [k, f] of Object.entries(data.families)) if (f.legacy === fam) delete data.families[k];
        lines.push(`refresh family revoked: reuse tag=${familyTag(fam)}`);
        return done(null, true);
      }
      if (accept && !accept(rec.sub)) return refuse(rec.sub);
      // Migrate: the presented token stays behind as reuse evidence.
      delete data.active[oldToken];
      data.spent[oldToken] = rec.family;
      const fid = this.newFamilyId(data);
      const next = mintR1(key, fid, 0);
      data.families[fid.toString('base64url')] = { sub: rec.sub, gen: 0, cur: next.cur, createdAt: rec.issuedAt, usedAt: nowMs, legacy: rec.family };
      return done({ token: next.token, sub: rec.sub }, true);
    });
  }

  /** Drop every session minted under `sub`, in both formats (linear scan under
   * the store lock); the save then drops the earlier-release spent entries of
   * the families that died with them. Returns the number of sessions dropped. */
  purgeTenant(sub: string): number {
    return withFileLock(this.path, () => {
      const { data } = this.load();
      const dropped = dropSub(data, sub);
      if (dropped > 0) this.save(data);
      return dropped;
    });
  }
}
