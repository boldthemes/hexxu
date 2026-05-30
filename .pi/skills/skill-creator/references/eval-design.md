# Eval Design

Use this file when the user needs help deciding whether a pi skill needs evals and how to design them.

## Goal

Design evals that help improve the skill without overfitting it.

A good eval set should:

- reflect real user requests
- cover the skill's intended scope
- test important boundaries
- reveal whether the skill adds value
- stay small enough to iterate quickly at first

## Step 1: Decide whether the skill needs evals

Not every skill needs formal evaluation.

### Strong candidates for evals

Use evals when the skill is expected to produce observable, reviewable behavior such as:

- generating or revising structured files
- following a specific multi-step workflow
- transforming content in a repeatable way
- producing outputs with checkable properties
- routing reliably to the right files or docs
- triggering for the right kinds of tasks

### Weaker candidates for formal evals

Use lighter qualitative review when the task is mostly subjective, such as:

- tone and style guidance
- brainstorming support
- exploratory ideation
- open-ended writing assistance

These can still use example prompts, but they may not need strict pass/fail assertions.

## Step 2: Choose the type of eval

Pick one or more of these evaluation styles.

### 1. Qualitative task evals

Use realistic prompts and inspect the outputs manually.

Best for:

- early drafts
- workflow skills
- subjective or mixed tasks

### 2. Structured output checks

Use prompts where success can be checked against expected properties.

Best for:

- file generation
- JSON or markdown structure
- required sections or fields
- deterministic transformations

### 3. Baseline comparison evals

Compare behavior with the skill against behavior without it, or against an older version.

Best for:

- proving the skill adds value
- deciding whether a revision actually helped
- using blind model-based comparisons when output quality matters more than simple checks

### 4. Trigger evals

Check whether the skill description causes the skill to be used for the right prompts and ignored for nearby prompts.

Best for:

- mature skills
- improving frontmatter descriptions
- avoiding undertriggering or overtriggering

## Step 3: Start small

For a first eval set, prefer:

- 2 to 5 prompts

That is usually enough to expose major problems without creating too much overhead.

Expand later only after the core workflow is stable.

## Step 4: Write realistic prompts

Eval prompts should sound like something a real pi user would type.

Good prompts usually include:

- concrete intent
- realistic context
- imperfect wording when appropriate
- enough detail to expose ambiguity

### Good examples

- "turn this workflow into a pi skill and keep the main SKILL.md short, moving details into references if needed"
- "help me write a skill that routes pi documentation questions to the right local docs and examples"
- "improve this skill description so it triggers when the user asks to build dashboard charts from CSVs but not when they only ask to inspect a file"

### Weak examples

- "make a skill"
- "help with docs"
- "improve the prompt"

Short toy prompts are usually too vague to reveal whether the skill really works.

## Step 5: Cover the right kinds of cases

A small but useful eval set usually includes a mix of:

### Common case

The normal task the skill is most likely to receive.

### Edge or boundary case

A prompt near the edge of the skill's scope.

### Negative or near-miss case

A prompt that sounds similar but should not pull the skill in strongly, or should make the skill narrow its response carefully.

### Revision case

If improving an existing skill, include at least one prompt that failed before.

## Step 6: Decide what success means

Before running evals, define what you care about.

Possible success criteria:

- the skill is loaded or clearly applied when appropriate
- the main workflow is followed sensibly
- the output includes the right sections or artifacts
- the skill avoids unsupported assumptions
- the response stays focused on the skill's scope
- the behavior is better than with no skill or an older version

Prefer checking meaningful outcomes over superficial ones.

## Step 7: Choose qualitative vs quantitative checks

### Prefer qualitative review when:

- the task is subjective
- output quality matters more than exact structure
- a human can judge success much faster than code can

### Prefer quantitative or structured checks when:

- the output has required sections or fields
- success can be verified from files or text
- the same checks will be reused across iterations

In many cases, a mixed approach is best:

- human review for quality
- structured checks for obvious regressions

## Step 8: Write assertions carefully

If you add explicit assertions, make them discriminating.

A good assertion passes when the skill genuinely succeeds and fails when it does not.

### Good assertion style

- "The skill draft clearly separates what belongs in SKILL.md from what belongs in extension or SDK tooling."
- "The generated SKILL.md description states both what the skill does and when it should trigger."
- "The response proposes realistic eval prompts rather than only toy one-line examples."

