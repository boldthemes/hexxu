# hexxu CLI

Small command-line tools that consume the local hexxu state (telemetry,
skill cache, etc.) without booting pi.

## Installed today

| Binary | Purpose | Source |
|---|---|---|
| `hexxu-telemetry-summary` | Roll up `~/.hexxu/telemetry/telemetry.jsonl` by skill / exit reason / duration percentile | `cli/telemetry-summary.ts` |

## Install

Each TS file ships with a `#!/usr/bin/env -S node --experimental-strip-types`
shebang. They are executable as-is and don't need a build step.

Symlink each into `~/.hexxu/bin/` and add that to your PATH:

```bash
mkdir -p ~/.hexxu/bin
ln -sfn /path/to/hexxu/cli/telemetry-summary.ts ~/.hexxu/bin/hexxu-telemetry-summary
chmod +x /path/to/hexxu/cli/telemetry-summary.ts   # if not already

# Add to your shell profile (one-time):
echo 'export PATH="$HOME/.hexxu/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
```

Once the deferred `hexxu` onboarding CLI ships, this becomes one command.
Until then, it's manual.

## hexxu-telemetry-summary

Reads the local hexxu-telemetry JSONL and prints a rollup for a time window.

### Usage

```
hexxu-telemetry-summary [--since DURATION] [--file PATH] [--format text|json]

Options:
  --since DURATION   Time window (s/m/h/d/w). Default: 7d. Example: --since 24h
  --file PATH        Telemetry JSONL path. Default: ~/.hexxu/telemetry/telemetry.jsonl
  --format text|json Output format. Default: text
  -h, --help         Show this message
```

### Example output (text)

```
hexxu telemetry-summary
=======================
Period: 2026-05-29T17:59:40.591Z → 2026-05-30T17:59:40.591Z (window: 24h)
Source: /tmp/fake-telem.jsonl
Sessions in period: 4  (file total: 4)

Skills invoked (by count):
  meeting-action-items          4 [v 0.1.0,0.2.0]
  csv-to-markdown-converter     1 [v 0.1.0]
  skill-creator                 1 [v 0.1.0]

Exit reasons:
  quit       3  (75%)
  reload     1  (25%)

Session duration (across all sessions in period):
  p50:   8.3s
  p99:   1.9m
  mean:  34.5s
  total: 2.3m
```

### Example output (json)

Same data, structured as a single JSON object. Useful for piping into `jq`
or external dashboards.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Success (including "no sessions in window" — that's a valid empty result) |
| 1 | Argument error (bad flag, unparseable `--since`) |
| 2 | Telemetry file missing or unreadable |
| 3 | Telemetry file empty (zero parseable records) |

### Scope notes

- **V1 reads the active JSONL only**, not the rotated `.jsonl.gz` archives.
  Long-window queries that span rotations: concatenate manually:

  ```bash
  zcat ~/.hexxu/telemetry/telemetry-*.jsonl.gz \
    | cat - ~/.hexxu/telemetry/telemetry.jsonl \
    > /tmp/merged.jsonl
  hexxu-telemetry-summary --file /tmp/merged.jsonl --since 90d
  ```

- **No per-skill duration percentiles.** The locked telemetry schema records
  *session* duration, not per-skill duration. Attributing one to the other
  would be misleading. We report invocation counts per skill and duration
  percentiles at the session level only.

- **Malformed JSONL lines are skipped with a stderr warning** rather than
  aborting. Protects against partial writes or hand-edited corruption.

### How it correlates with the rest of hexxu

```
session_shutdown                                hexxu-telemetry-summary
       │                                                  │
       │ (T7) hexxu-telemetry extension                   │ reads
       │                                                  │
       ▼                                                  │
~/.hexxu/telemetry/telemetry.jsonl  ───────────────────┘
  (mode 0600, append-only, rotates at 50 MB or 90 days)

skills_invoked entries in the JSONL ────► rolled up by name in summary
worker_id (UUID from HEXXU_WORKER_ID) ──► same value across all your
                                          sessions; constraint #7
session_id (pi's UUID v7) ───────────────► one per pi session
duration_ms ─────────────────────────────► session length, ms
exit_reason ─────────────────────────────► quit/reload/new/resume/fork
```
