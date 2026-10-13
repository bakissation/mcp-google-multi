# Test-suite study: what proves nothing, what is redundant

Branch: `research/test-study`. All commands run against `mcp-google-multi` on commit `0429c5f` (dev HEAD at study start). Raw JSON backing every table in this document lives alongside it in `research/`.

## 1. Timings

Full suite: **93 test files, 1524 tests (1522 passed, 2 skipped), wall time 82.2s** (`npx vitest run --reporter=json`). Sum of individual file durations is 101.8s; the gap is parallelism across vitest's worker pool.

**Slowest files** (full table: `research/timings-per-file.json`):

| file | tests | duration |
|---|---|---|
| tests/http-transport.test.ts | 70 | 82.15s |
| tests/empty-registry.test.ts | 11 | 4.44s |
| tests/metrics-integration.test.ts | 2 | 2.82s |
| tests/http-boot-smoke.test.ts | 1 | 1.83s |
| tests/mcp-token.test.ts | 77 | 1.45s |
| tests/oauth-as.test.ts | 103 | 1.08s |
| tests/live-account-arg.test.ts | 8 | 1.03s |
| tests/exports-map.test.ts | 6 | 0.95s |
| tests/registry-transfer.test.ts | 17 | 0.94s |
| tests/generated-tools.test.ts | 27 | 0.91s |

`tests/http-transport.test.ts` alone is **97% of total suite wall time**. Within it, 5 of 70 tests (the `close({ graceMs })` graceful-shutdown scenarios) each take ~15s due to real timers, accounting for 76 of its 82 seconds; the other 65 tests have a median of 10ms.

**Slowest 50 individual tests**: `research/timings-slowest-tests.json`. Top 5 are all `http-transport.test.ts` graceful-close tests at 15.0-15.6s each; #6 onward drop below 2s.

## 2. Coverage

Whole-suite coverage (v8, `src/**/*.ts` excluding `src/tools/generated/**`): **66.2% lines, 67.6% branches, 71.2% functions** (7240 coverable lines, 4792 covered). Full data: `research/coverage-full/`.

**Src files with zero line coverage**: only `src/index.ts` and `src/migrate-tokens.ts`, both CLI entrypoints, expected to be smoke-tested rather than unit-tested.

**Files under 1% coverage of the whole suite**: **none.** The floor is 2.3% (166/7240 lines): every test file imports modules whose top-level code runs on import alone, so a 1% threshold catches nothing here. This is itself a finding: the heuristic as specified doesn't discriminate for this codebase; a per-file baseline of ~2.3% should be assumed before treating any file as "doing nothing."

**Test files whose covered-line set is a strict subset of another single file's** (18 found; full list `research/analysis-subsets.json`). Smallest 5:

| subset file | lines | superset file | lines |
|---|---|---|---|
| tests/deploy-templates.test.ts | 166 | tests/setup-prompt.test.ts | 169 |
| tests/mcpb-manifest.test.ts | 166 | tests/setup-prompt.test.ts | 169 |
| tests/metrics-integration.test.ts | 166 | tests/setup-prompt.test.ts | 169 |
| tests/path-safety.test.ts | 166 | tests/setup-prompt.test.ts | 169 |
| tests/registry-entry.test.ts | 166 | tests/setup-prompt.test.ts | 169 |

These are candidates for merging/removal from a *line-coverage* standpoint only: they may still assert behavior (return values, error shapes) that line coverage can't see, so this is a lead, not a verdict.

## 3. Mutation testing

**StrykerJS (`@stryker-mutator/vitest-runner@10.0.0`) does not work against this project's vitest 5.0.4.** Confirmed with trace logging: the runner's `VitestTestRunner.init()` tries to `JSON.stringify` vitest's resolved config and throws `TypeError: Converting circular structure to JSON` on `resolvedProjects[0].viteConfig`, on every actual mutant run (the dry run uses a different path and succeeds, which is why a first naive attempt silently produced 0 kills / 211 "survived" instead of an error: the runner was crashing per-mutant and Stryker's fallback recorded that as `testsCompleted: 0`). This is a vitest-5-shaped config object the runner's current release can't serialize, not a flake. Per the task's fallback instructions, mutation testing below was done with a purpose-built TypeScript-AST mutator instead (`research/` scripts, not checked in, see Methodology).

