#!/usr/bin/env bash
# e2e.sh — end-to-end acceptance tests for the hexxu central brain
#
# Covers CEO-plan acceptance criteria (a)-(f). Each test is isolated via env
# vars pointing at /tmp scratch dirs so this script never mutates the user's
# real ~/.hexxu state or ~/.pi/agent/skills/central mount.
#
# Usage:
#   ./test/e2e.sh           # runs (a)-(e); skips (f) by default
#   ./test/e2e.sh --ci      # also runs (f): creates a real test PR with a
#                           # deliberate violation, asserts identity-drift CI
#                           # fails, then closes the PR. Requires gh auth.
#   ./test/e2e.sh -v        # verbose (show subprocess stdout/stderr)
#
# Exit code: 0 if all run tests pass, non-zero if any fail or error out.

set -u  # don't `set -e` — individual tests handle their own failures.

# ----- knobs --------------------------------------------------------------

VERBOSE=0
RUN_CI=0
for arg in "$@"; do
  case "$arg" in
    -v|--verbose) VERBOSE=1 ;;
    --ci) RUN_CI=1 ;;
    -h|--help)
      sed -n '2,16p' "$0" | sed 's|^# \?||'
      exit 0 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

HEXXU_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRATCH=$(mktemp -d /tmp/hexxu-e2e.XXXXXXXX)
LOG_DIR="$SCRATCH/logs"
mkdir -p "$LOG_DIR"

# Isolation: point every hexxu env var at a scratch path so we don't touch
# the user's real state.
export HEXXU_SKILLS_CACHE_DIR="$SCRATCH/skills-cache"
export HEXXU_SKILLS_MOUNT="$SCRATCH/mount/central"
export HEXXU_TELEMETRY_DIR="$SCRATCH/telemetry"
export HEXXU_TELEMETRY_FILE="$HEXXU_TELEMETRY_DIR/telemetry.jsonl"
# Use the rmackovic UUID for tests (it's the same shape any worker would use)
export HEXXU_WORKER_ID="${HEXXU_WORKER_ID:-7247f12e-dfe7-4e49-96c4-aec989093938}"

cleanup() {
  local rc=$?
  rm -rf "$SCRATCH" 2>/dev/null
  exit "$rc"
}
trap cleanup EXIT INT TERM

# Reset all sync extension state (cache, mount, AND the sibling state file).
# The state file lives in the parent of HEXXU_SKILLS_CACHE_DIR by design — a
# stale cache wipe shouldn't lose sync history in production, but tests need
# a fully fresh state to exercise cold-start paths.
reset_sync_state() {
  rm -rf "$HEXXU_SKILLS_CACHE_DIR" "$(dirname "$HEXXU_SKILLS_MOUNT")" 2>/dev/null
  rm -f "$(dirname "$HEXXU_SKILLS_CACHE_DIR")/skills-sync-state.json" 2>/dev/null
}

# Reset telemetry state.
reset_telemetry_state() {
  rm -f "$HEXXU_TELEMETRY_FILE" 2>/dev/null
}

# ----- helpers ------------------------------------------------------------

PASS=0
FAIL=0
SKIP=0

pass() { printf "  \033[32m✓ PASS\033[0m  %s\n" "$1"; PASS=$((PASS+1)); }
fail() { printf "  \033[31m✗ FAIL\033[0m  %s\n" "$1"; if [ -n "${2:-}" ]; then printf "         %s\n" "$2"; fi; FAIL=$((FAIL+1)); }
skip() { printf "  \033[33m- SKIP\033[0m  %s\n" "$1"; SKIP=$((SKIP+1)); }
header() { printf "\n\033[1m%s\033[0m\n" "$1"; }
sub() { [ "$VERBOSE" = "1" ] && printf "    %s\n" "$1" || true; }

# Run pi briefly in non-interactive mode. Returns when pi exits or after timeout.
# Captures stdout+stderr to a log file.
run_pi_brief() {
  local logfile="$1"
  shift
  local extra_env="${1:-}"  # e.g., "HEXXU_SKILLS_URL=bad-url HEXXU_SKILLS_STALENESS_S=0"
  shift 2>/dev/null || true
  (
    cd "$HEXXU_ROOT"
    if [ -n "$extra_env" ]; then
      env $extra_env pi -p "test" --no-tools >"$logfile" 2>&1 &
    else
      pi -p "test" --no-tools >"$logfile" 2>&1 &
    fi
    local pid=$!
    sleep 6
    kill -TERM "$pid" 2>/dev/null
    sleep 1
    kill -9 "$pid" 2>/dev/null
    wait "$pid" 2>/dev/null || true
  )
}

