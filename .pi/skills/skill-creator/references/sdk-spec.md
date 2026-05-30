# SDK Specification

Use this file when the task needs the non-interactive automation layer behind `skill-creator`.

## Goal

Define the SDK-based automation that supports the skill and extension without pushing batch execution, benchmarking, or trigger optimization into `SKILL.md`.

This layer should run pi programmatically and produce structured outputs that the extension and skill can consume.

## Core responsibility split

### The skill owns

- judgment and writing guidance
- skill drafting and revision strategy
- eval design guidance
- interpretation of results
- deciding how to improve the skill

### The extension owns

- slash commands
- typed tools
- interactive setup
- path and workspace state
- invoking SDK scripts from a pi session

### The SDK owns

- isolated pi runs
- eval batch execution
- baseline comparisons
- benchmark aggregation inputs and outputs
- trigger optimization loops
- machine-readable artifacts for later review

## Implementation principle

The SDK layer should use pi's programmatic APIs rather than Claude-specific CLI assumptions.

Prefer:

- `createAgentSession()`
- `DefaultResourceLoader`
- explicit session configuration
- structured filesystem outputs

Avoid designing the system around:

- `claude -p`
- built-in subagent assumptions
- harness-specific task notifications

## Suggested script set

A good first SDK layer should expose these scripts.

### `run-evals`

Purpose:
- execute one eval set against a target skill, optionally with baselines

### `grade-iteration`

Purpose:
- grade completed run artifacts against eval expectations and produce comparison summaries

### `compare-iteration`

Purpose:
- run blind model-based comparisons across completed iteration outputs and write summary artifacts

### `aggregate-benchmark`

Purpose:
- aggregate run results into benchmark artifacts

### `generate-review`

Purpose:
- build a review artifact from iteration outputs and benchmarks

### `optimize-description`

Purpose:
- run trigger evals and improve frontmatter descriptions

### Optional later: `compare-runs`

Purpose:
- compare outputs across versions or configurations using a structured rubric flow

## Common design requirements

All scripts should:

- accept explicit paths rather than relying on hidden global state
- write machine-readable artifacts to disk
- print clear summary output to stdout
- fail with actionable errors
- be usable from both the extension and the shell

## Directory model

Use a stable workspace layout so both extension and human users can inspect outputs.

Suggested pattern:

```text
<workspace>/
├── evals/
│   └── evals.json
├── iteration-1/
│   ├── eval-001/
│   │   ├── with-skill/
│   │   ├── without-skill/
│   │   └── snapshot/
│   ├── benchmark.json
│   └── review.html
└── iteration-2/
```

The structure must be stable and discoverable across every script and the extension.

**Directory naming convention (canonical):** all configuration directories use the lowercase, hyphen-separated form `with-skill`, `without-skill`, `snapshot`. The existing `run-evals` implementation produces these names; downstream consumers (`aggregate-benchmark`, `compare-iteration`, `generate-review`) and the extension must read them by the same names. Divergence (for example `with_skill`, `old-skill`) silently breaks path resolution because the discovery layer walks directories by name. Lock the convention here; do not introduce variants without updating every consumer in the same change.

## Script: `run-evals`

## Purpose

Run a set of prompts against:

- the target skill
- optionally no skill
- optionally a previous snapshot

and save structured outputs.

## Inputs

Suggested CLI inputs:

- `--skill-path`
- `--workspace`
- `--eval-set`
- `--iteration`
- `--baseline-mode` (`none`, `without-skill`, `snapshot`)
- `--snapshot-path` when needed
- `--eval-ids` optional subset
- `--runs-per-eval`
- `--cwd`
- `--model`
- `--thinking`

## Behavior

For each selected eval:

1. create an eval directory for the iteration
2. run a pi session with the target skill available
3. save transcript, outputs, and metadata
4. if baseline mode is enabled, run the baseline configuration too
5. write a summary file for the eval

## Execution model

### V1

- serial execution is acceptable
- simple, reliable, easier to debug

### Later

- optional parallel execution via separate processes
- still not treated as a built-in pi subagent feature

## Resource loading strategy

The script should control what resources are visible in each run.

Recommended approach:

- with-skill run: load the target skill explicitly
- without-skill run: do not load the target skill
- snapshot run: load only the snapshot skill path instead of the current one

