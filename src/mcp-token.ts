// Token model: the MCP access token (HS256 JWT, jose-only), signed state and
// authorization code, the replay guard, and the rotated refresh-token store.

import { createHash, createHmac, hkdfSync, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { SignJWT, jwtVerify } from 'jose';
import { deriveKey, encryptToken, decryptToken } from './token-store.js';
import { base64KeyBytes, KeyMemo, wipeBytes, type KeyMaterial } from './key-material.js';
import { atomicWriteFileSync, withFileLock } from './fs-atomic.js';

export const ACCESS_TTL_DEFAULT = 600; // seconds
export const STATE_TTL_DEFAULT = 600;
export const CODE_TTL_DEFAULT = 60;
export const REPLAY_CAP_DEFAULT = 100_000;

/** Derive the HS256 secret (32 bytes) from the provisioned MCP_JWT_KEY, as a
 * string or as the bytes of its text (ResolvedKey.bytes). The returned array
 * is the caller's to keep or overwrite; no other copy is left behind. */
export function jwtSecretFrom(jwtKey: KeyMaterial): Uint8Array {
  const derived = deriveKey(jwtKey);
  try {
    return new Uint8Array(derived);
  } finally {
    wipeBytes(derived);
  }
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

// `nowSec`: the caller's clock, so expiry is judged by the same clock as the
// replay guard that records the artifact's spend.
async function verifyArtifact(token: string, purpose: string, base: string, secret: Uint8Array, nowSec?: number): Promise<Record<string, unknown> & { jti: string; exp: number }> {
  const { payload } = await jwtVerify(token, secret, { issuer: base, ...(nowSec !== undefined ? { currentDate: new Date(nowSec * 1000) } : {}) });
  if (payload.purpose !== purpose) throw new Error(`wrong artifact purpose (${String(payload.purpose)})`);
  return { ...payload, jti: String(payload.jti ?? ''), exp: Number(payload.exp ?? 0) } as Record<string, unknown> & { jti: string; exp: number };
}

export function signState(payload: StatePayload, base: string, secret: Uint8Array, iat: number, ttlSec = STATE_TTL_DEFAULT): Promise<string> {
  return signArtifact(payload as unknown as Record<string, unknown>, 'mcp_state', base, secret, iat, ttlSec);
}

export async function verifyState(token: string, base: string, secret: Uint8Array, nowSec?: number): Promise<StatePayload & { jti: string; exp: number }> {
  return (await verifyArtifact(token, 'mcp_state', base, secret, nowSec)) as unknown as StatePayload & { jti: string; exp: number };
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

export async function verifyPending(token: string, base: string, secret: Uint8Array, nowSec?: number): Promise<StatePayload & { jti: string; exp: number }> {
  return (await verifyArtifact(token, 'mcp_pending', base, secret, nowSec)) as unknown as StatePayload & { jti: string; exp: number };
}

export function signAuthzCode(payload: CodePayload, base: string, secret: Uint8Array, iat: number, ttlSec = CODE_TTL_DEFAULT): Promise<string> {
  return signArtifact(payload as unknown as Record<string, unknown>, 'mcp_code', base, secret, iat, ttlSec);
}

export async function verifyAuthzCode(token: string, base: string, secret: Uint8Array, nowSec?: number): Promise<CodePayload & { jti: string; exp: number }> {
  return (await verifyArtifact(token, 'mcp_code', base, secret, nowSec)) as unknown as CodePayload & { jti: string; exp: number };
}

// --- Replay guard (single-use, capped, TTL-evicted) -------------------------

/** `full`: there is no room without forgetting a jti that is still live. */
export type ReplaySpend = 'ok' | 'replay' | 'full';

/** A full guard refuses rather than sweeping again sooner than this. */
const FULL_SWEEP_EVERY_MS = 1000;

export class ReplayGuard {
  private readonly seen = new Map<string, { exp: number; spent: boolean }>();
  // A lower bound on every entry's expiry: below it nothing can have expired.
  private earliest = Infinity;
  private sweptAt = -Infinity;

  constructor(private readonly cap = REPLAY_CAP_DEFAULT) {}

  /** Hold a slot for an artifact about to be handed out, so its spend can
   * never meet a full guard. The flood then lands where the artifact is
   * minted, and refusing there loses nothing. */
  reserve(jti: string, ttlMs: number, nowMs: number): 'ok' | 'full' {
    if (!this.room(nowMs)) return 'full';
    this.record(jti, nowMs + ttlMs, false);
    return 'ok';
  }

  /** Record a jti as spent. A full guard refuses instead of evicting a live
   * jti: a flood of spends would otherwise make a spent artifact usable again,
   * such as a callback the browser binding refused. `artifactExpMs`
   * keeps the record alive as long as the artifact itself, even when the clock
   * stepped back between its signing and this spend. */
  spend(jti: string, ttlMs: number, nowMs: number, artifactExpMs = 0): ReplaySpend {
    const exp = Math.max(nowMs + ttlMs, artifactExpMs);
    const held = this.seen.get(jti);
    if (held && held.exp > nowMs) {
      if (held.spent) return 'replay';
      held.spent = true;
      held.exp = Math.max(held.exp, exp);
      return 'ok';
    }
    if (held) this.seen.delete(jti);
    if (!this.room(nowMs)) return 'full';
    this.record(jti, exp, true);
    return 'ok';
  }

  /** Undo a spend whose next step could not go ahead. The slot stays held, so
   * nothing is forgotten, and the artifact can be spent once more. */
  unspend(jti: string): void {
    const held = this.seen.get(jti);
    if (held) held.spent = false;
  }

  /** `spend` as a boolean: false for a replay and for a full guard alike. */
  consume(jti: string, ttlMs: number, nowMs: number): boolean {
    return this.spend(jti, ttlMs, nowMs) === 'ok';
  }

  get size(): number {
    return this.seen.size;
  }

  private record(jti: string, exp: number, spent: boolean): void {
    this.seen.set(jti, { exp, spent });
    if (exp < this.earliest) this.earliest = exp;
  }

  // Swept only when at the cap (a refusal otherwise costs O(1)), and at most
  // once a second: a Map iterator steps over every deleted slot until rebuilt.
  private room(nowMs: number): boolean {
    if (this.seen.size < this.cap) return true;
    if (nowMs < this.earliest) return false;
    if (nowMs >= this.sweptAt && nowMs - this.sweptAt < FULL_SWEEP_EVERY_MS) return false;
    this.sweptAt = nowMs;
    let earliest = Infinity;
    for (const [jti, e] of this.seen) {
      if (e.exp <= nowMs) this.seen.delete(jti);
      else if (e.exp < earliest) earliest = e.exp;
    }
    this.earliest = earliest;
    return this.seen.size < this.cap;
  }
}

// --- Refresh tokens (rotated on every use, generation-counted) --------------

/** An earlier release's record, keyed by its live token. */
export interface RefreshRecord {
  sub: string;
  issuedAt: number;
  family: string;
}

/** Store files this release writes; an absent `format` is an earlier release's. */
const REFRESH_FORMAT = 2;

// r1 token: "r1." + base64url(fid 16 || gen uint32 BE || rand 16 || HMAC-SHA256).
// The dot is outside the base64url alphabet, so it can't be read as a legacy 43-char token.
const R1_PREFIX = 'r1.';
const R1_LENGTH = 94;
const R1_BODY = 36;
const R1_BYTES = 68;
const R1_MAC_DOMAIN = Buffer.from('mcp-google-multi refresh r1\n');
// Domain-separated from R1_MAC_DOMAIN: a successor derived under this key
// must never verify as a current token's own MAC, or vice versa.
const R1_SUCCESSOR_DOMAIN = Buffer.from('mcp-google-multi refresh r1 successor\n');
// Domain-separated from both of the above: a fingerprint must never verify as
// either a token MAC or a successor derivation under the same key.
const R1_FINGERPRINT_DOMAIN = Buffer.from('mcp-google-multi refresh r1 fingerprint\n');
const R1_KEY_INFO = 'mcp-google-multi:refresh-mac:v1';
// A passphrase key (deriveKey's bare-sha256 branch) would otherwise let one
// leaked r1 token test guesses offline at hash speed; scrypt adds a work factor.
const R1_SCRYPT_SALT = 'mcp-google-multi:refresh-mac:scrypt:v1';
const R1_SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
const GEN_MAX = 0xffffffff;
const LEGACY_TOKEN = /^[A-Za-z0-9_-]{43}$/;
/** With a lifetime set, a stored time further ahead than this is pulled back to the clock. */
const CLOCK_SKEW_MS = 5 * 60_000;
/** A gen-1-behind token presented within this long of the rotation that
 * retired it, from the same client, can be a concurrent duplicate rather
 * than theft. See docs/internals.md. */
export const REPLAY_WINDOW_MS = 30_000;

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
  /** Client fingerprint of the rotation that last set `cur` (clientFingerprint). */
  by?: string;
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

// Matched on the master key: scrypt runs once per process, not once per store.
const macKeyMemo = new KeyMemo();

/** Overwrite and drop every memoized refresh MAC key (shutdown). A store that
 * already holds its key sees it overwritten too. */
export function wipeRefreshKeyMemo(): void {
  macKeyMemo.wipe();
}

/** The store's own MAC key for `masterKey`, memoized. Exported so a caller
 * that never touches a RefreshStore (the AS computing a request's
 * clientFingerprint) can key it the same way the store does. */
export function refreshMacKey(masterKey: KeyMaterial): Buffer {
  const hit = macKeyMemo.get(masterKey);
  if (hit) return hit;
  if (masterKey.length === 0) deriveKey(masterKey); // throws the missing-key error
  const ikm = base64KeyBytes(masterKey) ?? scryptSync(masterKey, R1_SCRYPT_SALT, 32, R1_SCRYPT);
  let key: Buffer;
  try {
    key = Buffer.from(hkdfSync('sha256', ikm, Buffer.alloc(0), R1_KEY_INFO, 32));
  } finally {
    wipeBytes(ikm);
  }
  macKeyMemo.set(masterKey, key);
  return key;
}

function r1Mac(key: Buffer, body: Buffer): Buffer {
  return createHmac('sha256', key).update(R1_MAC_DOMAIN).update(body).digest();
}

interface R1Token {
  fidBytes: Buffer;
  fid: string;
  gen: number;
  digest: Buffer;
  /** The decoded fid||gen||rand, before the MAC: what a rotation's successor is derived from. */
  body: Buffer;
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
  return { fidBytes, fid: fidBytes.toString('base64url'), gen: buf.readUInt32BE(16), digest: sha256(buf), body: buf.subarray(0, R1_BODY) };
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
 * The token a rotation of `presentedBody` (a parsed token's fid||gen||rand)
 * mints: generation + 1, and a random part derived (not drawn) from the
 * presented body, so re-deriving it from a retired token and comparing the
 * digest against a family's stored `cur` tells a concurrent duplicate from a
 * different gen-1 token. Domain-separated from `r1Mac` so neither function's
 * output can be read as the other's. See docs/internals.md.
 */
function mintR1Successor(key: Buffer, presentedBody: Buffer): { token: string; cur: string; digest: Buffer } {
  const rand = createHmac('sha256', key).update(R1_SUCCESSOR_DOMAIN).update(presentedBody).digest().subarray(0, 16);
  const body = Buffer.alloc(R1_BODY);
  presentedBody.copy(body, 0, 0, 16); // fid
  body.writeUInt32BE(presentedBody.readUInt32BE(16) + 1, 16); // gen + 1
  rand.copy(body, 20);
  const buf = Buffer.concat([body, r1Mac(key, body)]);
  const digest = sha256(buf);
  return { token: R1_PREFIX + buf.toString('base64url'), cur: digest.toString('base64url'), digest };
}

/**
 * The family tag of a refresh token this `masterKey`'s store minted, or null
 * for anything else. Derives the key once; the returned function does no I/O,
 * so a host can key a pre-auth rate limit on it.
 */
export function refreshFamilyTagger(masterKey: KeyMaterial): (token: string) => string | null {
  const key = refreshMacKey(masterKey);
  return (token) => {
    const p = parseR1(token, key);
    return p ? familyTag(p.fidBytes) : null;
  };
}

/**
 * A correlation tag for the client presenting a refresh token:
 * HMAC-SHA256(key, client_id + "\n" + user-agent + "\n" + address), truncated
 * to 16 bytes and base64url-encoded. `key` is the store's own MAC key
 * (refreshMacKey), so computing it needs MASTER_KEY: a reader of the store
 * file alone (`by` is stored, not these inputs) cannot brute-force the
 * client_id/user-agent/address that produced it. It is still not a secret:
 * anyone who can see a live request can send the same inputs and get the
 * same tag. Pure, no I/O.
 */
export function clientFingerprint(clientId: string, userAgent: string, address: string, key: Buffer): string {
  return createHmac('sha256', key).update(R1_FINGERPRINT_DOMAIN).update(`${clientId}\n${userAgent}\n${address}`).digest().subarray(0, 16).toString('base64url');
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf-8');
  const bb = Buffer.from(b, 'utf-8');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
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
    (x.legacy === undefined || typeof x.legacy === 'string') &&
    (x.by === undefined || typeof x.by === 'string')
  );
}

function formatError(file: string, format: unknown): Error {
  const name = basename(file);
  return new Error(`E_REFRESH_STORE_FORMAT: ${name} was written by a newer release (format ${JSON.stringify(format)}): upgrade, or delete ${name} to sign every MCP client out`);
}

/** The decrypted plaintext, or null when the file is absent. Throws when it
 * does not decrypt; the caller decides what that means. */
function readPlain(file: string, masterKey: KeyMaterial): unknown {
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

// Only well-formed own entries survive, so no malformed record reaches a
// liveness test or the token codec; `dirty` says something was dropped.
function decodeData(d: unknown): { data: RefreshData; dirty: boolean } {
  const data: RefreshData = { families: {}, active: {}, spent: {} };
  const x = (d ?? {}) as Record<string, unknown>;
  let dropped = 0;
  for (const [k, f] of ownEntries(x.families)) {
    if (isFamilyRecord(k, f)) {
      data.families[k] = {
        sub: f.sub, gen: f.gen, cur: f.cur, createdAt: f.createdAt, usedAt: f.usedAt,
        ...(f.legacy === undefined ? {} : { legacy: f.legacy }),
        ...(f.by === undefined ? {} : { by: f.by }),
      };
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
  /** Absolute family lifetime in seconds, counted from the sign-in. Unset: unlimited. */
  maxAgeSec?: number;
  /** Idle lifetime in seconds, counted from the last issue or rotation. Unset: unlimited. */
  idleSec?: number;
  /** Max live refresh-token families per subject (both formats). Unset:
   * unlimited (default; the single-owner server passes none). When issuing a
   * new family would put a subject over this, that subject's own
   * least-recently-used family is dropped (by its last issue or rotation
   * time) until it fits; a dropped family behaves exactly like a revoked
   * one. Only the subject signing in ever triggers it, and only its own
   * families are ever touched. */
  maxFamiliesPerSub?: number;
  /** Server-side log for a revoked, dropped or expired family. Never given a token or a subject. */
  log?: (line: string) => void;
}

function positiveInt(name: string, v: unknown): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) throw new Error(`E_REFRESH_OPTION_INVALID: ${name} must be a positive whole number`);
  return v;
}

function lifetimeMs(name: string, v: unknown): number | undefined {
  const n = positiveInt(name, v);
  return n === undefined ? undefined : n * 1000;
}

/**
 * Persisted (encrypted under MASTER_KEY) refresh-token store. Rotates on every
 * use, and a token carries its family and generation under a MAC, so
 * presenting any generation the family has rotated past is REUSE: the family
 * is revoked for the rest of its life. The store keeps one
 * record per family, whatever its rotation count. Every read-modify-write goes
 * through a file lock so concurrent stdio+HTTP processes can't lost-update or
 * double-spend. See docs/internals.md.
 */
export class RefreshStore {
  private readonly log: (line: string) => void;
  private readonly maxAgeMs: number | undefined;
  private readonly idleMs: number | undefined;
  private readonly maxFamiliesPerSub: number | undefined;
  private macKey: Buffer | undefined;
  // Set once a load finds no earlier-release record. Nothing here adds one,
  // so from then on a legacy-shaped token is refused before the lock.
  private legacyEmpty = false;

  constructor(
    private readonly path: string,
    private readonly masterKey: KeyMaterial,
    options: RefreshStoreOptions = {},
  ) {
    this.maxAgeMs = lifetimeMs('maxAgeSec', options.maxAgeSec);
    this.idleMs = lifetimeMs('idleSec', options.idleSec);
    this.maxFamiliesPerSub = positiveInt('maxFamiliesPerSub', options.maxFamiliesPerSub);
    this.log = options.log ?? (() => undefined);
  }

  private get timed(): boolean {
    return this.maxAgeMs !== undefined || this.idleMs !== undefined;
  }

  // Positive form: a non-finite time can only make a session dead.
  private live(createdAt: number, usedAt: number, nowMs: number): boolean {
    return (this.maxAgeMs === undefined || nowMs < createdAt + this.maxAgeMs) && (this.idleMs === undefined || nowMs < usedAt + this.idleMs);
  }

  /** Drop expired sessions in both formats; the count of those dropped. */
  private prune(data: RefreshData, nowMs: number, lines: string[]): number {
    if (!this.timed) return 0;
    let n = 0;
    for (const [k, f] of Object.entries(data.families)) {
      if (!this.live(f.createdAt, f.usedAt, nowMs)) {
        delete data.families[k];
        n += 1;
      }
    }
    for (const [t, r] of Object.entries(data.active)) {
      if (!this.live(r.issuedAt, r.issuedAt, nowMs)) {
        delete data.active[t];
        n += 1;
      }
    }
    if (n > 0) {
      lines.push(`refresh families expired n=${n}`);
      if (Object.keys(data.families).length === 0 && Object.keys(data.active).length === 0) lines.push('refresh store: every session expired at once (check the host clock)');
    }
    return n;
  }

  /** A session written while the clock ran ahead would otherwise outlive its
   * limit by the size of the jump. */
  private clamp(data: RefreshData, nowMs: number, lines: string[]): boolean {
    if (!this.timed) return false;
    const limit = nowMs + CLOCK_SKEW_MS;
    let n = 0;
    const pull = (t: number): number => {
      if (t <= limit) return t;
      n += 1;
      return nowMs;
    };
    for (const f of Object.values(data.families)) {
      f.createdAt = pull(f.createdAt);
      f.usedAt = pull(f.usedAt);
    }
    for (const r of Object.values(data.active)) r.issuedAt = pull(r.issuedAt);
    if (n > 0) lines.push(`refresh store clock: n=${n} timestamps ahead of the clock were clamped`);
    return n > 0;
  }

  private key(): Buffer {
    return (this.macKey ??= refreshMacKey(this.masterKey));
  }

  /** With `nowMs` (every issue and rotation), also clamps and prunes. */
  private load(nowMs?: number, lines: string[] = []): { data: RefreshData; dirty: boolean } {
    let d: unknown;
    let readOk = true;
    try {
      d = readPlain(this.path, this.masterKey);
    } catch {
      d = null;
      readOk = false;
    }
    checkFormat(this.path, d);
    const loaded = decodeData(d);
    if (nowMs !== undefined) {
      if (this.clamp(loaded.data, nowMs, lines)) loaded.dirty = true;
      if (this.prune(loaded.data, nowMs, lines) > 0) loaded.dirty = true;
    }
    // A failed read is not evidence that the file holds no legacy record.
    if (readOk && Object.keys(loaded.data.active).length === 0 && Object.keys(loaded.data.spent).length === 0) this.legacyEmpty = true;
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
        // log sink failure ignored
      }
    }
  }

  // Evicts sub's own least-recently-used sessions down to `limit`; keepKey (the
  // family just issued) is excluded from ranking. See docs/internals.md.
  private enforceFamilyCap(data: RefreshData, sub: string, limit: number, lines: string[], keepKey: string): void {
    const entries: { at: number; drop: () => void }[] = [];
    for (const [k, f] of Object.entries(data.families)) {
      if (f.sub !== sub || k === keepKey) continue;
      entries.push({
        at: f.usedAt,
        drop: () => {
          delete data.families[k];
          lines.push(`refresh family dropped: cap tag=${familyTag(Buffer.from(k, 'base64url'))}`);
        },
      });
    }
    for (const [t, r] of Object.entries(data.active)) {
      if (r.sub !== sub) continue;
      entries.push({
        at: r.issuedAt,
        drop: () => {
          delete data.active[t];
          lines.push(`refresh family dropped: cap tag=${familyTag(r.family)}`);
        },
      });
    }
    // +1 accounts for the kept family, which stays live but is never ranked.
    if (entries.length + 1 <= limit) return;
    entries.sort((a, b) => a.at - b.at);
    for (const e of entries.slice(0, entries.length + 1 - limit)) e.drop();
  }

  private newFamilyId(data: RefreshData): Buffer {
    let fid: Buffer;
    do fid = randomBytes(16);
    while (Object.hasOwn(data.families, fid.toString('base64url')));
    return fid;
  }

  issue(nowMs: number, sub: string, fingerprint?: string): string {
    if (typeof sub !== 'string' || sub === '') throw new Error('RefreshStore.issue: sub must be a non-empty string');
    const key = this.key();
    return withFileLock(this.path, () => {
      const lines: string[] = [];
      const { data } = this.load(nowMs, lines);
      const fid = this.newFamilyId(data);
      const fidKey = fid.toString('base64url');
      const { token, cur } = mintR1(key, fid, 0);
      data.families[fidKey] = { sub, gen: 0, cur, createdAt: nowMs, usedAt: nowMs, ...(fingerprint === undefined ? {} : { by: fingerprint }) };
      if (this.maxFamiliesPerSub !== undefined) this.enforceFamilyCap(data, sub, this.maxFamiliesPerSub, lines, fidKey);
      this.save(data);
      this.emit(lines);
      return token;
    });
  }

  /** A presented token exactly one generation behind `f`, inside the replay
   * window, from the fingerprint that retired it, whose derived successor
   * matches `f.cur`: a concurrent duplicate request rather than theft (see
   * docs/internals.md). Null for anything else at that generation, including
   * a different rand (a genuinely different gen-1 token) or no fingerprint. */
  private concurrentDuplicate(r1: R1Token, f: FamilyRecord, nowMs: number, fingerprint: string | undefined, key: Buffer): { token: string } | null {
    if (fingerprint === undefined || f.by === undefined) return null;
    if (r1.gen !== f.gen - 1) return null;
    if (nowMs < f.usedAt || nowMs - f.usedAt > REPLAY_WINDOW_MS) return null;
    if (!timingSafeStringEqual(fingerprint, f.by)) return null;
    const succ = mintR1Successor(key, r1.body);
    if (!timingSafeEqual(succ.digest, Buffer.from(f.cur, 'base64url'))) return null;
    return { token: succ.token };
  }

  /** Rotate a presented refresh token; null if it is unknown, malformed, or
   * rotated away (reuse => the family is revoked). The record's sub is copied
   * forward and returned so the caller can mint the matching access token
   * without trusting anything client-supplied.
   *
   * `accept` (optional) is called inside the store lock, before any mutation,
   * with the record's sub. false: every session of that sub is dropped and
   * null returned. A throw: nothing is written and the error propagates, so
   * the presented token stays valid. Absent: unchanged.
   *
   * `fingerprint` (optional) names the presenting client (clientFingerprint).
   * Absent: a rotated-away token is always reuse, as before. Present: a
   * token exactly one generation behind, from the same fingerprint, presented
   * no earlier than and at most REPLAY_WINDOW_MS after the rotation that
   * retired it, is a concurrent duplicate: it gets back the SAME successor
   * token, with no change to the family (not even `usedAt`). Anything else
   * rotated-away is still reuse, including a clock that has stepped back
   * past `usedAt`, which cannot be told apart from a genuinely stale replay. */
  rotate(oldToken: string, nowMs: number, accept?: (sub: string) => boolean, fingerprint?: string): { token: string; sub: string } | null {
    const key = this.key();
    const r1 = parseR1(oldToken, key);
    if (!r1 && !(typeof oldToken === 'string' && LEGACY_TOKEN.test(oldToken) && !this.legacyEmpty)) return null;
    return withFileLock(this.path, () => {
      const lines: string[] = [];
      // Expiry runs first: a dead session is refused without consulting accept.
      const { data, dirty } = this.load(nowMs, lines);
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
        // Older: a rotated-away token verified by MAC as server-minted, unless a concurrent duplicate.
        if (r1.gen < f.gen) {
          const duplicate = this.concurrentDuplicate(r1, f, nowMs, fingerprint, key);
          if (!duplicate) return drop('reuse');
          if (accept && !accept(f.sub)) return refuse(f.sub);
          lines.push(`refresh family replayed tag=${familyTag(r1.fidBytes)}`);
          return done({ token: duplicate.token, sub: f.sub }, dirty);
        }
        // Newer, or the same generation with another random part: the store
        // lost a write the client saw. Not evidence of theft.
        if (r1.gen > f.gen) return drop('ahead');
        if (!timingSafeEqual(r1.digest, Buffer.from(f.cur, 'base64url'))) return drop('mismatch');
        if (accept && !accept(f.sub)) return refuse(f.sub);
        if (f.gen === GEN_MAX) return drop('overflow');
        const next = mintR1Successor(key, r1.body);
        f.gen += 1;
        f.cur = next.cur;
        // now() is read before the lock wait, so a later writer can hold an earlier time.
        f.usedAt = Math.max(f.usedAt, nowMs);
        if (fingerprint === undefined) delete f.by;
        else f.by = fingerprint;
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
      data.families[fid.toString('base64url')] = { sub: rec.sub, gen: 0, cur: next.cur, createdAt: rec.issuedAt, usedAt: Math.max(rec.issuedAt, nowMs), legacy: rec.family };
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
