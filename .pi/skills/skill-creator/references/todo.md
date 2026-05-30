# Skill Creator TODO

Use this file when planning the next implementation steps for the pi-native `skill-creator` system.

## Priority legend

- `P0` = highest priority, needed to complete the intended core workflow
- `P1` = important quality and robustness improvements
- `P2` = useful UX and maintainability follow-ups

## P0 — Complete the core workflow

### Snapshot baseline support

- [ ] Persist a snapshot skill path in extension state
- [ ] Add extension UX for setting and updating the snapshot skill path
- [ ] Unblock `/skill-run-evals` snapshot mode when a snapshot path is available
- [ ] Unblock `skill_creator_run_evals` snapshot mode when a snapshot path is available
- [ ] Verify end-to-end snapshot artifacts and state updates

Why this matters:
- completes the missing baseline mode from the original design
- enables current-vs-snapshot evaluation without manual patching

### Trigger eval / description optimization

- [ ] Implement the SDK script for trigger evaluation and description optimization
- [ ] Define the trigger artifact schema clearly
- [ ] Add extension command/tool wiring for description optimization
- [ ] Write outputs such as:
  - [ ] `trigger-eval-results.json`
  - [ ] `description-history.json`
  - [ ] `best-description.txt`
- [ ] Verify the optimization loop against realistic should-trigger and should-not-trigger prompts

Why this matters:
- this is still one of the major missing parts of the planned `skill-creator` architecture
- current automation improves outputs, but not skill triggering behavior

### Fold previous-iteration comparison into benchmark outputs

- [ ] Read `blind-comparison-vs-previous-summary.json` from benchmark aggregation
- [ ] Add previous-iteration comparison fields to `benchmark.json`
- [ ] Add previous-iteration comparison summary to `benchmark.md`
- [ ] Show whether the current iteration beat, tied, or lost to the previous iteration

Why this matters:
- cross-iteration comparison artifacts now exist
- benchmark outputs should reflect iteration-over-iteration progress, not only same-iteration results

## P1 — Improve grading and comparison quality

### Stronger grading

- [ ] Improve expectation grading beyond phrase/token matching
- [ ] Consider optional model-based grading for subjective tasks
- [ ] Improve evidence extraction and explanation quality in `grading.json`
- [ ] Handle richer multi-file outputs more intelligently
- [ ] Add better fallbacks when expectations are underspecified

Why this matters:
- the current heuristic grader is useful, but still shallow for nuanced tasks

### More robust blind comparison

- [ ] Add retry or repair behavior when comparator JSON is malformed
- [ ] Consider multiple judging passes or multi-judge aggregation
- [ ] Normalize rubric score handling more carefully
- [ ] Improve large-output truncation strategy
- [ ] Improve comparison quality for multi-file outputs

Why this matters:
- the current blind comparator is real and useful, but still V1

### Better iteration matching and diff reporting

- [ ] Improve reporting for unmatched evals across iterations
- [ ] Improve reporting for mismatched configuration sets
- [ ] Improve reporting when run counts differ significantly
- [ ] Add clearer iteration-diff summaries for added/removed evals or configs

Why this matters:
- cross-iteration comparison becomes harder to interpret as iterations diverge

## P2 — UX and maintainability

### Comparison UX

- [ ] Decide whether to keep cross-iteration comparison inside `/skill-compare` only
- [ ] Optionally add a dedicated `/skill-compare-iterations` command
- [ ] Optionally add a dedicated tool for explicit iteration-vs-iteration comparison flows

Why this matters:
- the current UX works, but a more explicit command may be clearer later

### Review UX

- [ ] Improve `review.html` navigation and filtering
- [ ] Add easier drill-down across evals, configurations, and iterations
- [ ] Consider a richer TUI review workflow later

Why this matters:
- static review generation exists, but inspection UX is still basic

### Automated tests

- [ ] Add repeatable tests for run artifact parsing
- [ ] Add tests for heuristic grading
- [ ] Add tests for blind comparison artifact parsing and normalization
- [ ] Add tests for previous-iteration comparison logic
- [ ] Add tests for benchmark aggregation
- [ ] Add tests for review generation

Why this matters:
- the system is now large enough that regressions are likely without tests

### Dev tooling and maintenance

- [ ] Add a repeatable local typecheck flow
- [ ] Add linting or equivalent static checks if practical
- [ ] Reduce maintenance risk around dynamic import fallbacks where possible

Why this matters:
- current scripts are runnable, but the maintenance ergonomics are still light

## Later ideas

These are useful, but should not block the higher-priority work above.

- [ ] Create a unified per-eval decision artifact combining grading, blind comparison, and metrics
- [ ] Add model-generated narrative summaries of improvements and regressions
- [ ] Add richer regression surfacing across iterations

## Recommended implementation order

1. Snapshot baseline support
2. Trigger eval / description optimization
3. Benchmark integration for previous-iteration comparison
4. Grading improvements
5. Blind comparison robustness
6. Tests and dev tooling
