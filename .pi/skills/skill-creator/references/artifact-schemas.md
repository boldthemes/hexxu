# Artifact Schemas

Canonical reference for every artifact produced by the `skill-creator` SDK scripts. Update this file whenever a producer adds, removes, or renames a field. Consumers should treat this file as the contract.

## Why this file exists

Each artifact below is produced by one script and consumed by one or more downstream scripts or by the extension. Schema drift between producer and consumer breaks the pipeline silently. Keep this file in sync with the code; treat it as the single source of truth for what each artifact looks like and who reads it.

## Layout overview

Workspace layout (canonical, matches `run-evals` output):

```text
<workspace>/
├── iteration-<N>/
│   ├── iteration.json
│   ├── grading-summary.json
│   ├── blind-comparison-summary.json
│   ├── blind-comparison-vs-previous-summary.json   (only with --previous-iteration)
│   ├── benchmark.json
│   ├── benchmark.md
│   ├── review.html
│   └── eval-<id>-<name>/
│       ├── eval_metadata.json
│       ├── comparison.json
│       ├── blind-comparison.json
│       ├── blind-comparison-vs-previous.json       (only with --previous-iteration)
│       ├── blind-comparisons/
│       │   └── <pair-id>.json                       (one per pair)
│       └── <configuration>/                         (with-skill | without-skill | snapshot)
│           ├── outputs/
│           │   └── assistant-final.md
│           ├── transcript.md
│           ├── messages.json
│           ├── timing.json
│           ├── metrics.json
│           └── run.json
└── iteration-<N+1>/
```

When `--runs-per-eval > 1`, each `<configuration>/` directory contains `run-<n>/` subdirectories instead of the run files directly.

Directory naming convention is locked in `sdk-spec.md` under "Directory model": `with-skill`, `without-skill`, `snapshot` (hyphen-separated, lowercase).

## Per-run artifacts

Produced inside `iteration-<N>/eval-<id>-<name>/<configuration>/[run-<n>/]`.

### `outputs/assistant-final.md`

- **Producer:** `run-evals`
- **Consumer:** `grade-iteration` (heuristic corpus), `compare-iteration` (blind comparator input), human reviewer
- **Schema:** plain text. Final assistant text from the session.

### `transcript.md`

- **Producer:** `run-evals`
- **Consumer:** human reviewer, `generate-review`
- **Schema:** markdown. `# Transcript` followed by `## <role>` sections, then `# Event Log` section with `- <event>` lines.

### `messages.json`

- **Producer:** `run-evals`
- **Consumer:** none currently. Reserved for richer review tooling.
- **Schema:** array of pi message objects (role, content[]).

### `timing.json`

- **Producer:** `run-evals`
- **Consumer:** `grade-iteration`, `aggregate-benchmark`
- **Schema:**
  ```json
  {
    "startedAt": "ISO 8601 string",
    "endedAt": "ISO 8601 string",
    "durationMs": 0,
    "totalDurationSeconds": 0
  }
  ```
- **Notes:** `totalDurationSeconds = durationMs / 1000` rounded to 3 decimals. Consumers should prefer `totalDurationSeconds`; fall back to `durationMs / 1000` if absent.

### `metrics.json`

- **Producer:** `run-evals`
- **Consumer:** `grade-iteration`, `aggregate-benchmark`
- **Schema:**
  ```json
  {
    "toolExecutionStarts": 0,
    "toolExecutionEnds": 0,
    "toolErrors": 0,
    "assistantTextChars": 0,
    "thinkingChars": 0,
    "messageCount": 0,
    "finalAssistantChars": 0,
    "outputFiles": ["absolute path"]
  }
  ```

### `run.json`

- **Producer:** `run-evals`
- **Consumer:** `grade-iteration`, `compare-iteration`, `aggregate-benchmark`
- **Schema:**
  ```json
  {
    "configuration": "with-skill | without-skill | snapshot",
    "runNumber": 1,
    "skillPath": "absolute path or null",
    "prompt": "string",
    "inputFiles": ["absolute path"],
    "model": "provider/id or null",
    "thinking": "off | minimal | low | medium | high | xhigh | null",
    "success": true,
    "errorMessage": "string or null",
    "finalAssistantChars": 0
  }
  ```

### `grading.json`

