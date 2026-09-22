export function trimEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !/^(0|false|off|no)$/i.test((env.GOOGLE_TRIM ?? '').trim());
}

export interface CappedText {
  text: string;
  truncated: boolean;
  totalChars: number;
}

export function capText(text: string, maxChars: number, offset = 0): CappedText {
  const slice = text.slice(offset, offset + maxChars);
  return { text: slice, truncated: offset + slice.length < text.length, totalChars: text.length };
}

// For permanent (non-paging) caps: dropping a trailing lone high surrogate keeps
// the truncated string well-formed Unicode instead of ending in mojibake.
export function sliceClean(text: string, max: number): string {
  const sliced = text.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(sliced) ? sliced.slice(0, -1) : sliced;
}

/** Largest prefix whose JSON encoding (the wrapping quotes included) fits
 * `maxEncoded`. Slicing raw characters overshoots whenever the text contains
 * quotes or backslashes, which JSON.stringify doubles: the escape hatch's
 * declared 100_000-char cap was emitting up to 15 percent more than that. */
export function sliceEncoded(text: string, maxEncoded: number): string {
  // JSON.stringify('') is already 2 chars, so no prefix can honour less.
  if (maxEncoded < 2) throw new RangeError('maxEncoded must be >= 2');
  if (maxEncoded === 2) return '';
  if (JSON.stringify(text).length <= maxEncoded) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (JSON.stringify(text.slice(0, mid)).length <= maxEncoded) lo = mid;
    else hi = mid - 1;
  }
  return sliceClean(text, lo);
}

interface ToolResult {
  content?: { type?: string; text?: string }[];
}

// Pretty-printed JSON costs ~20-30% extra tokens; re-serialize compactly.
export function compactResult<T extends ToolResult>(result: T): T {
  if (!result || !Array.isArray(result.content)) return result;
  for (const item of result.content) {
    if (item?.type === 'text' && typeof item.text === 'string' && /^[\s]*[[{]/.test(item.text)) {
      try {
        item.text = JSON.stringify(JSON.parse(item.text));
      } catch {
        // not JSON — leave untouched
      }
    }
  }
  return result;
}

export interface ListPage {
  /** Continuation token from the API, when it offers one. */
  nextPageToken?: string | null;
  /** Server-side total, when the API reports one. */
  totalItems?: number;
  /** The page came back exactly full and the API offers neither a token nor a
   * total, so "more exist" can only be inferred from the cap. */
  capped?: boolean;
  hint?: string;
  /** Fields that belong beside the list, e.g. the group a member list is of. */
  extra?: Record<string, unknown>;
}

function truncationHint(noun: string, returned: number, page: ListPage): string {
  if (page.nextPageToken) return `More ${noun} exist. Pass pageToken to continue from the end of this page.`;
  if (typeof page.totalItems === 'number') {
    return `${returned} of ${page.totalItems} ${noun} returned. Raise the page size to see the rest.`;
  }
  return `The page came back full, so more ${noun} may exist. Narrow the query or raise the page size.`;
}

/** A list payload that states whether it is the whole answer. A bare JSON array
 * cannot, so a caller sees 25 events and reports "you have 25 meetings this
 * week" when the cap, not the calendar, ended the list. */
export function listResult(noun: string, items: unknown[], page: ListPage = {}): Record<string, unknown> {
  const { nextPageToken, totalItems, capped, hint, extra } = page;
  const truncated =
    Boolean(nextPageToken) || capped === true || (typeof totalItems === 'number' && totalItems > items.length);
  return {
    [noun]: items,
    returned: items.length,
    truncated,
    ...(typeof totalItems === 'number' ? { totalItems } : {}),
    ...(nextPageToken ? { nextPageToken } : {}),
    ...extra,
    ...(truncated ? { hint: hint ?? truncationHint(noun, items.length, page) } : {}),
  };
}