# Read the JSONL file with python and assert all 6 locked fields exist
assert_telemetry_record_shape() {
  local file="$1"
  python3 - "$file" <<'PYEOF'
import json, sys
path = sys.argv[1]
required = {"event_at", "worker_id", "session_id", "skills_invoked", "duration_ms", "exit_reason"}
with open(path) as f:
    lines = [l for l in f if l.strip()]
if not lines:
    print("NO_RECORDS")
    sys.exit(2)
rec = json.loads(lines[-1])
missing = required - rec.keys()
if missing:
    print("MISSING:" + ",".join(sorted(missing)))
    sys.exit(3)
if not isinstance(rec["skills_invoked"], list):
    print("BAD_TYPE:skills_invoked")
    sys.exit(4)
print("OK")
PYEOF
}

# Read latest record value (for verifying worker_id, exit_reason, etc.)
read_telemetry_field() {
  local file="$1"
  local field="$2"
  python3 - "$file" "$field" <<'PYEOF'
import json, sys
path, field = sys.argv[1], sys.argv[2]
with open(path) as f:
    lines = [l for l in f if l.strip()]
if not lines:
    print(""); sys.exit(2)
print(json.loads(lines[-1]).get(field, ""))
PYEOF
}

# ----- guards -------------------------------------------------------------

header "Preflight"
if ! command -v pi >/dev/null; then
  echo "  ERROR: pi not installed" >&2; exit 2
fi
if ! command -v python3 >/dev/null; then
  echo "  ERROR: python3 not installed" >&2; exit 2
fi
if ! command -v node >/dev/null; then
  echo "  ERROR: node not installed" >&2; exit 2
fi
if [ ! -d "$HEXXU_ROOT/.pi/extensions/hexxu-skills-sync" ]; then
  echo "  ERROR: hexxu-skills-sync extension not found at $HEXXU_ROOT/.pi/extensions/" >&2; exit 2
fi
if [ ! -d "$HEXXU_ROOT/.pi/extensions/hexxu-telemetry" ]; then
  echo "  ERROR: hexxu-telemetry extension not found at $HEXXU_ROOT/.pi/extensions/" >&2; exit 2
fi
if [ ! -f "$HEXXU_ROOT/cli/telemetry-summary.ts" ]; then
  echo "  ERROR: telemetry-summary CLI not found" >&2; exit 2
fi
echo "  pi: $(pi --version 2>/dev/null | head -1)"
echo "  scratch: $SCRATCH"
echo "  worker_id: $HEXXU_WORKER_ID"

# ----- (a) cold-start clones cleanly --------------------------------------

header "(a) cold-start: hexxu/skills clones cleanly into the configured mount"

reset_sync_state
LOG="$LOG_DIR/a-cold-start.log"
run_pi_brief "$LOG"
sub "log: $LOG"

# Check the sync extension ran successfully
if grep -q 'hexxu-skills-sync: synced [1-9][0-9]* skill' "$LOG"; then
  pass "sync extension reports non-zero skill count"
else
  fail "sync extension did not report non-zero skill count" "$(grep hexxu-skills-sync "$LOG" || echo "no extension output found")"
fi

# Check the cache directory was populated
if [ -d "$SCRATCH/skills-cache/.git" ]; then
  pass "cache directory cloned (.git present)"
else
  fail "cache directory missing or no .git inside"
fi

# Check the mount symlink points at the cache's skills/ subdir
if [ -L "$SCRATCH/mount/central" ]; then
  target=$(readlink "$SCRATCH/mount/central")
  if [ "$target" = "$SCRATCH/skills-cache/skills" ]; then
    pass "mount symlink points at cache/skills"
  else
    fail "mount symlink wrong target" "expected $SCRATCH/skills-cache/skills, got $target"
  fi
else
  fail "mount is not a symlink"
fi

