// Unknown-argument screening (backlog item 14). zod strips undeclared keys
// before a handler runs, so a misremembered argument name used to produce a
// SUCCESS response with wrong behavior: `parentId` on drive_create_folder was
// dropped and the folder landed in My Drive root. Field-reported, then
// reproduced: the typo, the correct name and a wholly invented key all
// returned byte-identical responses.
//
// This module is pure and holds no registry reference. It never rewrites a key
// and never touches a VALUE: it only decides that a key is undeclared, and
// suggests what the caller probably meant. Rewriting would risk sending a real
// value to Google on a guess, which is strictly worse than refusing.

import { editDistance } from './scope-catalog.js';

export type UnknownArgMode = 'reject' | 'warn' | 'off';

/**
 * `GOOGLE_ARG_UNKNOWN`: reject | warn | off. Fail-open to `warn` on a bad
 * value, because the safe state here is the one that changes no behavior.
 */
export function unknownArgMode(env: NodeJS.ProcessEnv = process.env): UnknownArgMode {
  const raw = (env.GOOGLE_ARG_UNKNOWN ?? '').trim().toLowerCase();
  if (raw === '') return DEFAULT_MODE;
  if (raw === 'reject' || raw === 'warn' || raw === 'off') return raw;
  process.stderr.write(`GOOGLE_ARG_UNKNOWN="${raw}" is not valid (reject | warn | off); using ${DEFAULT_MODE}\n`);
  return DEFAULT_MODE;
}

// Staged rollout: `warn` ships first so the change is pure observability, and
// the flip to `reject` is its own reviewable change.
const DEFAULT_MODE: UnknownArgMode = 'warn';

/** Tools that legitimately accept open-ended top-level keys. Empty at 6.0.0:
 * the escape hatch is NOT one, because its open-endedness lives in the VALUES
 * of queryParams/body, never in its six fixed top-level keys. */
export const STRICT_EXEMPT_TOOLS: ReadonlySet<string> = new Set<string>();

/** Metadata a client may legitimately attach. Measured against all registered
 * tools: no declared key starts with `_` or contains `/`, so neither rule can
 * shadow a real parameter. */
export function isExemptKey(key: string): boolean {
  return key.startsWith('_') || key.includes('/');
}

/** Generic words that must never be offered as a suggestion on containment
 * alone; they match far too much to be useful. */
const GENERIC = new Set(['id', 'name', 'title', 'body', 'parent', 'text', 'content', 'type', 'value', 'key', 'data']);

const flatten = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

function tokens(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_\-.]+/)
    .map((t) => t.toLowerCase())
    .filter(Boolean);
}

/**
 * Rank declared keys for an unknown key. Tiers, best non-empty tier wins:
 *   0 same key modulo case and separators
 *   1 every token of the unknown key appears in the declared key
 *   2 substring containment of the flattened forms
 *   3 a genuine typo by edit distance
 * Plain edit distance alone cannot carry this: parentid -> parentfolderid is
 * distance 6, well past any sane threshold, which is why tier 1 exists.
 */
export function suggestKeys(unknown: string, declared: readonly string[], limit = 2): string[] {
  const uFlat = flatten(unknown);
  const uTok = tokens(unknown);
  const tiers: Array<Array<{ key: string; rank: number }>> = [[], [], [], []];

  for (const key of declared) {
    const kFlat = flatten(key);
    const kTok = tokens(key);
    if (kFlat === uFlat) {
      tiers[0].push({ key, rank: 0 });
      continue;
    }
    if (uTok.length >= 2 && uTok.every((t) => kTok.includes(t))) {
      tiers[1].push({ key, rank: Math.abs(kTok.length - uTok.length) });
      continue;
    }
    if (uFlat.length >= 4 && !GENERIC.has(kFlat) && (kFlat.includes(uFlat) || uFlat.includes(kFlat))) {
      tiers[2].push({ key, rank: Math.abs(kFlat.length - uFlat.length) });
      continue;
    }
    const d = editDistance(uFlat, kFlat);
    if (d <= Math.max(1, Math.floor(uFlat.length / 4))) tiers[3].push({ key, rank: d });
  }

  const tier = tiers.find((t) => t.length > 0);
  if (!tier) return [];
  // Stable: declaration order breaks rank ties.
  return tier
    .map((e, i) => ({ ...e, i }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .slice(0, limit)
    .map((e) => e.key);
}

export interface ScreenedKey {
  /** the key the caller sent; for stderr and the agent-facing hint only */
  sent: string;
  /** best suggestions, always declared keys of the tool being called */
  suggestions: string[];
}

export interface ScreenResult {
  unknown: ScreenedKey[];
  /** dropped exactly as before: the caller also sent the declared key */
  redundant: string[];
}

/**
 * Split a call's post-rename keys into declared, redundant-duplicate and
 * genuinely unknown. `declared` is the tool's full declared key list.
 */
export function screenArguments(tool: string, args: Record<string, unknown>, declared: readonly string[]): ScreenResult {
  const out: ScreenResult = { unknown: [], redundant: [] };
  if (STRICT_EXEMPT_TOOLS.has(tool) || declared.length === 0) return out;
  const declaredSet = new Set(declared);
  for (const key of Object.keys(args)) {
    if (declaredSet.has(key) || isExemptKey(key)) continue;
    const suggestions = suggestKeys(key, declared);
    // The caller sent both spellings, so the declared one already won and the
    // outcome is what it has always been. Never fail a call that works today.
    if (suggestions.some((s) => s in args)) {
      out.redundant.push(key);
      continue;
    }
    out.unknown.push({ sent: key, suggestions });
  }
  return out;
}

export interface SiblingSpelling {
  key: string;
  tools: string[];
}

/** The agent-facing envelope. Values are never included, only key names. */
export function unknownArgEnvelope(
  tool: string,
  unknown: ScreenedKey[],
  declared: readonly string[],
  account: string | undefined,
  siblings: SiblingSpelling[] = [],
): { error: string; message: string; hint: string; retriable: boolean; account?: string } {
  const names = unknown.map((u) => `"${u.sent}"`).join(', ');
  const accepts = `This tool accepts: ${declared.join(', ')}.`;
  const suggested = unknown.flatMap((u) => u.suggestions);
  let hint: string;
  if (suggested.length > 0) {
    const did = unknown
      .filter((u) => u.suggestions.length > 0)
      .map((u) => u.suggestions.map((s) => `"${s}"`).join(' or '))
      .join(', ');
    hint = `Did you mean ${did}? ${accepts}`;
  } else if (siblings.length > 0) {
    const spelled = siblings
      .map((s) => `"${s.key}" (${s.tools.slice(0, 3).join(', ')})`)
      .join(' and ');
    hint = `${accepts} Other tools in this service spell a similar argument ${spelled}.`;
  } else {
    hint = accepts;
  }
  return {
    error: 'unknown_argument',
    message: `${tool} does not accept ${names}. Nothing was sent to Google.`,
    hint,
    retriable: false,
    ...(account !== undefined ? { account } : {}),
  };
}
