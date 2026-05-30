# hexxu

Central platform for the boldthemes worker fleet. Pi extensions, skill-creation SDK, worker CLIs, prompt templates, and the e2e test harness.

Paired with [hexxu-skills](https://github.com/boldthemes/hexxu-skills) — workers' pi installs sync skill content from `hexxu-skills` and load extensions + CLI from here.

## What's here

| Directory | Contents |
|---|---|
| `.pi/extensions/` | Pi extensions installed into workers' `~/.pi/agent/extensions/`: `hexxu-skills-sync` (pulls central skills on session start), `hexxu-telemetry` (one JSONL record per session, mode 0600), `skill-creator` (dev-side skill authoring), plus utility extensions |
| `.pi/sdk/skill-creator/` | Non-interactive automation for skill creation: run-evals, grade-iteration, compare-iteration, aggregate-benchmark, optimize-description, generate-review |
| `.pi/sdk/prompt-evals/` | Generic prompt eval harness; CI runs via `.github/workflows/prompt-evals.yml` |
| `.pi/prompts/` | Worker prompt templates (`pr`, `cl`, `standup`, `wr`, `is`) |
| `.pi/skills/` | **NOT TRACKED** — gitignored symlink to a local `hexxu-skills/skills/` checkout. Skills source-of-truth is [boldthemes/hexxu-skills](https://github.com/boldthemes/hexxu-skills). See "Install (developer)" below for the symlink convention. |
| `cli/` | Worker CLI: `hexxu-telemetry-summary` reads local JSONL and prints a per-skill rollup |
| `test/` | E2E harness exercising sync + telemetry + CLI + identity-drift CI |

## Install (worker)

Workers follow [hexxu-skills/docs/onboarding.md](https://github.com/boldthemes/hexxu-skills/blob/main/docs/onboarding.md). It bootstraps:

- `HEXXU_WORKER_ID` UUID v4 in shell profile (constraint #7)
- `~/.pi/agent/extensions/hexxu-skills-sync/` copied from this repo
- `~/.pi/agent/extensions/hexxu-telemetry/` copied from this repo
- `~/.hexxu/bin/hexxu-telemetry-summary` symlinked from this repo's `cli/`
- A first-session verification checklist

A future `hexxu` onboarding CLI ([hexxu-skills TODO #4](https://github.com/boldthemes/hexxu-skills/blob/main/TODOS.md)) will collapse this into one command.

## Install (developer)

```bash
# Clone both repos as siblings (relative symlink convention)
git clone git@github.com:boldthemes/hexxu.git
git clone git@github.com:boldthemes/hexxu-skills.git
cd hexxu

# Project-local skills symlink (gitignored). Pi running from this workspace
# picks up the live skill registry content from your hexxu-skills checkout.
ln -s ../../hexxu-skills/skills .pi/skills

# Optional: clone pi-coding-agent as a reference (gitignored)
git clone https://github.com/earendil-works/pi-coding-agent.git pisource
```

The `.pi/skills` symlink depends on the sibling layout. If you keep your
hexxu-skills checkout at a different path, point the symlink at your
actual location.

Read [CLAUDE.md](CLAUDE.md) for the full developer layout.

## E2E tests

```bash
./test/e2e.sh           # default: tests (a)-(e) offline, ~30s
./test/e2e.sh --ci      # also runs (f): live identity-drift CI gate test (creates a real test PR, asserts CI fails, closes the PR)
./test/e2e.sh -v        # verbose; show subprocess logs
```

The harness uses scratch dirs under `/tmp/hexxu-e2e.*` for isolation; it doesn't touch your real `~/.hexxu/` or `~/.pi/agent/skills/central` mount.

## Design constraints

The seven design constraints that keep the A→B→C trajectory open live in [`hexxu-skills/CLAUDE.md`](https://github.com/boldthemes/hexxu-skills/blob/main/CLAUDE.md) and are the contract every extension and SDK script in this repo must honor (no ad-hoc identity, configurable URLs, manifest schema, offline-first, etc.).

## License

Currently unlicensed (private boldthemes infrastructure). License decision deferred until the first external contribution is contemplated.