- **Producer:** `grade-iteration` (line 393 in `grade-iteration.ts`)
- **Consumer:** `aggregate-benchmark`, `compare-iteration` (for tie-break signals), `generate-review`
- **Schema:**
  ```json
  {
    "generated_at": "ISO 8601 string",
    "eval_id": "string or null",
    "eval_name": "string or null",
    "prompt": "string or null",
    "expectations": [
      {
        "text": "string",
        "passed": true,
        "evidence": "string"
      }
    ],
    "summary": {
      "passed": 0,
      "failed": 0,
      "total": 0,
      "pass_rate": 0
    },
    "execution_metrics": {
      "tool_execution_starts": 0,
      "tool_execution_ends": 0,
      "tool_errors": 0,
      "message_count": 0,
      "final_assistant_chars": 0,
      "output_files": ["relative path"]
    },
    "timing": {
      "total_duration_seconds": 0
    },
    "claims": {},
    "user_notes_summary": "string or null",
    "eval_feedback": []
  }
  ```
- **Field naming rule:** expectation fields MUST be `text`, `passed`, `evidence` (not `name`, `met`, `details`). The downstream review tooling depends on these exact names.

## Per-eval artifacts

Produced inside `iteration-<N>/eval-<id>-<name>/`.

### `eval_metadata.json`

- **Producer:** `run-evals`
- **Consumer:** `grade-iteration`, `compare-iteration`, `aggregate-benchmark`, `generate-review`
- **Schema:**
  ```json
  {
    "evalId": "string | number",
    "evalName": "string",
    "prompt": "string",
    "expectedOutput": "string or null",
    "expectations": ["string"],
    "files": ["absolute path"],
    "configurations": ["with-skill", "without-skill", "snapshot"]
  }
  ```

### `comparison.json`

- **Producer:** `grade-iteration` (line 530)
- **Consumer:** `generate-review`, human reviewer
- **Schema:**
  ```json
  {
    "generated_at": "ISO 8601 string",
    "eval_id": "string or null",
    "eval_name": "string or null",
    "winner": "configuration name or 'tie'",
    "reasoning": "string",
    "configurations": [
      {
        "configuration": "with-skill | without-skill | snapshot",
        "run_count": 0,
        "successful_runs": 0,
        "average_pass_rate": 0,
        "average_duration_seconds": 0
      }
    ]
  }
  ```

### `blind-comparisons/<pair-id>.json`

- **Producer:** `compare-iteration` (per-pair, lines 802 / 835 / 873)
- **Consumer:** `compare-iteration` (when aggregating per-eval summary), human reviewer for diagnostics
- **Schema (success case):**
  ```json
  {
    "generated_at": "ISO 8601 string",
    "scope": "within-iteration | vs-previous-iteration",
    "eval_id": "string or null",
    "eval_name": "string or null",
    "comparison_id": "string",
    "comparison_group": "string or null",
    "model": "provider/id or null",
    "thinking": "string or null",
    "pairing": { "left": "configuration name", "right": "configuration name" },
    "labels": { "A": "left key", "B": "right key" },
    "success": true,
    "winner": "A | B | tie",
    "resolved_winner": "configuration name or 'tie'",
    "reasoning": "string",
    "rubric": null,
    "output_quality": null,
    "expectation_results": null,
    "raw_model_output_path": "absolute path"
  }
  ```
- **Schema (failure case):** identical fields with `success: false`, `error: string`, and no `winner` / `resolved_winner` / `reasoning` / rubric fields.

### `blind-comparison.json`

- **Producer:** `compare-iteration` (per-eval, line 987)
- **Consumer:** `aggregate-benchmark` indirectly (through `blind-comparison-summary.json`)
- **Schema:**
  ```json
  {
    "generated_at": "ISO 8601 string",
    "eval_id": "string or null",
    "eval_name": "string or null",
    "model": "provider/id or null",
    "thinking": "string or null",
    "comparison_count": 0,
    "successful_comparisons": 0,
    "failed_comparisons": 0,
    "overall_winner": "configuration name or 'tie'",
    "by_configuration": [
      {
        "configuration": "with-skill | without-skill | snapshot",
        "wins": 0,
        "losses": 0,
        "ties": 0,
        "comparisons": 0,
        "win_rate": 0
      }
    ],
    "comparisons": []
  }
  ```

### `blind-comparison-vs-previous.json`

