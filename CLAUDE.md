# hexxu

Workspace for building skills, extensions, and tools for the **pi agent**.

Hexxu is the **central brain** for the boldthemes worker fleet:

- Workers use [pi](https://github.com/earendil-works/pi-coding-agent) as their daily-driver agent harness; they pull skills + extensions from this workspace and the companion [hexxu-skills](https://github.com/boldthemes/hexxu-skills) repo
- Developers use Claude Code in parallel for skill, extension, and SDK authoring

See [`docs/designs/central-brain.md`](docs/designs/central-brain.md) for the
CEO plan that produced this shape, and `docs/architecture.md` in the
hexxu-skills repo for the seven design constraints and the A→B→C trajectory.

## Layout

| Path | Purpose |
|---|---|
| `.pi/extensions/` | Pi extensions: `hexxu-skills-sync` (T4), `hexxu-telemetry` (T7), `skill-creator` (substantial), plus utility extensions (`tps`, `redraws`, `prompt-url-widget`) |
| `.pi/sdk/skill-creator/` | Non-interactive skill-creation automation: run-evals, grade-iteration, compare-iteration, aggregate-benchmark, optimize-description, generate-review (consumed by `skill-creator` extension) |
| `.pi/sdk/prompt-evals/` | Generic prompt eval harness (consumed by `.github/workflows/prompt-evals.yml`) |
| `.pi/prompts/` | Worker prompt templates (`pr.md`, `cl.md`, `standup.md`, `wr.md`, `is.md`) |
| `.pi/skills/` | Source for the five originally-authored skills, migrated to `boldthemes/hexxu-skills` via T6 grandfather migration |
| `cli/` | Worker CLI(s): `telemetry-summary` (T8) reads local hexxu-telemetry JSONL and prints a rollup |
| `test/` | E2E acceptance harness (T10): `./test/e2e.sh` exercises the full sync+telemetry+CLI loop, plus `--ci` for live identity-drift gate verification |
| `evals/prompts/` | Prompt eval cases consumed by `.pi/sdk/prompt-evals/` |
| `docs/designs/` | Design docs; CEO plans land here when promoted by `/plan-ceo-review` |

## Locally ignored

These dirs are present on the workstation but not tracked:

- `pisource/` — upstream pi agent source, own `.git`, reference-only (re-clone from `earendil-works/pi-coding-agent` if you need it)
- `inspiration/` — reference material for authoring; not hexxu content
- `skill-workspaces/` — eval working state, regenerable
- `.claude/skills/` — Claude Code project-local skills; kept workstation-local by design (T12 publishing decision)
- `.git.pi-fork-archive/` — preserved-but-untracked legacy history from when hexxu was a pi-coding-agent fork
- `.hexxu/` — local cache (sync state, telemetry JSONL); per-worker, never tracked

## Worker setup

Workers don't clone hexxu directly — they install via the steps in
[`hexxu-skills/docs/onboarding.md`](https://github.com/boldthemes/hexxu-skills/blob/main/docs/onboarding.md).
The onboarding flow copies the extension dirs and the CLI from a hexxu
checkout into `~/.pi/agent/extensions/` and `~/.hexxu/bin/` respectively.
A future `hexxu` onboarding CLI will collapse this into one command (see
[`hexxu-skills/TODOS.md`](https://github.com/boldthemes/hexxu-skills/blob/main/TODOS.md) item #4).

## Developer setup

Developers cloning hexxu to author skills, extensions, or SDK scripts:

```bash
git clone git@github.com:boldthemes/hexxu.git
cd hexxu
# Optional: clone pi-coding-agent for source reference
git clone https://github.com/earendil-works/pi-coding-agent.git pisource
```

The `pisource/` clone is reference-only (already gitignored). Pi extension
typings flow from the bundled `@earendil-works/pi-coding-agent` package
when pi loads each extension; no local install of pi-coding-agent is
required to author against the types.

## gstack

[gstack](https://github.com/garrytan/gstack) is installed globally at
`~/.claude/skills/gstack` in **team mode** (auto-updates on each Claude
Code session start). To opt this repo into the team workflow run
`~/.claude/skills/gstack/bin/gstack-team-init required` from the project
root.

## Repos in the boldthemes hexxu family

- **[boldthemes/hexxu](https://github.com/boldthemes/hexxu)** — this repo: extensions, SDK, CLI, prompts, tests
- **[boldthemes/hexxu-skills](https://github.com/boldthemes/hexxu-skills)** — central skill registry; workers' pi installs sync from here every session start
