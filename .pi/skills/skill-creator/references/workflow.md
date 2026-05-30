# Skill Creator Workflow

Use this file when the user needs the detailed, pi-native process for creating or improving a skill.

## Goal

Produce a skill that:

- has a clear trigger description
- has a focused scope
- uses `SKILL.md` for judgment and workflow guidance
- moves bulky detail into supporting files when needed
- stays general enough to help across many prompts, not only a tiny eval set

## Core principle

Treat skill creation as a sequence of design decisions:

1. understand the user's intent
2. define boundaries
3. decide the right artifact split
4. draft the skill
5. design realistic evals
6. review behavior
7. compare against baselines when useful
8. improve without overfitting

## Step 1: Capture intent

Start by understanding what the user wants the skill to enable.

Questions to answer:

- What should the skill help the agent do?
- What kinds of user requests should trigger it?
- What should the output or behavior look like?
- Is this primarily a writing/workflow problem, or does it need automation too?
- Is the user creating a brand new skill, or improving an existing one?

If the current conversation already demonstrates the workflow, extract details from it before asking repetitive questions.

Look for:

- tool usage patterns
- repeated steps
- corrections from the user
- output expectations
- safety or boundary constraints

## Step 2: Choose the artifact split

Before drafting the skill, decide what belongs in:

- the skill
- supporting references
- scripts
- extensions
- SDK tooling

Use this rule of thumb:

### Put it in the skill when it is about:

- judgment
- interpretation
- sequencing of steps
- deciding what to do next
- writing guidance
- user interaction strategy
- explaining why something matters

### Put it in `references/` when it is:

- detailed but not always needed
- domain-specific guidance
- a longer checklist or file map
- a schema or data contract

### Put it in `scripts/` when it is:

- repetitive
- deterministic
- better done by code than by freeform reasoning

### Put it in extensions or SDK tooling when it is:

- automation-heavy
- interactive UI behavior
- batch execution
- benchmarking
- orchestration of repeated runs
- instrumentation or metrics capture

Do not force automation-heavy concerns into `SKILL.md`.

## Step 3: Define boundaries

Write down what the skill should do, when it should trigger, and what it should avoid.

This step should produce:

- the intended use cases
- nearby cases that should not trigger the skill
- assumptions the skill is allowed to make
- assumptions the skill must not make

Be explicit about pi-native constraints where relevant:

- do not assume built-in subagents
- do not assume Claude-specific CLI workflows
- do not assume extra tools unless they are actually available

## Step 4: Draft the frontmatter

The frontmatter is a major part of the skill design.

### `name`

Choose a stable, descriptive name using lowercase letters, numbers, and hyphens.

### `description`

The description should say:

- what the skill does
- when to use it
- enough context for pi to trigger it appropriately

Good descriptions mention both capability and context.

Weak descriptions are vague, generic, or too short.

## Step 5: Draft the main `SKILL.md`

The main skill file should stay focused on the highest-value instructions.

A strong `SKILL.md` usually includes:

- purpose
- what the skill owns
- what it does not own
- main workflow
- key writing or decision-making guidance
- references to supporting files when more detail is needed

Prefer concise, structured guidance over a giant wall of prose.

If the file starts getting too large, split detail into `references/` and leave clear pointers.

## Step 6: Decide supporting files

Add supporting files only when they improve clarity or reuse.

Common patterns:

- `references/workflow.md` for the deeper process
- `references/eval-design.md` for eval-writing guidance
- `references/file-map.md` for topic-to-file routing skills
- `scripts/...` for deterministic helper tasks
- `assets/...` for templates or static review files

Do not add placeholder complexity without a reason. Each supporting file should have a clear job.

## Step 7: Design evals

When the skill has observable behavior, create a small eval set.

Default starting size:

- 2 to 5 realistic prompts

Use prompts that sound like something a real user would actually type.

Good eval prompts:

- are specific
- contain realistic context
- exercise the skill's boundaries
- cover both common and tricky cases

Avoid toy prompts that only prove the skill works on obvious examples.

For detailed guidance, read `references/eval-design.md`.

## Step 8: Compare outputs when a baseline exists

If the skill has a baseline such as `without-skill` or a snapshot version, add comparison artifacts instead of relying only on isolated pass/fail checks.

Useful comparison layers include:

- heuristic expectation grading
- blind model-based output comparison within one iteration
- blind model-based comparison against a previous iteration
- benchmark summaries that combine both signals

Use blind comparisons when output quality matters more than simple presence checks.

## Step 9: Review outputs and improve

After drafting the skill and trying eval prompts:

- inspect what the agent actually did
- identify which instructions helped
- identify which instructions were ignored or caused wasteful behavior
- generalize from failures instead of patching only one example

When revising the skill:

- keep useful guidance
- remove instructions that create noise or busywork
- explain the reasoning behind important behaviors
- avoid over-constraining the model unless structure is essential

## Step 10: Decide whether to hand off to extension or SDK design

If repeated manual steps start appearing, stop and reassess.

Strong signals that the next step is extension or SDK work:

- you want slash commands
- you want typed tools
- you want a custom TUI flow
- you want batch eval runs
- you want benchmarking or metrics
- you want trigger optimization automation

At that point, keep the skill focused and move orchestration elsewhere.

## Improvement heuristics

When improving a skill, prefer these moves:

- clarify trigger conditions
- sharpen scope boundaries
- explain why important behaviors matter
- move bulky detail out of the main file
- add or improve examples only where they teach something reusable
- remove wording that overfits a single eval

## Anti-patterns

Avoid these:

- vague descriptions like "helps with X"
- stuffing every detail into one huge `SKILL.md`
- assuming tools or workflows that are not actually present
- encoding extension or SDK behavior as if it were skill behavior
- optimizing only for a tiny hand-picked eval set
- writing rigid rules where explanation would work better

## Deliverable checklist

Before considering the skill draft complete, check that it has:

- a valid `name`
- a specific `description`
- clear scope boundaries
- a usable main workflow
- a justified split between `SKILL.md` and supporting files
- a small realistic eval set, if evaluation is needed
- no hidden dependence on unavailable tools or Claude-specific assumptions