- **Producer:** `compare-iteration` (per-eval vs previous, line 1066). Only written when `--previous-iteration` is set.
- **Consumer:** `compare-iteration` (when aggregating cross-iteration summary)
- **Schema:**
  ```json
  {
    "generated_at": "ISO 8601 string",
    "scope": "vs-previous-iteration",
    "eval_id": "string or null",
    "eval_name": "string or null",
    "model": "provider/id or null",
    "thinking": "string or null",
    "previous_eval_found": true,
    "comparison_count": 0,
    "successful_comparisons": 0,
    "failed_comparisons": 0,
    "current_wins": 0,
    "previous_wins": 0,
    "ties": 0,
    "current_win_rate": 0,
    "previous_win_rate": 0,
    "overall_winner": "current | previous | tie",
    "matched_configurations": ["with-skill"],
    "missing_configurations_in_previous": [],
    "by_configuration": [
      {
        "configuration": "with-skill",
        "current_wins": 0,
        "previous_wins": 0,
        "ties": 0,
        "comparisons": 0,
        "current_win_rate": 0,
        "previous_win_rate": 0,
        "winner": "current | previous | tie"
      }
    ],
    "comparisons": []
  }
  ```

## Per-iteration artifacts

Produced inside `iteration-<N>/`.

### `iteration.json`

- **Producer:** `run-evals` (line 576)
- **Consumer:** `compare-iteration` (resolves `cwd`), `aggregate-benchmark` (resolves `skillPath`)
- **Schema:**
  ```json
  {
    "skillPath": "absolute path",
    "workspacePath": "absolute path",
    "cwd": "absolute path",
    "evalSetPath": "absolute path",
    "iteration": 1,
    "baselineMode": "none | without-skill | snapshot",
    "model": "provider/id or null",
    "thinking": "string or null",
    "runsPerEval": 1,
    "evals": [
      {
        "evalId": "string | number",
        "evalName": "string",
        "configurations": [
          {
            "configuration": "with-skill",
            "runNumber": 1,
            "runDir": "absolute path",
            "success": true,
            "errorMessage": "string or null"
          }
        ]
      }
    ]
  }
  ```

### `grading-summary.json`

- **Producer:** `grade-iteration` (line 540)
- **Consumer:** none currently. Reserved for richer dashboards.
- **Schema:**
  ```json
  {
    "generated_at": "ISO 8601 string",
    "iteration_path": "absolute path",
    "graded_runs": 0,
    "runs": [
      {
        "eval_id": "string or null",
        "eval_name": "string",
        "configuration": "with-skill",
        "run_number": 1,
        "run_dir": "absolute path",
        "grading_path": "absolute path",
        "summary": { "passed": 0, "failed": 0, "total": 0, "pass_rate": 0 }
      }
    ]
  }
  ```

### `blind-comparison-summary.json`

- **Producer:** `compare-iteration` (line 1129)
- **Consumer:** `aggregate-benchmark` (line 344 of `aggregate-benchmark.ts`)
- **Schema:**
  ```json
  {
    "generated_at": "ISO 8601 string",
    "iteration_path": "absolute path",
    "model": "provider/id or null",
    "thinking": "string or null",
    "eval_count": 0,
    "comparison_count": 0,
    "successful_comparisons": 0,
    "failed_comparisons": 0,
    "overall_winner": "configuration name or 'tie'",
    "by_configuration": [
      {
        "configuration": "with-skill | without-skill | snapshot",
        "wins": 0,
        "losses": 0,
        "ties": 0,
        "comparisons": 0,
        "win_rate": 0,
        "average_eval_win_rate": 0
      }
    ],
    "evals": [
      {
        "eval_id": "string or null",
        "eval_name": "string",
        "summary_path": "absolute path",
        "comparison_count": 0,
        "successful_comparisons": 0,
        "failed_comparisons": 0,
        "overall_winner": "configuration name or 'tie'",
        "by_configuration": []
      }
    ]
  }
  ```

### `blind-comparison-vs-previous-summary.json`

- **Producer:** `compare-iteration` (line 1191). Only written when `--previous-iteration` is set.
- **Consumer:** `aggregate-benchmark` (P0c work — to be wired in T10)
- **Schema:**
  ```json
  {
    "generated_at": "ISO 8601 string",
    "scope": "vs-previous-iteration",
    "iteration_path": "absolute path",
    "previous_iteration_path": "absolute path",
    "model": "provider/id or null",
    "thinking": "string or null",
    "eval_count": 0,
    "comparison_count": 0,
    "successful_comparisons": 0,
    "failed_comparisons": 0,
    "current_wins": 0,
    "previous_wins": 0,
    "ties": 0,
    "current_win_rate": 0,
    "previous_win_rate": 0,
    "overall_winner": "current | previous | tie",
    "by_configuration": [
      {
        "configuration": "with-skill",
        "current_wins": 0,
        "previous_wins": 0,
        "ties": 0,
        "comparisons": 0,
        "current_win_rate": 0,
        "previous_win_rate": 0,
        "average_eval_current_win_rate": 0,
        "average_eval_previous_win_rate": 0,
        "winner": "current | previous | tie"
      }
    ],
    "evals": []
  }
  ```

