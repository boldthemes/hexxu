# hexxu-skills-sync

Pi extension that syncs the central hexxu skills registry into a worker's local
pi skills directory on session start.

## Install

Today (development, no extension registry yet): drop this directory into either
of pi's extension search paths:

```
# project-local (loaded when running pi from this project)
<cwd>/.pi/extensions/hexxu-skills-sync/

# global (loaded from any cwd)
~/.pi/agent/extensions/hexxu-skills-sync/
```

Pi auto-discovers extensions at startup; no registration step.

Worker bootstrap until the onboarding CLI exists (T9):

```bash
mkdir -p ~/.pi/agent/extensions
cp -r /path/to/hexxu/.pi/extensions/hexxu-skills-sync \
  ~/.pi/agent/extensions/hexxu-skills-sync
```

Once `hexxu-onboarding-cli` ships (deferred TODOS item), this becomes a single
`npx hexxu onboard` invocation.

## Configuration

All env vars are optional with sensible defaults.

| Var | Default | Notes |
|---|---|---|
| `HEXXU_SKILLS_URL` | `https://github.com/boldthemes/hexxu-skills.git` | Constraint #3: never hard-coded; configurable here |
| `HEXXU_SKILLS_CACHE_DIR` | `~/.hexxu/skills-cache` | Local git clone target |
| `HEXXU_SKILLS_MOUNT` | `~/.pi/agent/skills/central` | Symlink target inside pi's skills dir |
| `HEXXU_SKILLS_STALENESS_S` | `300` | Min seconds between automatic syncs |
| `HEXXU_SKILLS_DISABLED` | (unset) | Set to `1`/`true`/`yes` to skip sync entirely |

## What it does

On every pi `session_start`:

1. If `HEXXU_SKILLS_DISABLED` is set: skip (info log).
2. If the last successful sync is younger than the staleness cutoff: skip the
   git fetch, but still ensure the mount symlink is in place.
3. Else: `git clone --depth 1` (cold-start) or `git fetch + reset --hard
   FETCH_HEAD` (incremental).
4. On success: symlink `cacheDir/skills` into `~/.pi/agent/skills/central` so
   pi's skill loader sees them on the next session. On Windows this is a
   directory **junction** (no Admin/Developer Mode needed); POSIX uses a
   symlink with an atomic rename-swap.
5. Persist last sync status to `~/.hexxu/skills-sync-state.json`.

The sync runs **async** so it never blocks the session start. Failures WARN to
stderr and to the pi UI (when available), then return. Cold-start failure with
no cache yet = pi starts with no central skills + a visible warning. Constraint
#5 (offline-first / fail-open).

## Commands

The extension registers two pi slash commands:

- `/sync-skills` — Force-sync now, bypassing the 5-min staleness cache.
- `/sync-skills-status` — Print the last sync result (age, status, head SHA,
  message).

## State file

`~/.hexxu/skills-sync-state.json`:

```json
{
  "last_sync_at": 1780161187772,
  "last_sync_status": "success",
  "last_sync_message": "synced 7 skills @ a1b2c3d",
  "head_sha": "a1b2c3d..."
}
```

Lives in the parent of the cache dir so a `rm -rf ~/.hexxu/skills-cache` doesn't
also drop the sync history.

## Failure modes (by design)

| Condition | Behavior |
|---|---|
| `HEXXU_SKILLS_DISABLED=1` | Skip; info log |
| Cache fresh (< staleness cutoff) | Skip fetch; still ensure mount |
| Cold-start + GitHub reachable | Clone; mount; success state |
| Cold-start + GitHub unreachable | Warn; no skills; fail-open per constraint #5 |
| Cold-start + central repo has no `skills/` dir | Info (not warn): "registry has no skills/ directory yet" — expected during T1-T5 bootstrap before T6 lands |
| Incremental + GitHub unreachable | Warn; keep last cached skills mounted |
| Mount point exists as real dir (not symlink/junction) | Warn; do NOT destroy worker-local content; leave mount alone |
| State file corrupted | Treat as no state; full sync next run |

## How this defends against prompt injection (Risk #6)

Workers' pi sessions load skills as system prompts. The defense against a
compromised committer injecting malicious instructions has two layers:

1. **Upstream:** branch protection on `boldthemes/hexxu-skills` `main` with
   required PR + 1 review and no bypass (T1). Direct push rejected.
2. **Downstream (this extension):** workers never invoke arbitrary code from
   the central repo. They only sync markdown files; the sync extension itself
   never `eval`s anything from the repo. Worst case for a committed malicious
   skill: a single PR slipped through review and lands on workers. The fix is
   to revert the PR centrally and the next sync (or `/sync-skills`) propagates
   the revert.

The eval-gate (deferred to TODOS, revived when contributors > 1) adds a third
layer at the upstream side.

## Refs

- CEO plan task T4
- CEO plan design constraints #3 and #5
- CEO plan Risk #6 mitigation
- `/home/macak/Development/hexxu/docs/designs/central-brain.md` in the parent project
