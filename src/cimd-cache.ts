// H4 F6: GET /authorize is unauthenticated, and a client_id on an allowlisted
// issuer with a path never seen before forces an outbound fetch. So the
// fetches running at once are capped, one client_id is fetched once however
// many requests wait on it, and only a document that passed validation is
// kept. Errors are never cached (CIMD section 5.2), and a negative cache would
// not help anyway: the attack varies the path, so its key never repeats.

import { CimdHttpError, isTransientFetchError, SsrfBlockedError } from './ssrf-guard.js';
import { logSafe } from './trim.js';

export const CIMD_TTL_MS = 5 * 60_000;
/** The oldest validated document still served while the cap is full or the issuer cannot answer. */
export const CIMD_MAX_STALE_MS = 24 * 60 * 60_000;
/** Fetches at once. Their lookups are capped apart (ssrf-guard), as a lookup outlives a fetch that gave up on it. */
export const CIMD_MAX_IN_FLIGHT = 4;
export const CIMD_CACHE_MAX = 256;
const BUSY_LOG_EVERY_MS = 60_000;

export type CimdDocument = Record<string, unknown>;
type CimdError = { error: 'E_CIMD_SSRF_BLOCKED' | 'E_CIMD_INVALID' };
type Fetched = { doc: CimdDocument; fresh: boolean } | CimdError;

/** `fresh` is true only for the request whose fetch produced the document. */
export type CimdResolution = { doc: CimdDocument; fresh: boolean } | { busy: true } | CimdError;

export interface CimdCacheDeps {
  fetch: (clientId: string) => Promise<CimdDocument>;
  now: () => number;
  log: (line: string) => void;
}

export class CimdClientCache {
  private readonly entries = new Map<string, { doc: CimdDocument; at: number }>();
  // One entry per running fetch, so its size is the number of permits taken.
  private readonly inFlight = new Map<string, Promise<Fetched>>();
  private busyLoggedAt = -Infinity;
  private busySuppressed = 0;

  constructor(private readonly deps: CimdCacheDeps) {}

  get size(): number {
    return this.entries.size;
  }

  /** `validate` runs once per fetch, in the request that started it, and every
   * request waiting on that fetch gets the same answer. */
  async resolve(clientId: string, validate: (doc: CimdDocument) => boolean): Promise<CimdResolution> {
    const entry = this.entries.get(clientId);
    const age = entry ? this.deps.now() - entry.at : 0;
    if (entry && age < CIMD_TTL_MS) return { doc: entry.doc, fresh: false };
    if (entry && age >= CIMD_MAX_STALE_MS) this.entries.delete(clientId);
    const running = this.inFlight.get(clientId);
    if (running) {
      const out = await running;
      return 'doc' in out ? { doc: out.doc, fresh: false } : out;
    }
    if (this.inFlight.size >= CIMD_MAX_IN_FLIGHT) {
      // A flood of fresh paths is exactly when the cap is full, and a client
      // that signed in before must still be able to.
      const stale = this.entries.get(clientId);
      if (stale) return { doc: stale.doc, fresh: false };
      this.noteBusy();
      return { busy: true };
    }
    return this.fetchFor(clientId, validate);
  }

  private async fetchFor(clientId: string, validate: (doc: CimdDocument) => boolean): Promise<CimdResolution> {
    // Never rejects: neither core nor a host installs an unhandledRejection
    // handler, and a waiter that stopped listening must not take the process down.
    let settle!: (out: Fetched) => void;
    this.inFlight.set(clientId, new Promise<Fetched>((r) => (settle = r)));
    let out: Fetched = { error: 'E_CIMD_INVALID' };
    try {
      const doc = await this.deps.fetch(clientId);
      if (validate(doc)) {
        this.store(clientId, doc);
        out = { doc, fresh: true };
      } else {
        this.entries.delete(clientId);
      }
    } catch (e) {
      out = { error: e instanceof SsrfBlockedError ? 'E_CIMD_SSRF_BLOCKED' : 'E_CIMD_INVALID' };
      // A document that went bad is never served stale. An issuer that is down
      // or overloaded says nothing about the document, so the last good one
      // stays and answers this fetch's requests too (stale-if-error; the error
      // itself is never stored).
      const stale = this.entries.get(clientId);
      if (!saysNothingAboutDocument(e)) this.entries.delete(clientId);
      else if (stale && this.deps.now() - stale.at < CIMD_MAX_STALE_MS) out = { doc: stale.doc, fresh: false };
      // #13: the detail goes to the log only; the caller gets a generic answer.
      this.deps.log(`CIMD fetch failed for ${logSafe(clientId, 128)}: ${logSafe(e instanceof Error ? e.message : 'non-Error rejection', 200)}`);
    } finally {
      this.inFlight.delete(clientId);
      settle(out);
    }
    return out;
  }

  private store(clientId: string, doc: CimdDocument): void {
    this.entries.delete(clientId);
    while (this.entries.size >= CIMD_CACHE_MAX) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.entries.set(clientId, { doc, at: this.deps.now() });
  }

  // Over-cap requests arrive at whatever rate the caller likes.
  private noteBusy(): void {
    const now = this.deps.now();
    if (now - this.busyLoggedAt < BUSY_LOG_EVERY_MS) {
      this.busySuppressed++;
      return;
    }
    const suppressed = this.busySuppressed;
    this.busyLoggedAt = now;
    this.busySuppressed = 0;
    this.deps.log(`CIMD busy: in-flight cap reached${suppressed > 0 ? ` (n=${suppressed} suppressed)` : ''}`);
  }
}

function saysNothingAboutDocument(e: unknown): boolean {
  if (isTransientFetchError(e)) return true;
  return e instanceof CimdHttpError && (e.status === 408 || e.status === 429 || e.status >= 500);
}
