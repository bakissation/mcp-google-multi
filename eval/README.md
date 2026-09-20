# Eval harness

Three checks guard the tool surface (from the 6.0.0 quality backlog):

1. **Lazy byte budget** (`npm run measure:lazy`, CI: `scripts/measure-tools.mjs --check`): lazy-mode `tools/list` must stay within 10 percent of `tests/fixtures/lazy-bytes-baseline.json`. Update the baseline deliberately with `--update`, in the PR that justifies the growth.
2. **Contract suite** (`npm run eval:contract`, this directory): deterministic, network-free promptfoo assertions on the tool-surface contract, run in CI on every push/PR. Details below.
3. **Tier-2 agent eval** (`tier2/`): 12 scripted real-account tasks driven through Claude Code headless, scoring first-call tool selection, first-try success, tool-call counts and token spend; runs per release by the operator, never in CI (it needs a real authenticated instance and spends real tokens).

## Tier-2 agent eval

```bash
# operator machine, `claude` logged in; tasks are read-only and safe under GOOGLE_PROFILE=read-only
cat > /tmp/gmulti-eval-mcp.json << 'EOF'
{"mcpServers":{"gmulti":{"command":"npx","args":["-y","mcp-google-multi"]}}}
EOF
node eval/tier2/run.mjs --mcp-config /tmp/gmulti-eval-mcp.json            # 12 tasks x 3 runs
node eval/tier2/run.mjs --mcp-config ... --only unread-count --runs 1    # smoke
node eval/tier2/run.mjs --mcp-config ... --baseline eval/tier2/out/tier2-<prev>.json
```

The runner passes `--strict-mcp-config` (ONLY the eval server loads; without it the operator's personal MCP fleet joins the context and poisons tool selection) and runs from a neutral temp cwd so no project memory leaks in. Model is pinned via `--model` (default `sonnet`); keep it fixed across releases for comparable numbers. `--baseline` prints deltas and exits non-zero when first-call selection or success drops more than 10 points. Summaries land in `eval/tier2/out/` (gitignored); compare release over release.

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
