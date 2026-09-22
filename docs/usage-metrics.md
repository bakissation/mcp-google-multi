# Local usage metrics

Off by default at every layer. When enabled by the operator, the server keeps
anonymous, **local-only** usage aggregates so the operator can see which tools
are used, which error classes fire, and where hints help. Nothing is ever sent
anywhere: there is no endpoint, no beacon, no push, no auto-upload, and no
metrics port. Data leaves the machine only when the operator copies files.

## Turning it on (and knowing it is on)

- `GOOGLE_USAGE_METRICS=on` (env, wins) or `"usageMetrics": true` in
  `config.json`. Any other non-empty env value warns once and stays OFF.
- `USAGE_METRICS_PATH=/abs/dir` relocates storage (Docker volumes). Setting the
  path alone enables nothing and creates nothing.
- The state is self-announcing: when on, the boot log, `doctor`, and the
  `diagnose` tool print one line naming the state, its source (`config`,
  `process env`, or the exact `.env` file), the directory, and its size. It is
  deliberately absent from `/health` (pre-auth surface).
- Resolved once at boot; restart to change. Deleting the metrics directory is a
  complete, supported reset.

## What is recorded

Two layers under `$XDG_STATE_HOME/mcp-google-multi/metrics` (dir `0700`,
files `0600`):

- `agg/YYYY-MM-DD.json`: per-UTC-day aggregates. Per tool: call count, error
  slugs, hint count, latency buckets, bucketed fan-out widths, argfix count.
  Per error class: hint coverage and retry self-correction. Escape hatch:
  resolved Discovery method ids and searched API keys. Protocol-level failures
  (schema validation, tool-not-found, enumerated JSON-RPC codes). Tool bigrams.
- `events.jsonl`: a bounded raw tail (4 MB rotation, one rotated file), one
  line per dispatch with **minute-precision** timestamps, tool name, ok flag,
  error slug, latency, and a bucketed result size.

Both layers are pruned to the newest 180 days. Every string written is a member
of a closed vocabulary the server ships (registered tool names, the error-slug
allowlist, resolved Discovery method ids, supported API keys), matches a pinned
shape regex, or is `other`/`unknown_*`/`_overflow`. Free text is
unrepresentable in the file format.

**Never recorded, at any layer**: tool arguments, request or response
payloads, message content, email addresses, account aliases (plaintext or
hashed), exact account counts, query strings, file names, paths, error message
text, hint text, exact result sizes.

## What a leaked metrics directory would reveal

Honestly: on a single-user instance, this is that one person's tool-activity
record: which tools ran, how often, on which days, at which minutes (in the
tail), with latency and error-class distributions. The file contents carry no
name, but the deployment might (a harvest filename, an adjacent token dir).
That is why timestamps are minute-coarse, sizes and fan-out widths are
bucketed, and both layers age out at 180 days.

**If you operate an instance on behalf of someone else and enable local usage
metrics, the files record that person's tool activity, and informing them is
your responsibility.**

## The zero-egress claim, at its true scope

The metrics module cannot egress, and nothing else in the codebase reads the
metrics files. This is enforced by tests: the module's imports are an
allowlist (`fs`, `path`, `os`, `crypto`, `perf_hooks`, the atomic-fs helper),
dynamic import is banned, and a repo-wide test pins which modules may
reference the metrics directory. Any future change that wanted to read these
files would have to break a named test.

## Reading your data

```bash
mcp-google-multi metrics report              # per-tool table, hints, retries, escape, bigrams
mcp-google-multi metrics report --json       # machine-readable
mcp-google-multi metrics report --since 30d
mcp-google-multi metrics report --promotion  # ranked curation evidence (a human decides)
mcp-google-multi metrics merge a.json b.json # sum reports/day files across instances or months
```

The `--promotion` view joins escape-hatch method ids and generated-tool
traffic against the curated set, so already-curated methods drop out; its
output is evidence for a curation request, never an automatic promotion.
Pasting a `metrics report` table into a GitHub issue is a voluntary way to
support one; that is the only path by which numbers ever leave an instance:
a human choosing to paste text.