# Check at least one skill is visible through the mount
skill_count=$(ls -d "$SCRATCH/mount/central"/*/ 2>/dev/null | wc -l | tr -d ' ')
if [ "$skill_count" -ge 1 ]; then
  pass "at least one skill visible through mount ($skill_count found)"
else
  fail "no skills visible through mount"
fi

# ----- (b) cold-start fail-open when GitHub unreachable -------------------

header "(b) cold-start with GitHub unreachable: pi starts with no central skills + warning, does NOT block"

reset_sync_state
LOG="$LOG_DIR/b-cold-fail.log"
# Use a definitely-unreachable host (RFC 2606 reserved .invalid TLD)
run_pi_brief "$LOG" "HEXXU_SKILLS_URL=https://nonexistent.invalid/repo.git"
sub "log: $LOG"

# Pi should have started and exited normally (we sent it SIGTERM after 6s, exit 143)
if [ -f "$LOG" ] && grep -q 'hexxu-skills-sync:' "$LOG"; then
  pass "pi started (extension output present)"
else
  fail "pi did NOT start (or extension didn't run)" "$(head -10 "$LOG" 2>/dev/null)"
fi

# Sync should have warned
if grep -q 'hexxu-skills-sync:.*sync failed' "$LOG" || grep -q 'hexxu-skills-sync:.*cold-start failed' "$LOG"; then
  pass "sync failure was reported as a warning (not silent)"
else
  fail "no sync-failure warning observed" "$(grep hexxu-skills-sync "$LOG" || echo "no extension output")"
fi

# Cache should NOT have been populated (cold-start failed)
if [ ! -d "$SCRATCH/skills-cache/.git" ]; then
  pass "cache stays empty after failed cold-start (no .git inside)"
else
  fail "cache unexpectedly populated despite failed clone"
fi

# Pi exited cleanly (not via crash signal from us, but having reached session_shutdown).
# Telemetry record presence proves session_shutdown fired = pi didn't block.
if [ -f "$HEXXU_TELEMETRY_FILE" ] && [ -s "$HEXXU_TELEMETRY_FILE" ]; then
  pass "pi session reached session_shutdown (telemetry record exists)"
else
  fail "no telemetry record: pi may have blocked or crashed before session_shutdown"
fi

# ----- (c) telemetry record shape + perms ---------------------------------

header "(c) telemetry record has all 6 locked schema fields + mode 0600"

# Re-run cold-start with a working URL to populate cache so subsequent tests have data
reset_sync_state
reset_telemetry_state
LOG="$LOG_DIR/c-real-session.log"
run_pi_brief "$LOG"
sub "log: $LOG"

if [ ! -f "$HEXXU_TELEMETRY_FILE" ]; then
  fail "telemetry file not created" "$(grep hexxu-telemetry "$LOG" || echo "no extension output")"
else
  # Schema check
  result=$(assert_telemetry_record_shape "$HEXXU_TELEMETRY_FILE")
  if [ "$result" = "OK" ]; then
    pass "all 6 locked fields present in last record"
  else
    fail "telemetry record schema check failed" "$result"
  fi

  # Mode check
  mode=$(stat -c "%a" "$HEXXU_TELEMETRY_FILE")
  if [ "$mode" = "600" ]; then
    pass "telemetry file mode is 0600"
  else
    fail "telemetry file mode is $mode (expected 600)"
  fi

  # worker_id check
  wid=$(read_telemetry_field "$HEXXU_TELEMETRY_FILE" "worker_id")
  if [ "$wid" = "$HEXXU_WORKER_ID" ]; then
    pass "worker_id in record matches HEXXU_WORKER_ID env var"
  else
    fail "worker_id mismatch" "got '$wid', expected '$HEXXU_WORKER_ID'"
  fi

  # exit_reason check
  reason=$(read_telemetry_field "$HEXXU_TELEMETRY_FILE" "exit_reason")
  if [ -n "$reason" ]; then
    pass "exit_reason populated ('$reason')"
  else
    fail "exit_reason empty in record"
  fi
fi

# NOTE: skills_invoked != [] is NOT asserted here because pi --no-tools
# disables Read, so the sync-loaded skills are never actually triggered. A
# real interactive session with model API access would populate this. Adding
# a synthetic-record assertion path below for the CLI test.

# ----- (d) sync resilience after first success ----------------------------

header "(d) sync resilience: cache survives a subsequent fetch failure"

# We have a populated cache from (c). To force a fetch failure on the existing
# cache (HEXXU_SKILLS_URL only affects fresh clones — `git fetch` reads the
# remote URL from the cache's own .git/config), break the cache's origin URL.
git -C "$SCRATCH/skills-cache" remote set-url origin https://nonexistent.invalid/repo.git
sha_before=$(git -C "$SCRATCH/skills-cache" rev-parse HEAD 2>/dev/null || echo "BEFORE-UNKNOWN")
skills_before=$(ls -d "$SCRATCH/mount/central"/*/ 2>/dev/null | wc -l | tr -d ' ')
LOG="$LOG_DIR/d-fetch-fail.log"
run_pi_brief "$LOG" "HEXXU_SKILLS_STALENESS_S=0"
sub "log: $LOG"

