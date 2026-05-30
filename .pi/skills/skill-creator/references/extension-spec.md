# Extension Specification

Use this file when the task moves beyond pure skill writing and needs a pi-native extension design for orchestration, commands, tools, or state.

## Goal

Define the extension layer that supports `skill-creator` without pushing automation-heavy behavior into `SKILL.md`.

The extension should make skill creation easier to operate inside pi while leaving judgment, writing, and iteration strategy in the skill itself.

## Core responsibility split

### The skill owns

Keep these in `SKILL.md` and supporting references:

- intent capture
- scope definition
- frontmatter writing
- deciding what belongs in `SKILL.md` vs references vs tooling
- eval design guidance
- interpreting failures and feedback
- deciding how to improve the skill

### The extension owns

Move these into the pi extension:

- slash commands
- typed tools callable by the model
- path and workspace state
- interactive setup flows
- orchestration of SDK scripts
- progress and review convenience UI
- persistence of the current target skill/workspace

### The SDK owns

Leave these to SDK scripts:

- batch eval execution
- baseline comparison runs
- benchmarking and aggregation
- trigger optimization loops
- long-running automation jobs

## Extension scope

The extension should be useful in interactive pi sessions even before the full SDK automation exists.

That means it should:

- help initialize and remember the current target skill
- scaffold directories and starter files
- provide clear commands for later automation
- degrade gracefully when a backing SDK script is not implemented yet

## Suggested placement

If implemented as a project-local extension, use something like:

- `.pi/extensions/skill-creator/index.ts`

If implemented as a pi package later, use something like:

- `extensions/skill-creator/src/index.ts`

## V1 command set

These are the recommended first commands.

### `/skill-init`

Purpose:
- initialize or register a skill workspace

Behavior:
- ask for the target skill path if not already known
- ask whether to scaffold missing directories
- create or confirm standard directories such as:
  - skill root
  - `references/`
  - optional `scripts/`
  - optional `assets/`
  - optional `evals/`
  - optional workspace directory for generated results
- persist the selected paths in extension state

Use when:
- starting a new skill
- attaching the extension to an existing skill

### `/skill-status`

Purpose:
- show the currently active skill context

Behavior:
- display current skill path
- display workspace path
- display latest known iteration
- display last benchmark path if any
- display whether eval files are present

Use when:
- the user asks what the extension is currently targeting
- the model needs to confirm state before taking action

### `/skill-run-evals`

Purpose:
- launch eval execution for the current target skill

Behavior:
- confirm or choose iteration number
- confirm baseline mode
- invoke the SDK eval runner
- report progress and output paths
- persist the resulting iteration path

Use when:
- the skill has an eval set and the user wants runs executed

### `/skill-grade`

Purpose:
- grade a completed iteration against eval expectations

Behavior:
- choose an iteration
- invoke the grading script
- write `grading.json` files per run plus an iteration summary
- save the grading summary path in extension state

### `/skill-compare`

Purpose:
- run blind model-based comparisons for a completed iteration
- optionally compare that iteration against a previous iteration

Behavior:
- choose an iteration
- optionally choose a previous iteration
- invoke the blind-comparison script
- write per-eval blind comparison artifacts plus an iteration summary
- optionally write cross-iteration blind comparison artifacts
- save the comparison summary path in extension state

### `/skill-benchmark`

Purpose:
- aggregate a completed iteration into benchmark artifacts

Behavior:
- choose an iteration
- invoke benchmark aggregation script
- save benchmark output path in extension state
- notify the user where results were written

### `/skill-review`

Purpose:
- make review artifacts easy to locate and inspect

Behavior:
- choose an iteration
- generate a static review artifact if needed
- show the paths to the review HTML and benchmark files
- optionally provide a lightweight selector UI for iterations

V1 note:
- this does not need a full custom TUI yet

### `/skill-optimize-description`

Purpose:
- launch description-trigger evaluation and optimization

Behavior:
- verify that trigger eval input exists
- invoke the SDK optimization script
- show progress and result paths

V1 note:
- this command can exist before the full backend is implemented, as long as it fails clearly and honestly

### `/skill-set-snapshot`

Purpose:
- set or clear the snapshot skill path used for snapshot-baseline evals

Behavior:
- ask for the snapshot skill path (or clear if no input)
- validate that the path exists and contains a `SKILL.md`
- persist the selected path in extension state under `snapshotPath`
- update `preferredBaselineMode` to `snapshot` only if the user explicitly opts in

Use when:
- the user wants to compare current iterations against a known-good published version of the skill

Boundary rule:
- the extension must always pass `--snapshot-path` explicitly to the SDK; the SDK never consults extension state. Persisting it in the extension is purely so the user does not have to re-enter it.

## Optional later commands

These are useful, but not required for the first version.

### `/skill-scaffold-evals`

Generate starter eval files and a small template set.

### `/skill-compare-iterations`

Run comparison workflows between two different iterations or against a baseline snapshot.

### `/skill-package`

Validate or prepare the skill for packaging as part of a pi package.

### `/skill-review-ui`

Open a richer custom TUI review workflow once the core system is stable.

## Model-callable tools

These tools let the model use extension-backed workflow helpers without memorizing long shell commands.

## V1 tools

