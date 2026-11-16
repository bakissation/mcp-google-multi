import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateReferenceFiles, allToolNames, argNamesFor, portableRoot } from '../scripts/gen-skill.js';

// Keeps skills/google-workspace in sync with the real tool registry: the
// generated reference tables must match what the generator produces right
// now, and the hand-written SKILL.md must never name a tool or argument the
// registry does not have.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const skillDir = path.join(repoRoot, 'skills/google-workspace');
const referenceDir = path.join(skillDir, 'reference');
const skillMdPath = path.join(skillDir, 'SKILL.md');

/**
 * Name-shape rule (deliberately simple, so it stays easy to audit):
 * - A backticked span that is ENTIRELY snake_case with 2+ segments
 *   (`gmail_search`, `account_list`) is a claimed TOOL NAME, checked
 *   against the registry's tool names.
 * - A backticked span shaped `tool_name(arg1, arg2)` is a claimed tool
 *   PLUS its arguments: the tool name is checked as above, and each
 *   comma-separated identifier inside the parens is checked against that
 *   tool's declared argument names.
 * Anything else backticked (plain words, `fields`, `{service}_discover`,
 * error codes, JSON snippets) is prose, not a claim, and is never checked.
 */
const TOOL_NAME_RE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;
const CALL_RE = /^([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\(([^)]*)\)$/;

export function findSkillIssues(text: string, toolNames: Set<string>, argsFor: (tool: string) => string[] | undefined): string[] {
  const issues: string[] = [];
  const spans = text.match(/`([^`]+)`/g) ?? [];
  for (const span of spans) {
    const inner = span.slice(1, -1);
    const call = CALL_RE.exec(inner);
    if (call) {
      const [, tool, argsRaw] = call;
      if (!toolNames.has(tool)) {
        issues.push(`unknown tool \`${tool}\` (from \`${inner}\`)`);
        continue;
      }
      const declared = new Set(argsFor(tool) ?? []);
      const args = argsRaw.split(',').map((a) => a.trim()).filter(Boolean);
      for (const arg of args) {
        if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(arg)) continue;
        if (!declared.has(arg)) issues.push(`unknown argument \`${arg}\` on \`${tool}\` (from \`${inner}\`)`);
      }
      continue;
    }
    if (TOOL_NAME_RE.test(inner) && !toolNames.has(inner)) {
      issues.push(`unknown tool \`${inner}\``);
    }
  }
  return issues;
}

describe('skill reference tables', () => {
  it('every committed reference/<service>.md matches the generator output right now', () => {
    const generated = generateReferenceFiles();
    const onDisk = fs.readdirSync(referenceDir).filter((f) => f.endsWith('.md')).sort();
    expect(onDisk).toEqual(Object.keys(generated).sort());
    for (const name of onDisk) {
      const diskContent = fs.readFileSync(path.join(referenceDir, name), 'utf8');
      expect(diskContent, `${name} is stale, run npm run gen:skill`).toBe(generated[name]);
    }
  });

  it('maps a platform-resolved local-files root back to the portable placeholder', () => {
    const winRoot = 'D:\\path\\to\\local-files';
    expect(portableRoot(`confined to ${winRoot} (GOOGLE_LOCAL_FILES_DIR); a relative path`, winRoot)).toBe(
      'confined to /path/to/local-files (GOOGLE_LOCAL_FILES_DIR); a relative path',
    );
    const posix = path.posix.resolve('/path/to/local-files');
    expect(portableRoot(`root ${posix}`, posix)).toBe('root /path/to/local-files');
  });

  it('the committed tables carry no drive letter or backslash root', () => {
    for (const name of fs.readdirSync(referenceDir).filter((f) => f.endsWith('.md'))) {
      const text = fs.readFileSync(path.join(referenceDir, name), 'utf8');
      expect(text, name).not.toMatch(/[A-Za-z]:\\+path/);
    }
  });

  it('mutation: an edited reference file no longer matches the generator (proves the check is not vacuous)', () => {
    const generated = generateReferenceFiles();
    const [firstName, firstContent] = Object.entries(generated)[0];
    const diskContent = fs.readFileSync(path.join(referenceDir, firstName), 'utf8');
    expect(diskContent).toBe(firstContent);
    const mutated = `${diskContent}\nsome hand-edit that the generator never produced\n`;
    expect(mutated).not.toBe(generated[firstName]);
  });
});

describe('SKILL.md tool and argument names', () => {
  const toolNames = new Set(allToolNames());

  it('names only tools and arguments the registry actually has', () => {
    const text = fs.readFileSync(skillMdPath, 'utf8');
    expect(findSkillIssues(text, toolNames, argNamesFor)).toEqual([]);
  });

  it('mutation: a renamed tool is caught (proves the tool-name check is not vacuous)', () => {
    const text = fs.readFileSync(skillMdPath, 'utf8');
    expect(text).toContain('`gmail_list_history(startHistoryId, historyTypes)`');
    const mutated = text.replace('`gmail_list_history(startHistoryId, historyTypes)`', '`gmail_list_histories(startHistoryId, historyTypes)`');
    const issues = findSkillIssues(mutated, toolNames, argNamesFor);
    expect(issues.some((i) => i.includes('gmail_list_histories'))).toBe(true);
  });

  it('mutation: a renamed argument is caught (proves the argument check is not vacuous)', () => {
    const text = fs.readFileSync(skillMdPath, 'utf8');
    expect(text).toContain('`gmail_search(since, until)`');
    const mutated = text.replace('`gmail_search(since, until)`', '`gmail_search(since, untilDate)`');
    const issues = findSkillIssues(mutated, toolNames, argNamesFor);
    expect(issues.some((i) => i.includes('untilDate'))).toBe(true);
  });

  it('a plain backticked word or a brace placeholder is never flagged', () => {
    const issues = findSkillIssues('See `fields`, `{service}_discover`, and `full: true` for details.', toolNames, argNamesFor);
    expect(issues).toEqual([]);
  });
});