sha_after=$(git -C "$SCRATCH/skills-cache" rev-parse HEAD 2>/dev/null || echo "AFTER-UNKNOWN")
skills_after=$(ls -d "$SCRATCH/mount/central"/*/ 2>/dev/null | wc -l | tr -d ' ')

if [ "$sha_before" = "$sha_after" ]; then
  pass "cache HEAD unchanged after failed fetch ($sha_before)"
else
  fail "cache HEAD changed despite failed fetch" "before=$sha_before after=$sha_after"
fi

if [ "$skills_before" = "$skills_after" ] && [ "$skills_after" -gt 0 ]; then
  pass "cached skills still visible through mount ($skills_after)"
else
  fail "cached skills lost after failed fetch" "before=$skills_before after=$skills_after"
fi

if grep -q 'hexxu-skills-sync:.*sync failed' "$LOG"; then
  pass "fetch failure was reported as a warning"
else
  fail "no fetch-failure warning observed" "$(grep hexxu-skills-sync "$LOG" || echo "no extension output")"
fi

# ----- (e) CLI summarizes the real telemetry from (c) ---------------------

header "(e) hexxu-telemetry-summary reads the telemetry file and reports correctly"

CLI="$HEXXU_ROOT/cli/telemetry-summary.ts"
LOG="$LOG_DIR/e-cli.log"
node --experimental-strip-types "$CLI" --since 1h --format json --file "$HEXXU_TELEMETRY_FILE" >"$LOG" 2>&1
rc=$?

if [ "$rc" = "0" ]; then
  pass "CLI exited 0"
else
  fail "CLI exited $rc" "$(cat "$LOG")"
fi

# Sessions in period should be >= 1 (we ran multiple pi sessions above)
sessions_in_period=$(python3 -c "import json,sys; print(json.load(open('$LOG'))['sessions_in_period'])" 2>/dev/null || echo "ERR")
if [ "$sessions_in_period" != "ERR" ] && [ "$sessions_in_period" -ge 1 ]; then
  pass "sessions_in_period >= 1 ($sessions_in_period)"
else
  fail "sessions_in_period unexpectedly 0 or unparseable" "$sessions_in_period"
fi

# Now test the skill-invocation rendering path with a synthetic record
# (because --no-tools mode never actually invokes a skill). This validates
# the CLI's aggregation logic; the live-session skill-invocation path is
# validated separately when the worker runs an interactive session.
SYN="$SCRATCH/synthetic-telem.jsonl"
cat > "$SYN" <<EOF
{"event_at":"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)","worker_id":"$HEXXU_WORKER_ID","session_id":"e2e-syn-001","skills_invoked":[{"name":"meeting-action-items","version":"0.1.0"},{"name":"csv-to-markdown-converter","version":"0.1.0"}],"duration_ms":12340,"exit_reason":"quit"}
EOF
SYN_OUT="$SCRATCH/synthetic-cli-out.json"
node --experimental-strip-types "$CLI" --since 1h --format json --file "$SYN" > "$SYN_OUT" 2>&1
syn_rc=$?
if [ "$syn_rc" != "0" ]; then
  fail "CLI errored on synthetic record (exit $syn_rc)" "$(cat "$SYN_OUT")"
else
  inv=$(python3 -c "
import json
d = json.load(open('$SYN_OUT'))
skills = {s['name']: s['invocations'] for s in d.get('skills', [])}
print(skills.get('meeting-action-items', 0))
" 2>/dev/null || echo "ERR")
  if [ "$inv" = "1" ]; then
    pass "CLI reports skills_invoked counts correctly (synthetic record, meeting-action-items=1)"
  else
    fail "CLI skill aggregation wrong" "expected meeting-action-items=1, got $inv. Full output:
$(cat "$SYN_OUT")"
  fi
fi

# ----- (f) identity-drift CI gates a deliberate violation -----------------

header "(f) identity-drift CI workflow blocks a deliberate violation"

if [ "$RUN_CI" != "1" ]; then
  skip "use --ci to run; creates a real test PR (closes without merging)"
else
  if ! command -v gh >/dev/null; then
    skip "gh not installed; cannot run CI test"
  else
    SKILLS_REPO=$(mktemp -d /tmp/hexxu-e2e-skills.XXXXXX)
    # Clone via SSH so the push uses the deploy key that worked for the rest
    # of T1-T9. HTTPS clone would push-fail without credentials.
    clone_log="$LOG_DIR/f-clone.log"
    if ! git clone git@github.com:boldthemes/hexxu-skills.git "$SKILLS_REPO" --depth 1 >"$clone_log" 2>&1; then
      fail "could not clone hexxu-skills via SSH" "$(cat "$clone_log")"
    else
      cd "$SKILLS_REPO"
      BRANCH="e2e-violation-$(date +%s)-$$"
      git checkout -b "$BRANCH" >/dev/null 2>&1
      if [ ! -f "skills/csv-to-markdown-converter/SKILL.md" ]; then
        fail "test skill csv-to-markdown-converter/SKILL.md missing — T6 unmerged?"
      else
        printf "\n<!-- E2E test marker: whoami should fail this CI -->\n" >> skills/csv-to-markdown-converter/SKILL.md
        git add skills/csv-to-markdown-converter/SKILL.md
        git -c user.email="e2e@hexxu-test.invalid" -c user.name="hexxu e2e" \
          commit -m "E2E TEST: deliberate identity-drift violation (do not merge)" >/dev/null 2>&1

        push_log="$LOG_DIR/f-push.log"
        if ! git push -u origin "$BRANCH" >"$push_log" 2>&1; then
          fail "could not push test branch" "$(cat "$push_log")"
        else
          sub "Pushed $BRANCH; opening PR..."
          pr_log="$LOG_DIR/f-pr.log"
          pr_url=$(gh pr create --base main --head "$BRANCH" \
            --title "[E2E] identity-drift gate verification (auto-closes)" \
            --body "Deliberate identity-drift violation. CI MUST fail. PR will be auto-closed by the e2e harness." \
            2>"$pr_log" | tail -1)
          pr_num=$(echo "$pr_url" | grep -oE 'pull/[0-9]+' | grep -oE '[0-9]+')
          if [ -z "$pr_num" ]; then
            fail "could not open PR" "$(cat "$pr_log")"
          else
            sub "Test PR: $pr_url (#$pr_num)"
            # Poll up to 3 minutes for CI to complete. gh 2.4.0 doesn't support
            # --json on `gh pr checks`, so we parse the tab-separated text:
            # columns are NAME, CONCLUSION (pass/fail/pending), DURATION, URL.
            final_status=""
            last_status=""
            for i in $(seq 1 36); do
              sleep 5
              raw=$(gh pr checks "$pr_num" 2>/dev/null || true)
              # Convert to "name=conclusion" pairs for display, drop empty lines
              last_status=$(printf '%s\n' "$raw" | awk -F'\t' 'NF>=2 {printf "%s=%s;", $1, $2}')
              sub "  poll $i: ${last_status:-no-output}"
              if echo "$last_status" | grep -qE '=fail|=failure|=cancelled|=timed_out'; then
                final_status="failure"
                break
              fi
              if echo "$last_status" | grep -qE '=pass|=success' && ! echo "$last_status" | grep -qE '=pending|=queued|=in_progress|=waiting'; then
                final_status="success"
                break
              fi
            done
            if [ "$final_status" = "failure" ]; then
              pass "identity-drift CI FAILED as expected ($last_status)"
            elif [ "$final_status" = "success" ]; then
              fail "identity-drift CI PASSED when it should have failed" "$last_status"
            else
              fail "CI did not complete within 3 minutes" "last status: $last_status"
            fi
            # Always close the test PR, never merge
            gh pr close "$pr_num" --comment "E2E test complete; closing without merging." --delete-branch >/dev/null 2>&1
            sub "Closed PR #$pr_num and deleted branch"
          fi
        fi
      fi
      cd /
      rm -rf "$SKILLS_REPO"
    fi
  fi
fi

# ----- summary ------------------------------------------------------------

header "Summary"
printf "  %d passed, %d failed, %d skipped\n" "$PASS" "$FAIL" "$SKIP"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