### `benchmark.json`

- **Producer:** `aggregate-benchmark`
- **Consumer:** `generate-review`, human reviewer, future dashboards
- **Schema:**
  ```json
  {
    "metadata": {
      "skill_name": "string",
      "iteration_path": "absolute path",
      "generated_at": "ISO 8601 string",
      "evals_detected": 0,
      "configurations": ["with-skill"],
      "run_count": 0,
      "blind_comparison_summary_path": "absolute path or null",
      "blind_comparison_vs_previous_summary_path": "absolute path or null"
    },
    "runs": [],
    "summaries": {
      "overall": {
        "run_count": 0,
        "successful_runs": 0,
        "failed_runs": 0,
        "success_rate": 0,
        "average_duration_seconds": 0,
        "average_final_assistant_chars": 0,
        "average_grading_pass_rate": 0,
        "total_grading_passed": 0,
        "total_grading_failed": 0,
        "total_tool_execution_starts": 0,
        "total_tool_errors": 0,
        "blind_comparison_count": 0,
        "successful_blind_comparisons": 0,
        "failed_blind_comparisons": 0,
        "blind_overall_winner": "string or null",
        "vs_previous": {
          "comparison_count": 0,
          "current_wins": 0,
          "previous_wins": 0,
          "ties": 0,
          "current_win_rate": 0,
          "previous_win_rate": 0,
          "overall_winner": "current | previous | tie | null"
        }
      },
      "by_configuration": [],
      "by_eval": [],
      "by_configuration_vs_previous": []
    }
  }
  ```
- **Notes:** the `vs_previous` block and `by_configuration_vs_previous` array are populated by T10 when `blind-comparison-vs-previous-summary.json` exists. When absent, set them to `null` (vs_previous) and `[]` (by_configuration_vs_previous) and set `blind_comparison_vs_previous_summary_path` to `null`.

### `benchmark.md`

- **Producer:** `aggregate-benchmark`
- **Consumer:** human reviewer
- **Schema:** markdown rendering of `benchmark.json`. T10 adds a "## Versus Previous Iteration" section when the cross-iteration data is present.

### `review.html`

- **Producer:** `generate-review`
- **Consumer:** human reviewer (opened in browser)
- **Schema:** static HTML, self-contained. No external dependencies.

## Description optimization artifacts

Produced under `<workspace>/optimize-description/<run-id>/` by `optimize-description.ts`.

### `trigger-eval-results.json`

- **Producer:** `optimize-description`
- **Consumer:** extension (`skill_creator_optimize_description`), human reviewer, dashboards
- **Schema:**
  ```json
  {
    "generated_at": "ISO 8601 string",
    "skill_path": "absolute path",
    "model": "provider/id",
    "thinking": "string",
    "train_split": 0.6,
    "seed": 1,
    "eval_set_size": 20,
    "train_size": 12,
    "test_size": 8,
    "iterations": [
      {
        "iteration": 0,
        "description": "string",
        "train_score": 0,
        "test_score": 0,
        "per_query": [
          {
            "query": "string",
            "should_trigger": true,
            "partition": "train | test",
            "runs": [{ "triggered": true, "signal_source": "string" }]
          }
        ]
      }
    ],
    "best_iteration": 3,
    "best_description": "string"
  }
  ```

### `description-history.json`

- **Producer (planned):** `optimize-description`
- **Schema (planned):**
  ```json
  {
    "skill_path": "absolute path",
    "generated_at": "ISO 8601 string",
    "history": [
      {
        "iteration": 0,
        "description": "string",
        "train_score": 0,
        "test_score": 0,
        "reasoning": "string (model's justification for this revision)"
      }
    ]
  }
  ```

### `best-description.txt`

- **Producer (planned):** `optimize-description`
- **Schema (planned):** plain text. The single best description line, selected by **test-set** score (not train).

## Schema versioning

Until any consumer requires versioning explicitly, every artifact is at implicit schema version `1`. When a breaking change lands, add `"schema_version": "N"` at the top of the artifact, document the migration here, and update consumers in the same change.

## Adding a new artifact

When adding a new artifact:

1. Append a section to this file under the appropriate scope (per-run / per-eval / per-iteration).
2. Name the producer script and every consumer.
3. Specify required fields, optional fields, and example values.
4. Update any consumer scripts (or note them as TODO) to read the new fields with safe fallbacks.
5. If the field is consumed across iterations (cross-iteration comparison, dashboards), add a regression test to the test harness that round-trips the schema.