Do not rely on ambient skill discovery alone when correctness matters.

## Outputs per run

Suggested run directory:

```text
<eval-dir>/<configuration>/
├── transcript.md
├── outputs/
├── metrics.json
├── timing.json
└── run.json
```

### `transcript.md`

Human-readable transcript or event summary.

### `outputs/`

Files produced by the run, if any.

### `metrics.json`

Structured metrics such as:

- tool call counts if available
- output size
- file list
- error count

### `timing.json`

Structured wall-clock timing.

### `run.json`

High-level metadata such as:

- skill path used
- configuration name
- model
- thinking level
- eval id
- prompt
- success/failure status

## Suggested eval metadata file

Each eval directory should also contain a small descriptor, for example:

```json
{
  "eval_id": "001",
  "eval_name": "core-skill-draft",
  "prompt": "Create a pi skill for ...",
  "configuration": ["with-skill", "without-skill"]
}
```

## Metrics strategy

V1 metrics do not need to be perfect.

Useful first metrics:

- start time / end time
- duration
- output file count
- output character counts
- whether errors occurred

Later, if session event instrumentation exists, add:

- tool counts
- message counts
- skill-use indicators

## Script: `grade-iteration`

## Purpose

Grade completed run artifacts against the eval expectations and write structured grading outputs.

## Inputs

Suggested CLI inputs:

- `--iteration-path`
- `--eval-set` optional fallback for expectation lookup
- `--output-summary`

## Behavior

- read eval metadata and expectations
- inspect transcripts and text outputs for each run
- write `grading.json` beside each run
- write per-eval comparison summaries when multiple configurations exist
- write an iteration-level grading summary

## Outputs

Suggested outputs:

- `<run-dir>/grading.json`
- `<eval-dir>/comparison.json`
- `<iteration-path>/grading-summary.json`

V1 note:
- heuristic grading is acceptable before a more capable grader model is added
- prefer conservative pass/fail logic over optimistic guesses

## Script: `compare-iteration`

## Purpose

Compare completed run outputs across configurations using a blind rubric-based model judgment.

## Inputs

Suggested CLI inputs:

- `--iteration-path`
- `--previous-iteration` optional cross-iteration comparison baseline
- `--eval-set` optional fallback for expectation lookup
- `--output-summary`
- `--output-vs-previous-summary` optional explicit cross-iteration summary path
- `--model`
- `--thinking`

## Behavior

- read output artifacts from each run
- compare paired runs across configurations without exposing configuration labels to the judging model
- when a previous iteration is provided, compare matching eval/configuration runs across iterations without exposing current vs previous labels to the judging model
- write detailed per-comparison artifacts
- write per-eval blind comparison summaries
- write an iteration-level blind comparison summary
- optionally write cross-iteration blind comparison summaries

## Outputs

Suggested outputs:

- `<eval-dir>/blind-comparisons/*.json`
- `<eval-dir>/blind-comparison.json`
- `<iteration-path>/blind-comparison-summary.json`
- `<eval-dir>/blind-comparison-vs-previous.json` when `--previous-iteration` is used
- `<iteration-path>/blind-comparison-vs-previous-summary.json` when `--previous-iteration` is used

V1 note:
- start with a single judging pass per paired comparison
- use deterministic A/B label shuffling so reruns stay inspectable

## Script: `aggregate-benchmark`

## Purpose

Aggregate results from a completed iteration into benchmark artifacts.

## Inputs

Suggested CLI inputs:

- `--iteration-path`
- `--skill-name`
- optional aggregation settings

## Behavior

- read per-run grading, timing, and metrics artifacts
- compute summary stats by configuration
- write machine-readable and human-readable benchmark outputs

## Outputs

Suggested outputs:

- `benchmark.json`
- `benchmark.md`

`benchmark.json` should be the canonical machine-readable artifact.

## V1 benchmark scope

For the first version, benchmark aggregation can focus on:

- pass/fail or review outcomes if available
- timing
- output sizes
- counts of completed runs

Do not block the entire system on advanced statistics.

## Script: `generate-review`

## Purpose

Generate a review artifact that makes iteration outputs easy to inspect.

## Inputs

Suggested CLI inputs:

- `--iteration-path`
- `--skill-name`
- `--benchmark`
- `--previous-iteration` optional
- `--output`

