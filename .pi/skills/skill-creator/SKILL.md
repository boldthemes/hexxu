---
name: skill-creator
description: Creates and improves pi skills. Use when designing a new skill, refining SKILL.md instructions, defining trigger descriptions, planning eval prompts, or iterating on a pi skill based on feedback. Not for iterating on prompt templates, generic LLM evals, GCP or cloud resource descriptions, or other LLM workflows that are not pi skills.
---

# Skill Creator

Use this skill to design or improve pi skills.

## What this skill owns

This skill is responsible for the parts of skill creation that are primarily about judgment, writing, and iteration:

- clarify the user's intent
- define the skill's scope and trigger conditions
- draft or revise `SKILL.md`
- decide what belongs in the main skill file vs supporting references
- create a small, realistic eval set
- interpret review feedback and recommend improvements
- keep the skill general enough to work beyond a few overfit examples

## What this skill does not own

This skill should not own heavy runtime orchestration. Leave these to extension and SDK tooling:

- batch eval execution
- benchmark automation
- package installation and distribution mechanics
- custom TUI workflows
- subagent orchestration assumptions
- provider-specific automation details unless the user explicitly asks for them

## Reference loading guide

Read supporting files when the task needs more detail than this main file provides:

- Read `references/workflow.md` when:
  - creating a skill from scratch
  - improving an existing skill
  - deciding what belongs in `SKILL.md` vs `references/`, `scripts/`, extensions, or SDK tooling
  - defining boundaries, frontmatter, or iteration strategy
- Read `references/eval-design.md` when:
  - deciding whether the skill needs evals
  - drafting eval prompts
  - choosing qualitative vs quantitative review
  - defining assertions, baselines, or trigger evals
- Read `references/extension-spec.md` when:
  - the workflow needs slash commands or typed tools
  - deciding what state the extension should persist
  - deciding what should stay in the skill vs move into extension behavior
  - planning how the extension should invoke SDK tooling
- Read `references/sdk-spec.md` when:
  - the task needs non-interactive eval automation
  - planning workspace layouts and output artifacts
  - defining baseline run behavior
  - designing trigger optimization or benchmark generation
- Read `references/artifact-schemas.md` when:
  - producing a new artifact from a script
  - changing an existing artifact's schema
  - wiring a new consumer that reads existing artifacts
  - debugging schema-related failures
- Read `references/todo.md` when:
  - planning the next implementation steps for `skill-creator`
  - deciding what remains unfinished
  - prioritizing follow-up work across extension and SDK layers

## First-pass workflow

1. Capture the user's intent.
2. If the task is more than a tiny edit, read `references/workflow.md`.
3. Identify the skill's boundaries: what it should do, when it should trigger, and what it should avoid.
4. Draft or revise the frontmatter:
   - `name`
   - `description`
5. Draft or revise the body of `SKILL.md`.
6. Decide whether supporting files are needed under `references/`, `scripts/`, or `assets/`.
7. If the skill needs evaluation, read `references/eval-design.md` and create a small eval set with realistic prompts.
8. Review feedback, generalize from failures, and improve the skill.

## Writing guidance

- Keep the description specific. It should say both what the skill does and when to use it.
- Keep the main `SKILL.md` focused on workflow and judgment.
- Move bulky detail into `references/` when the main file starts getting too large.
- Prefer explaining why an instruction matters instead of only giving rigid rules.
- Avoid overfitting the skill to a tiny eval set.
- Prefer pi-native assumptions over Claude-specific ones.

## Pi-native assumptions

When designing or revising skills for pi:

- use standard pi skill structure with `SKILL.md` and optional bundled files
- assume pi can load supporting references with relative paths
- do not assume built-in subagents
- do not assume `claude -p`
- prefer extension and SDK integration for automation-heavy workflows

## Supporting files

Use these files deliberately rather than loading them by default for every tiny task:

- `references/workflow.md` for the deeper creation, revision, and artifact-splitting workflow
- `references/eval-design.md` for deciding whether evals are needed and how to design them well
- `references/extension-spec.md` for the pi-native extension command, tool, state, and UI design
- `references/sdk-spec.md` for the SDK automation layer, script set, workspace layout, and artifact design
- `references/artifact-schemas.md` for the canonical index of every artifact produced by the SDK scripts, including producers, consumers, and required fields
- `references/todo.md` for the prioritized implementation backlog and remaining work

Prefer the main `SKILL.md` for quick guidance, then load the reference files when the task becomes detailed enough to justify them.
