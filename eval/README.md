# Eval harness

Three checks guard the tool surface (from the 6.0.0 quality backlog):

1. **Lazy byte budget** (`npm run measure:lazy`, CI: `scripts/measure-tools.mjs --check`): lazy-mode `tools/list` must stay within 10 percent of `tests/fixtures/lazy-bytes-baseline.json`. Update the baseline deliberately with `--update`, in the PR that justifies the growth.
2. **Contract suite** (`npm run eval:contract`, this directory): deterministic, network-free promptfoo assertions on the tool-surface contract, run in CI on every push/PR. Details below.
3. **Tier-2 agent eval** (planned): 12-15 scripted real-account tasks scoring first-call tool selection, first-try success and token spend; runs per release, not per commit.

## Contract suite

`contract/promptfooconfig.yaml` boots the built server (`npm run build` first) with a fixture registry: one account, fake OAuth client credentials, an empty token store, every optional bundle, curated discovery mode, read-only write profile. No Google request ever succeeds, which is the point: every Google-bound call exercises exactly the failure contract a real user hits, and everything else (discovery, validation, coercion, write-control, the escape hatch's pre-network paths) is fully deterministic.

What it pins:

- **The error-envelope contract**: every tool failure parses as `{error, message, retriable, account}` and carries a `hint` (the 6.0.0 hint floor). Free-text errors are a contract break.
- **Coercion**: string-encoded numbers/booleans from clients must coerce, never fail validation.
- **Graceful dispatch**: curated tools resolve in curated mode; hidden tools stay callable.
- **Discovery behavior**: catalog shape, query filtering, the no-match hint, expand/collapse.
- **Escape hatch**: unknown-api and ambiguous-alias responses (network-free paths only; Discovery-doc fetches stay out of CI).
- **Write-control**: a write under `read-only` returns `write_disabled` with the enable hint.

Constraints (measured, not guessed): promptfoo only calls tools present in `tools/list`, so the suite MUST run `GOOGLE_DISCOVERY=curated`; promptfoo requires Node >= 22.22; `PROMPTFOO_DISABLE_UPDATE=1` avoids a version check that can hang for minutes. The pinned promptfoo version lives in the `eval:contract` npm script.

Cases that need a real authenticated account (live Google error shapes such as the invalid Drive query hint) intentionally stay OUT of this suite; they belong to the tier-2 per-release eval.
