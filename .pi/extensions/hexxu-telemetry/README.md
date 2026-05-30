# hexxu-telemetry

Pi extension that captures one JSONL record per pi session, local-only by
default. Foundation for the `hexxu telemetry-summary` CLI (T8) and the future
postgres-backed analytics in phase B.

## Install

Same install pattern as `hexxu-skills-sync`. Drop the directory into either
of pi's extension search paths:

```bash
# global (loaded from any cwd)
mkdir -p ~/.pi/agent/extensions
cp -r /path/to/hexxu/.pi/extensions/hexxu-telemetry \
  ~/.pi/agent/extensions/hexxu-telemetry
```

You MUST set `HEXXU_WORKER_ID` in your shell profile (per constraint #7 and
`docs/onboarding.md` in `hexxu-skills`):

```bash
echo 'export HEXXU_WORKER_ID=<your-uuid-v4>' >> ~/.bashrc
source ~/.bashrc
```

Without it the extension warns once per session and skips writing.

## Locked schema

Every record is a single JSONL line with these fields. Additions are
forward-compatible; **removals are not** — never remove a field from this
list without a coordinated migration across consumers (CLI in T8, future
postgres extension).

| Field | Type | Notes |
|---|---|---|
| `event_at` | ISO 8601 UTC string | Time of `session_shutdown` |
| `worker_id` | UUID v4 string | From `HEXXU_WORKER_ID`, raw, local-only |
| `session_id` | string | Pi's `ctx.sessionManager.getSessionId()` |
| `skills_invoked` | array of `{name, version}` | Deduped by name; version from frontmatter, `null` if unmigrated |
| `duration_ms` | number | Session end minus session start |
| `exit_reason` | `"quit"\|"reload"\|"new"\|"resume"\|"fork"` | From pi's `SessionShutdownEvent.reason` |

Optional fields the implementer (today: you) may add without breaking
forward compat: `model`, `total_tokens`, `cwd`, `exit_code`, etc.

Example record:

```json
{"event_at":"2026-05-30T17:41:02.755Z","worker_id":"7247f12e-dfe7-4e49-96c4-aec989093938","session_id":"019e79f9-9343-76f0-b64c-796b3d4e4dbb","skills_invoked":[{"name":"meeting-action-items","version":"0.1.0"}],"duration_ms":12340,"exit_reason":"quit"}
```

## Configuration (env vars)

All optional.

| Var | Default | Notes |
|---|---|---|
| `HEXXU_WORKER_ID` | (none — required) | UUID v4; without this telemetry is skipped |
| `HEXXU_TELEMETRY_DIR` | `~/.hexxu/telemetry` | Directory holding the active log + archives |
| `HEXXU_TELEMETRY_FILE` | `<dir>/telemetry.jsonl` | Active append file |
| `HEXXU_TELEMETRY_DISABLED` | (unset) | Set to `1`/`true`/`yes` to silently skip |
| `HEXXU_TELEMETRY_MAX_BYTES` | `52428800` (50 MB) | Rotate when active log exceeds |
| `HEXXU_TELEMETRY_MAX_DAYS` | `90` | Rotate when active log mtime is older |

## File semantics

- **Path:** `~/.hexxu/telemetry/telemetry.jsonl` (by default)
- **Mode:** `0o600` on create, asserted on every write
- **Append safety:** opened with `O_WRONLY | O_CREAT | O_APPEND`; record size << 4 KB so POSIX guarantees line-atomic appends across concurrent pi sessions on the same machine
- **Rotation:** at write time, if size > `MAX_BYTES` OR mtime older than `MAX_DAYS` days, the active file is gzipped to `telemetry-YYYY-MM-DD.jsonl.gz` and the original is truncated. Single-process model = no concurrent-write race.

## Failure semantics

| Condition | Behavior |
|---|---|
| `HEXXU_TELEMETRY_DISABLED=1` | Silent skip |
| `HEXXU_WORKER_ID` missing or invalid | One-time warn per session; no write |
| Directory create fails | Warn; no write; pi session unaffected |
| Append fails (disk full, perms) | Warn; no write; pi session unaffected |
| Rotation fails (e.g., archive write perms) | Warn; **keep appending to current file** (no data loss) |
| `node:zlib` gzip throws | Warn; rotation aborts; original file kept |

Telemetry is **best-effort.** A pi session never blocks or fails on a
telemetry write failure (constraint #5).

## What gets counted as "skill invoked"

The extension listens for `tool_execution_start` events with `toolName ===
"read"` and matches the file path against `(?:^|[\\/])([^\\/]+)[\\/]SKILL\.md$`.
Any read of a file ending in `SKILL.md` records the parent directory as a
skill name. Versions come from the frontmatter at read time.

**Implication:** if a skill loads `references/SKILL.md` from another skill
to compose, both get counted. This is the right semantic — both contributed
to the session.

**Limitation:** skills used via the `available_skills` system-prompt block
that the model paraphrases without an explicit read are NOT counted. This is
a known limitation; pi exposes the SKILL.md read as the only deterministic
signal of "skill engaged" today.

## Commands

- `/telemetry-status` — Print the current session's telemetry state (worker_id,
  session_id, skill count, log file path, disabled flag). Useful in dev.

## Consumed by

- **`hexxu telemetry-summary` CLI (T8, pending).** Reads the JSONL, prints a
  per-skill rollup (invocations, p50/p99 duration, exit-reason distribution).
- **Future postgres aggregation extension** (phase B). Will subscribe to the
  same shape and upload records.

## Privacy posture

- **Local-only by default.** No outbound network calls. No upload. The file
  lives in `~/.hexxu/telemetry/` on the worker's machine, mode 0600.
- **Worker_id is the raw UUID**, not a hash. The CEO plan explicitly chose
  raw UUID + local-only as the privacy boundary (Risk #4): the UUID is
  meaningless without the worker's owned mapping; hashing it would prevent
  the worker themselves from interpreting their own data.
- **Future aggregation** (postgres in phase B, marketplace in some
  hypothetical future) requires explicit per-worker opt-in. Today's local
  JSONL is not a transport.

## Refs

- CEO plan task T7
- Locked schema in the CEO plan's "Accepted Scope" section
- Constraint #4 (manifest schema; we read `version` from frontmatter)
- Constraint #7 (identity contract; we read `HEXXU_WORKER_ID`)
- Risk #4 (telemetry privacy: local-only, 0600)
- Risk #7 (observability rot mitigation: `hexxu telemetry-summary` in T8)
