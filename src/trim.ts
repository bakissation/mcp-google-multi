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