### `skill_creator_set_target`

Purpose:
- set or update the active target skill and workspace paths

Suggested parameters:
- `skillPath`
- `workspacePath?`
- `createMissingDirs?`

Result:
- confirms selected paths
- writes them into extension state

### `skill_creator_scaffold_skill`

Purpose:
- scaffold standard directories and starter files for a target skill

Suggested parameters:
- `skillPath`
- `includeEvals?`
- `includeScripts?`
- `includeAssets?`
- `overwrite?`

Result:
- returns created paths and skipped paths

### `skill_creator_run_evals`

Purpose:
- call the SDK eval runner for the current or specified skill

Suggested parameters:
- `skillPath?`
- `workspacePath?`
- `iteration?`
- `baselineMode?` (`none`, `without-skill`, `snapshot`)
- `evalIds?`
- `runsPerEval?`

Result:
- returns iteration path and created artifacts

### `skill_creator_generate_review`

Purpose:
- generate a review artifact for an iteration

Suggested parameters:
- `iterationPath`
- `benchmarkPath?`
- `previousIterationPath?`

Result:
- returns review artifact paths

### `skill_creator_grade_iteration`

Purpose:
- grade a completed iteration against eval expectations

Suggested parameters:
- `iterationPath`
- `skillPath?`

Result:
- returns paths to `grading-summary.json` and per-run grading artifacts

### `skill_creator_compare_iteration`

Purpose:
- run blind model-based comparisons across configurations for a completed iteration

Suggested parameters:
- `iterationPath`
- `previousIterationPath?`
- `skillPath?`

Result:
- returns the blind comparison summary path and execution details
- when a previous iteration is provided, also returns the cross-iteration summary path

### `skill_creator_aggregate_benchmark`

Purpose:
- aggregate grading and timing data into benchmark outputs

Suggested parameters:
- `iterationPath`
- `skillName?`

Result:
- returns paths to `benchmark.json` and summary output

### `skill_creator_validate_skill`

Purpose:
- validate skill structure and required files

Suggested parameters:
- `skillPath`

Result:
- returns validation status, warnings, and missing pieces

## Optional later tools

### `skill_creator_optimize_description`

Run the trigger-eval optimization loop.

### `skill_creator_compare_runs`

Compare run outputs across configurations or iterations.

### `skill_creator_open_review`

Potential future helper for launching or revealing review artifacts in a more integrated way.

## Persisted state

The extension should persist enough state that the user does not need to re-explain context every session.

## Minimum persisted state

- current target skill path
- current workspace path
- last iteration number
- last iteration path
- last grading path
- last blind comparison path
- last benchmark path
- last review artifact path
- preferred baseline mode
- snapshot skill path (required when preferred baseline mode is `snapshot`; persists across sessions so the user does not re-enter it)

## Useful optional state

- selected eval IDs from the most recent run
- whether eval scaffolding has already been created
- most recent optimization output path
- package root if the skill later becomes part of a pi package

## State rules

- state should be explicit and inspectable
- `/skill-status` should expose it clearly
- commands should allow override of persisted values
- invalid paths should be detected early and reported clearly

## Suggested event usage

The extension does not need deep event interception for V1.

Useful events:

- `session_start`
  - restore state display or show a small status notification
- `session_tree`
  - restore branch-local state if session persistence is branch-aware

Do not add complex event-driven behavior unless it clearly improves the workflow.

## UI recommendations

Start simple.

Good V1 UI patterns:

- `ctx.ui.input(...)` for missing paths
- `ctx.ui.confirm(...)` for scaffolding decisions
- `ctx.ui.select(...)` for choosing iterations or baseline modes
- `ctx.ui.notify(...)` for result summaries
- `ctx.ui.setStatus(...)` for lightweight current-target display

Avoid building a heavy custom TUI before the command and SDK flow is stable.

## Failure behavior

The extension should fail clearly rather than pretending capability it does not have.

Examples:

- if no target skill is set, say so and suggest `/skill-init`
- if an SDK script is missing, say which script is expected
- if eval files are missing, report the missing paths
- if a workspace path is invalid, stop early and explain why

## V1 implementation order

Recommended build order:

1. `/skill-init`
2. `/skill-status`
3. `skill_creator_set_target`
4. `skill_creator_scaffold_skill`
5. `/skill-run-evals` and `skill_creator_run_evals`
6. `/skill-grade` and `skill_creator_grade_iteration`
7. `/skill-compare` and `skill_creator_compare_iteration`
8. `/skill-benchmark` and `skill_creator_aggregate_benchmark`
9. `/skill-review` and `skill_creator_generate_review`
8. `/skill-optimize-description`

This order gives useful interactivity early while leaving advanced automation for later.

## Anti-patterns

Avoid these extension design mistakes:

- duplicating writing guidance that belongs in the skill
- hiding important state so the user cannot inspect it
- making commands depend on undocumented defaults
- forcing a complex TUI too early
- embedding benchmark logic directly in the extension when it belongs in SDK scripts
- making the extension pretend pi has built-in subagents

## Deliverable checklist

A good extension spec should define:

- the command set
- the model-callable tool set
- persisted state
- failure behavior
- UI level for V1
- explicit boundaries between skill, extension, and SDK responsibilities