## Behavior

- read iteration results
- assemble links or embedded views of outputs
- include benchmark summary when available
- write a static review artifact

## Output

V1 output should be a static file such as:

- `review.html`

That is enough for the extension to point the user at the artifact without requiring browser automation.

## V1 review scope

A first review artifact should make it easy to inspect:

- eval prompt
- configuration
- output files
- transcript summary
- benchmark summary if present

The initial version does not need a full interactive web app.

## Script: `optimize-description`

## Purpose

Evaluate and improve a skill's frontmatter description for triggering behavior.

## Inputs

Suggested CLI inputs:

- `--skill-path`
- `--workspace`
- `--eval-set`
- `--iterations`
- `--train-split <fraction>` train/test split ratio for overfit defense (default: 0.6)
- `--seed <number>` deterministic shuffle seed for the train/test split (default: 1)
- `--model`
- `--thinking`
- `--cwd`

## Trigger eval model

Use two prompt groups:

- should-trigger
- should-not-trigger

For each prompt, assess whether the target skill is selected or clearly applied.

## Train/test split

The optimization loop must avoid overfitting the description to the train set.

Split the trigger eval set into a 60/40 train/test partition using the configured `--train-split` ratio and a deterministic shuffle (`--seed`). The loop evaluates each candidate description on both partitions but selects `best_description` strictly by **test-set** score. Train score drives iteration; test score gates selection.

Without the split, the loop drifts toward descriptions that game the specific training prompts. With it, the published description is the one that generalized best to prompts the optimizer never optimized against.

This mirrors the defense in the Claude reference implementation (`scripts/run_loop.py`).

## Trigger detection

**Canonical signal: file-read tool calls targeting the skill directory.**

### How pi exposes skills to the model

`packages/agent/src/harness/system-prompt.ts` injects the available skills into the system prompt as an `<available_skills>` block. For each visible skill (those without `disable-model-invocation`), the model sees only `<name>`, `<description>`, and `<location>` (an absolute path to `SKILL.md`). It does NOT see the skill's body content unless it explicitly reads the file.

The system prompt instructs the model: "Read the full skill file when the task matches its description." That instruction is the entire activation contract.

There is no `Skill` tool, no `skill_used` event, and no other autonomy hook. The model's only path to use a skill is to call its file-read tool against the `<location>` path.

### Why this signal

A skill is considered **triggered** for a query when the session's message history contains at least one assistant content block where:

- the block represents a tool invocation, AND
- the tool name is `read`, AND
- the resolved path equals the target skill's `SKILL.md` file (specifically the SKILL.md, not any file under the skill directory — see calibration note below).

**Calibration finding (2026-05-30):** the looser rule "any read under the skill directory" produced systematic false positives. When the model researches the workspace (running `find`, `grep`, walking the filesystem), it often reads peripheral skill files in `references/`, `evals/`, or `scripts/` without ever invoking the skill workflow. The tighter "SKILL.md was read" rule eliminates that noise. For substantive skills whose body is necessary to drive the workflow (which is essentially all skill-creator-shaped skills), the tighter rule has effectively no false-negative cost: the model cannot follow the skill without reading SKILL.md first.

This is high-fidelity in pi's architecture:

- The model cannot use the skill's instructions without first reading SKILL.md, because only the description is visible by default. Read = trigger.
- The signal is deterministic and visible by walking `session.agent.state.messages` after the session completes (no model-output inference, no transcript scanning, no brittle prose matching).
- It matches the spirit of the Claude reference's `run_loop.py`, which checks structured skill-activation signals rather than guessing from prose.

### Empirically verified content-block shape (pi at agent-harness version current as of 2026-05-30)

Pi emits assistant tool-invocation blocks in this shape:

```json
{
  "type": "toolCall",
  "id": "call_...",
  "name": "read",
  "arguments": { "path": "/abs/path/to/SKILL.md" }
}
```

The detector also accepts the Claude API shape (`type: "tool_use"`, `input: { file_path: "..." }`) for forward compatibility, since pi's normalization may converge with that shape later.

**Do not assume the Claude API shape without checking.** A previous version of `optimize-description.ts` did exactly that and silently reported 0 triggers on every should-trigger query. The detector now matches both, and the canonical pi shape is documented above.

### Rejected alternatives

