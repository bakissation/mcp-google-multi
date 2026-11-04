import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

// Release-train guards used by .github/workflows/pr-guards.yml. The pure
// functions are unit-tested (tests/ci-guards.test.ts); the CLI only wires
// them to git and the lockfile.
//
//   npx tsx scripts/ci-guards.ts breaking <base> <head>   exit 1 on a breaking commit
//   npx tsx scripts/ci-guards.ts bump <base> <head>       print the next bump and the commits behind it
//   npx tsx scripts/ci-guards.ts libc <baseLock> <headLock>  exit 1 when libc fields vanished
//   npx tsx scripts/ci-guards.ts ancestor <base> <head>   exit 1 when <base> is not contained in <head>

export interface Commit {
  sha: string;
  subject: string;
  body: string;
}

export type Bump = 'major' | 'minor' | 'patch' | 'none';

const HEADER_RE = /^(\w+)(\([^)]*\))?(!)?: /;

export function isBreaking(c: Commit): boolean {
  const m = HEADER_RE.exec(c.subject);
  if (m?.[3]) return true;
  return /^BREAKING[ -]CHANGE(:| )/m.test(c.body);
}

export function bumpFor(commits: Commit[]): Bump {
  let bump: Bump = 'none';
  for (const c of commits) {
    if (isBreaking(c)) return 'major';
    const type = HEADER_RE.exec(c.subject)?.[1];
    if (type === 'feat') bump = 'minor';
    else if (type === 'fix' || type === 'perf') {
      if (bump === 'none') bump = 'patch';
    }
  }
  return bump;
}

/** Number of `"libc"` keys in a package-lock.json text. */
export function libcCount(lockText: string): number {
  return (lockText.match(/"libc"\s*:/g) ?? []).length;
}

export function parseLog(raw: string): Commit[] {
  return raw
    .split('\x1e')
    .map((r) => r.replace(/^\n+/, ''))
    .filter((r) => r.trim() !== '')
    .map((r) => {
      const [sha, subject, ...rest] = r.split('\x1f');
      return { sha: (sha ?? '').trim(), subject: subject ?? '', body: rest.join('\x1f') };
    });
}

function commitsBetween(base: string, head: string): Commit[] {
  const raw = execFileSync('git', ['log', '--no-merges', '--format=%H%x1f%s%x1f%b%x1e', `${base}..${head}`], { encoding: 'utf8' });
  return parseLog(raw);
}

function main(argv: string[]): number {
  const [cmd, a, b] = argv;
  if (cmd === 'breaking' && a && b) {
    const bad = commitsBetween(a, b).filter(isBreaking);
    if (bad.length === 0) return 0;
    console.error('Breaking commits found on a non-major train. A breaking commit makes semantic-release compute the next major:');
    for (const c of bad) console.error(`  ${c.sha.slice(0, 8)} ${c.subject}`);
    console.error('Rewrite them without "!" / "BREAKING CHANGE", or add the "breaking-ok" label if a major is intended.');
    return 1;
  }
  if (cmd === 'bump' && a && b) {
    const commits = commitsBetween(a, b);
    const bump = bumpFor(commits);
    console.log(`Next release bump if this PR lands as-is: **${bump}**`);
    console.log('');
    const rank = (c: Commit): number => (isBreaking(c) ? 3 : HEADER_RE.exec(c.subject)?.[1] === 'feat' ? 2 : 1);
    for (const c of commits.filter((x) => rank(x) >= 2)) console.log(`- ${c.sha.slice(0, 8)} ${c.subject}`);
    return 0;
  }
  if (cmd === 'libc' && a && b) {
    const before = libcCount(fs.readFileSync(a, 'utf8'));
    const after = libcCount(fs.readFileSync(b, 'utf8'));
    if (after >= before) return 0;
    console.error(`package-lock.json lost libc fields (${before} -> ${after}). npm 10.9.3 drops them when regenerating the lock; restore them or regenerate with npm 11+.`);
    return 1;
  }
  if (cmd === 'ancestor' && a && b) {
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', a, b], { stdio: 'ignore' });
      return 0;
    } catch {
      console.error(`${a} has commits that ${b} does not contain (an un-back-merged hotfix or release commit). Wait for or run the back-merge into the head branch before promoting, or the promotion PR will conflict.`);
      return 1;
    }
  }
  console.error('usage: ci-guards.ts breaking|bump|ancestor <base> <head> | libc <baseLock> <headLock>');
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