**Methodology.** For each guarded branch, four mutator categories: negate an `if`/`while`/`do`/ternary condition; drop a single-statement `return`/`throw` guard clause; flip `===`/`!==`/`==`/`!=`; and off-by-one on `<`/`<=`/`>`/`>=` (operator flip plus plus-or-minus 1 on a numeric literal operand). For each mutant, the covering test file(s) were taken from the per-file coverage sets in Section 2 (home test file always included; supplementary files added up to a ~15s budget, since several modules, especially `fs-atomic.ts`, with no dedicated test file, are nominally touched by nearly all 93 suites through shared setup/import side effects, not because they're meaningfully exercised). `tests/http-transport.test.ts` needed per-individual-test granularity (not whole-file) to stay in budget, since 5 of its 70 tests dominate its cost; this is the one file mutation testing targeted at test-level resolution. 3-way concurrency via git worktrees with a symlinked `node_modules`, mirroring the task's requested Stryker concurrency.

**Modules mutated in the specified order; new modules stopped starting after 150 minutes** (actual cumulative time to reach that cap: 198.8 min, because `http-transport.ts` alone ran 112.6 minutes: its only dedicated tests are the same 5 slow graceful-close tests, which cover nearly the entire file's control flow, so almost every mutant needed all 5 regardless of batching). `src/oauth-as.ts` (235 candidate mutants) was never started as a result and has **no mutation data**.

| module | mutants | killed | survived | timeout | no-coverage | score* |
|---|---|---|---|---|---|---|
| src/write-control.ts | 63 | 55 | 5 | 0 | 3 | 91.7% |
| src/arg-strict.ts | 60 | 46 | 12 | 0 | 2 | 79.3% |
| src/arg-normalize.ts | 98 | 76 | 18 | 0 | 4 | 80.9% |
| src/mcp-token.ts | 219 | 184 | 24 | 0 | 11 | 88.5% |
| src/token-store.ts | 33 | 30 | 1 | 0 | 2 | 96.8% |
| src/ssrf-guard.ts | 105 | 76 | 24 | 1 | 4 | 76.2% |
| src/outbound-allowlist.ts | 35 | 29 | 6 | 0 | 0 | 82.9% |
| src/fs-atomic.ts | 86 | 56 | 9 | 12 | 9 | 88.3% |
| src/master-key.ts | 42 | 33 | 8 | 0 | 1 | 80.5% |
| src/fanout.ts | 34 | 24 | 8 | 0 | 2 | 75.0% |
| src/trim.ts | 38 | 20 | 13 | 1 | 4 | 61.8% |
| src/registry.ts | 134 | 101 | 23 | 0 | 10 | 81.5% |
| src/executor.ts | 19 | 17 | 2 | 0 | 0 | 89.5% |
| src/http-transport.ts | 116 | 83 | 13 | 13 | 7 | 88.1% |
| src/oauth-as.ts | 235 | n/a | n/a | n/a | n/a | **not run** |

\* score = (killed + timeout) / (killed + survived + timeout), i.e. no-coverage mutants excluded from the denominator, timeouts counted as detected (the suite did catch them, just by hanging rather than failing cleanly).

**1082 mutants total generated across the 14 completed modules** (235 more in `oauth-as.ts` ungenerated-against): 701 killed, 166 survived, 27 timed out, 55 had no covering test at all.

### Survivors by mutation kind

| kind | survivors |
|---|---|
| off-by-one | 75 |
| drop-return-throw | 60 |
| negate-condition | 17 |
| flip-equality | 14 |

Boundary conditions (off-by-one) and silently-droppable guard clauses are by far the weakest spot, together 81% of all survivors. `flip-equality` mutants are caught almost every time, meaning `===`/`!==` typos are well-defended; a wrong `<` vs `<=` or a guard whose `return`/`throw` quietly stops mattering is not.

### Top 30 survivors (sorted to front-load the weaker modules: trim, ssrf-guard, fanout, arg-strict/normalize)

`module:line` | kind | mutation | tests covering the line

| location | kind | mutation | covering tests |
|---|---|---|---|
| src/trim.ts:38 | off-by-one | `>` → `>=` | 174 |
| src/trim.ts:49 | drop-return-throw | `throw new RangeError('maxEncoded must be >= 2');` → `;` | 87 |
| src/trim.ts:49 | off-by-one | `<` → `<=` | 87 |
| src/trim.ts:49 | off-by-one | `2` → `3` | 87 |
| src/trim.ts:49 | off-by-one | `2` → `1` | 87 |
| src/trim.ts:50 | negate-condition | `maxEncoded === 2` → `!(maxEncoded === 2)` | 87 |
| src/trim.ts:50 | drop-return-throw | `return '';` → `;` | 87 |
| src/trim.ts:50 | flip-equality | `===` → `!==` | 87 |
| src/trim.ts:51 | drop-return-throw | `return text;` → `;` | 87 |
| src/trim.ts:51 | off-by-one | `<=` → `<` | 87 |

(remaining 20 of the top 30, plus all 166, in `research/kill-matrix-analysis.json` under `survivors`.) The `trim.ts:38-51` cluster is `sliceClean`'s boundary math (the "drops a trailing lone surrogate" cap logic from `src/trim.ts`'s own docs): every boundary and early-return in that function can be broken without any of the 87 nominally-covering tests noticing, which is a real gap in a function whose whole job is getting a boundary exactly right.

### Timeouts (27 total; first 10)

All but 2 are in `src/fs-atomic.ts`'s lock-acquisition retry loop (lines 94-258: `holderDead`, the `Date.now() >= deadline` check, `breakLock`). Negating or off-by-one-ing the deadline comparison turns a bounded retry into an unbounded one. The suite does catch these, but only by hanging for 90s+ rather than failing with an assertion, which in CI reads as a flaky/slow build rather than a clear signal. This is a test-quality finding independent of mutation score: `fs-atomic.ts` has **no dedicated test file** (unlike every other module on the list); it's exercised only incidentally, through ~90 other suites' setup code that happens to write a token or config file.

### "Tests that prove nothing" (zero mutants killed)

Two cuts, because the coarse (file-level, not per-test) coverage data used to pick which tests to run for most modules inflates a naive "ran during mutation testing but never caught anything" count: against the full 1507-test universe that had *some* nominal opportunity, 810 (54%) never appear in a `killedBy` list, but the large majority of those are tests from entirely unrelated suites (`discovery-client.test.ts`, `doctor.test.ts`, `errors.test.ts`, ...) that were only swept in because `fs-atomic.ts`'s nominal coverage set is nearly the whole suite. That number is not trustworthy as "redundant tests."

The trustworthy cut: **for each module's own dedicated test file, which of its own tests never killed a single mutant in that module.** 50 of 438 home-file tests (11%), concentrated here:

| module | home test file | zero-kill / total |
|---|---|---|
| src/fanout.ts | tests/fanout.test.ts | 10 / 23 |
| src/trim.ts | tests/trim.test.ts | 8 / 24 |
| src/write-control.ts | tests/write-control.test.ts | 7 / 20 |
| src/arg-strict.ts | tests/arg-strict.test.ts | 7 / 27 |
| src/arg-normalize.ts | tests/arg-normalize.test.ts | 5 / 33 |
| src/token-store.ts | tests/token-store.test.ts | 5 / 26 |
| src/mcp-token.ts | tests/mcp-token.test.ts | 3 / 77 |
| src/ssrf-guard.ts | tests/ssrf-guard.test.ts | 2 / 29 |
| src/http-transport.ts | tests/http-transport.test.ts | 2 / 70 |
| src/master-key.ts / outbound-allowlist.ts / registry.ts | n/a | 0 |

Full name lists: `/tmp` script output is not retained, but every one of these is reproducible from `research/mutation-raw/*.json` plus `research/vitest.json`. Two caveats before treating any individual test as dead weight: (1) the mutator has no string/regex-literal category, so e.g. `fanout.ts`'s 8 zero-kill `CSV_RE` table tests aren't "proving nothing", there's simply no mutant of the kind generated here on a regex literal; (2) several zero-kill tests (`resolvePolicy defaults to read-only...`, the `trim.ts` `formatEvent` cases) cover lines whose mutants were *already* killed by a different test in the same file, which is a genuine redundancy signal, not a mutator blind spot.

### Tests whose kill-set is a strict subset of another single test's

432 such pairs among 697 tests that killed at least one mutant (full list: `research/kill-matrix-analysis.json` → `subsetPairs`). Smallest 5:

| subset test | kills | superset test | kills |
|---|---|---|---|
| normalizeCallArguments never clobbers: both spellings present... | 1 | normalizeCallArguments renames a snake_case key to its declared camelCase... | 5 |
| normalizeCallArguments leaves keys alone when the camelCase twin is not declared | 1 | normalizeCallArguments renames a snake_case key to its declared camelCase... | 5 |
| withValidationEnvelope (outbound) leaves a handler-authored envelope alone | 1 | withValidationEnvelope (outbound) leaves handler-authored PROSE alone | 3 |
| screenMessage (unknown-argument screening) forwards declared keys... | 1 | suggestion work is bounded on caller input... | 12 |
| screenArguments ignores exempt keys | 1 | suggestion work is bounded on caller input... | 12 |

A strict subset by mutation kill-set doesn't mean delete the test: it means every *defect this mutation study can seed* that the subset test catches, the superset test also catches. It's the same signal as the Section 2 coverage-subset list, at finer grain.

## 5 sharpest findings

1. **`fs-atomic.ts` has no dedicated test file** despite being security-relevant (the atomic-write plus path-keyed lock used by every token write). It's only exercised incidentally via ~90 other suites' setup code, and 12 of its 86 mutants only got caught by hanging the test runner for 90s+ rather than failing cleanly.
2. **`oauth-as.ts` (235 mutants, the OAuth 2.1 authorization server) got no mutation testing at all** in this run: `http-transport.ts`'s 5 slow graceful-close tests cover nearly its entire control flow, so almost every one of its 116 mutants needed all 5 regardless of batching, consuming 112 of the 199 minutes actually spent before the 150-minute new-module cutoff was reached.
3. **Off-by-one and dropped guard clauses are 81% of all 166 survivors**; `===`/`!==` typos are almost always caught. `trim.ts`'s `sliceClean` boundary math (lines 38-51) is the single worst spot: every boundary condition and early return there can be broken with zero test failures among 87 nominally-covering tests.
4. **No test file covers under 1% of src.** A file-level coverage floor of ~2.3% comes from import-time side effects alone, so that specific heuristic (as literally specified) finds nothing on this codebase; the subset-of-another-file's-coverage check (18 files) is the metric that actually surfaces candidates.
5. **11% of each tested module's own dedicated tests never killed a single mutant in that module** (50/438), concentrated in `fanout.test.ts` (10/23) and `trim.test.ts` (8/24). Some of that is the mutator's blind spot (no regex/string-literal mutations, e.g. `fanout.ts`'s `CSV_RE` table tests), but several (`write-control.ts`'s `resolvePolicy` cases, `trim.ts`'s `formatEvent` cases) are genuine redundancy: a sibling test in the same file already kills everything they touch.