- **Session lifecycle events** (`session_start`, `session_before_switch`, etc.) describe runtime transitions, not skill activations. They cannot answer the trigger question.
- **`formatSkillInvocation` call tracking** only fires when the SDK caller explicitly invokes `session.skill(name)`. In autonomous optimization queries (just `session.prompt(query)`) it never fires, so this captures nothing useful.
- **Transcript scan for skill-name mentions** is brittle: the model can mention the skill name without applying it, and can apply the skill without naming it. False positives and false negatives both common.
- **Output-pattern matching against skill structure** is a downstream quality check, not a trigger detector. Use it for grading, not for trigger detection.

### Implementation contract

The `optimize-description` script must:

1. Run each query in a session that exposes ONLY the target skill (no neighbors). This isolates the signal: any skill-directory read is unambiguously the target.
2. After the session resolves, walk `session.agent.state.messages` for assistant content blocks matching either `{ type: "toolCall", name: "read", arguments.path }` or `{ type: "tool_use", name: "read", input.file_path }`. Extract every path.
3. Compute `triggered = readPaths.some(path => resolve(path) === resolve(skillDir, "SKILL.md"))`. Resolve relative read paths against the pi session's cwd (not the SDK script's cwd) before comparison.
4. Record the read paths in the per-query result so failures can be audited (`signal_source: "read-path"` in `trigger-eval-results.json`, per the artifact schema).

### Edge cases

- **Model reads a sub-reference without reading SKILL.md first.** Unlikely in practice (the system prompt only exposes the SKILL.md location, not subreferences), but possible if the model guesses paths. Mitigation: counting any read under the skill directory as triggering is correct — the skill IS activated when its contents are accessed.
- **Model reads SKILL.md but does not follow it (false positive trigger).** Acceptable for trigger detection: reading is the activation event in pi's architecture, regardless of subsequent compliance. Output quality is handled separately by grading.
- **Skill with `disable-model-invocation: true`** is excluded from `<available_skills>` and cannot be autonomously triggered. The optimizer must not run trigger evals against such a skill; fail with a clear error if attempted.
- **Multi-skill optimization sessions** dilute the signal. The optimizer must always run with the target skill alone; the SDK script enforces this via the resource-loader override.

## Optimization loop

High-level loop:

1. evaluate the current description on the trigger eval set
2. identify false negatives and false positives
3. propose a revised description
4. rerun the evals
5. keep the best version according to **test-set** score (not train), preserving the train/test split defined above

## Outputs

Suggested artifacts:

- `trigger-eval-results.json`
- `description-history.json`
- `best-description.txt`
- optional human-readable summary report

## Optional script: `compare-runs`

## Purpose

Compare outputs across two configurations or iterations using a rubric-based evaluation flow.

## Use cases

- current skill vs no skill
- current skill vs previous snapshot
- iteration N vs iteration N+1

## Inputs

Suggested CLI inputs:

- `--run-a`
- `--run-b`
- `--prompt`
- `--expectations`
- `--output`

## Output

Suggested artifact:

- `comparison.json`

This script can be added after the core eval flow is stable.

## Script interface style

For consistency, all SDK scripts should:

- accept explicit CLI flags
- return non-zero exit codes on failure
- write structured output files
- print the important output paths to stdout

## Failure behavior

Examples of good failures:

- missing eval file
- invalid skill path
- missing snapshot path in snapshot mode
- unsupported model pattern
- inability to write to workspace

Failures should say:

- what went wrong
- which path or parameter caused it
- what the user can do next

## V1 implementation order

Recommended build order:

1. `run-evals`
2. `grade-iteration`
3. `compare-iteration`
4. `aggregate-benchmark`
5. `generate-review`
6. `optimize-description`
5. `compare-runs`

This order gives the extension something useful to orchestrate as early as possible.

## Anti-patterns

Avoid these SDK design mistakes:

- relying on hidden ambient discovery when reproducibility matters
- mixing interactive UI logic into SDK scripts
- treating parallel runs as a required first-step feature
- baking Claude-specific runtime assumptions into pi tooling
- making artifact locations inconsistent across scripts

## Deliverable checklist

A good SDK spec should define:

- the script set
- the inputs for each script
- the filesystem layout
- the output artifacts
- the baseline model
- the trigger-detection strategy for description optimization
- the implementation order