### Weak assertion style

- "The response mentions skills."
- "A file named SKILL.md exists."
- "The answer contains a list."

These are too easy to satisfy without real success.

## Step 9: Avoid overfitting

A common failure mode is patching the skill so it works only for a tiny eval set.

Watch for these warning signs:

- new instructions mention one eval's exact wording too closely
- the skill gets longer without getting more general
- the skill starts forcing unnecessary rigid behavior
- revisions solve one prompt but make the skill less flexible overall

When a prompt fails, ask:

- what broader misunderstanding caused the failure?
- what general instruction would help in similar cases?
- should this live in the skill, a reference file, or tooling instead?

## Step 10: Compare against the right baseline

Three run-time baselines plus one cross-iteration comparison serve four distinct questions. Picking the wrong one gives a confident answer to a question you did not ask.

| Mode | Question it answers | When to pick |
|---|---|---|
| `none` (no baseline) | "Does this iteration work in isolation?" | First drafts; quick iteration where comparison adds noise |
| `without-skill` | "Does the skill add value over the model's default behavior?" | Validating that the skill earns its place at all |
| `snapshot` | "Is this draft better than the published / known-good version?" | Improving an existing shipped skill before replacing it |
| Cross-iteration (via `compare-iteration --previous-iteration`) | "Did this revision improve over the last revision?" | Inside an iteration loop; deciding whether to keep iterating or stop |

The first three are run-time baselines selected when invoking `run-evals` (`--baseline-mode`). The fourth is a comparison performed after a fresh iteration completes, against an earlier iteration's artifacts. They are not interchangeable: a strong `without-skill` win does not tell you whether revision N+1 beat revision N, and a strong cross-iteration win does not tell you whether the skill beats no skill at all.

### No baseline (`--baseline-mode none`)

Useful for first drafts and quick iteration.

### Without the skill (`--baseline-mode without-skill`)

Useful when you want to know whether the skill adds value at all.

When quality is subjective or mixed, pair this baseline with blind comparison artifacts so the review does not depend only on phrase-matching assertions.

### Snapshot (`--baseline-mode snapshot`)

Useful when improving an existing skill and deciding whether the new version is actually better than a known-good published version. The snapshot is a separate skill directory provided explicitly via `--snapshot-path`.

### Cross-iteration comparison (`compare-iteration --previous-iteration`)

Useful inside the iteration loop. After a fresh iteration completes, compare its outputs against the previous iteration's outputs to decide whether the revision improved over the last.

When the outputs are subjective or mixed, use a blind comparator instead of relying only on static assertions.

Do not add baseline complexity until it helps answer a real question.

## Trigger eval guidance

Trigger evals are specifically about the frontmatter description.

Design two groups of prompts:

### Should trigger

Prompts where the skill should clearly be helpful.

### Should not trigger

Prompts that are close enough to be interesting, but should not strongly match the skill.

Avoid overly easy negative cases. The best negative examples are near-misses, not unrelated tasks.

## Review checklist

When reviewing eval results, ask:

- Did the skill trigger when it should?
- Did the skill stay inside its scope?
- Did it make assumptions that pi does not guarantee?
- Did it push too much orchestration into `SKILL.md`?
- Did the eval expose a real weakness or only a wording mismatch?
- Would the proposed fix generalize to future prompts?

## Pi-native constraints

When designing evals for pi skills, keep these constraints in mind:

- do not assume built-in subagents
- do not assume Claude-specific commands or runtime behavior
- do not assume extra tools unless they are actually present
- if a workflow needs automation, that is a signal for extension or SDK work

For V1, serial manual or scripted runs are acceptable. Parallel orchestration can come later.

## Recommended first eval set template

Start with something like this:

1. **Core prompt**
   - the main thing the skill is supposed to help with
2. **Boundary prompt**
   - a case near the edge of the skill's intended scope
3. **Revision prompt**
   - a case based on a prior failure or ambiguity
4. **Optional negative prompt**
   - a nearby case that should not be handled too aggressively by the skill

## Deliverable checklist

A good eval plan should specify:

- whether the skill needs evals at all
- the type of eval being used
- a small set of realistic prompts
- what success looks like
- whether comparison against a baseline is needed
- whether review will be qualitative, quantitative, or mixed
