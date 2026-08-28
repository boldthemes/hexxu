---
status: REFERENCE
---
# Reusable Agentic Building Blocks (from gstack + gbrain)

Distilled 2026-06-02 from a cross-repo analysis of two mature agentic systems
vendored under `inspiration/` (gitignored, reference-only):

- **gstack** (`garrytan/gstack`, v1.55.0.0) — a large skill/orchestration
  system: ~60 skills, a template+resolver generation pipeline, multi-persona
  review, staged workflows.
- **gbrain** (`garrytan/gbrain`, v0.42.3.0) — an agent memory/knowledge system:
  pluggable storage, hybrid retrieval, MCP tool surface, trust boundaries.

This catalogue extracts the **repo-agnostic** patterns — the general concepts and
building blocks worth reusing in other agentic projects (hexxu included). It is
NOT documentation of gstack/gbrain themselves. Patterns that appear in **both**
repos are flagged 🔁 — independent convergence is the strongest signal a pattern
is a real building block rather than a local quirk.

For the hexxu-specific gap analysis and proposed work items derived from this
catalogue, see the companion section at the bottom (**Mapping to hexxu**).

---

## A. Intent Identification & Routing

**A1. Dual-channel intent declaration.** Each skill carries both a structured
`triggers:` keyword list (cheap exact-match dispatch) *and* natural-language
`description` prose ("Use when…", "Proactively suggest when…"). Keywords route
fast; prose covers boundary cases keywords can't express. The skill file *is*
the router — no central dispatch server.

**A2. Positive + negative intent boundaries.** Skills declare not just when to
fire but explicit non-goals ("Do NOT refactor unrelated code"; "For X use
/other-skill instead"). This is what keeps overlapping skills from colliding.
*(hexxu already has this as the T15 `scope`/`non_goals` manifest fields.)*

**A3. Catalog trim (lead vs routing prose).** Split each description into a
one-line "lead" (always loaded) and full routing prose (loaded on demand from a
side registry). At 50+ skills every KB of frontmatter is paid by every agent at
load time. Progressive disclosure for routing metadata.

**A4. Project-scoped routing override.** A `## Skill routing` section in the
project's `CLAUDE.md`/`AGENTS.md` maps intents→skills. Routing is a *project*
concern, not a tool concern — each repo routes differently without forking the
skill set.

**A5. Voice-trigger aliasing.** A `voice-triggers:` list maps speech-to-text
mishearings ("code x"→codex) into routing. Cheap per-skill insurance for voice
input.

**A6. Intent-driven result sizing (gbrain).** Query intent
(`entity`/`temporal`/`event`/`general`) adaptively caps how many results return:
single-answer → 1-2, enumerations → 6. The retrieval-side mirror of routing.

---

## B. Skill-Authoring Substrate (generation-time composition)

**B1. Template + resolver registry.** Skills are `.tmpl` files with
`{{PLACEHOLDER}}` markers; a flat `RESOLVERS` registry maps each placeholder to a
function emitting context-aware prose at build time. Add a capability once →
propagates to all skills. Decouples skill *content* from infrastructure
*plumbing*. **Highest-leverage pattern for a multi-skill repo.**

**B2. Preamble tiers.** Skills declare `preamble-tier: 1–4`; higher tiers inject
more shared scaffolding (context recovery, decision format, writing style).
Simple skills stay lean, complex ones get the full harness — no duplication.

**B3. Per-model overlays.** A `model-overlays/{claude,gpt,gemini}.md` dir holds
model-specific behavioral nudges injected at generation time. One skill source →
N model-tuned variants.

**B4. Host path polymorphism.** Host configs declare per-host roots; templates
emit `{{BIN_DIR}}`-style placeholders that resolve correctly per deployment
target. Directly relevant to multi-shell/multi-OS support.

**B5. Build-time density tuning** (`--explain-level=terse`,
`--catalog-mode=trim`) — one global verbosity/bandwidth choice at generation vs.
per-session at runtime.

---

## C. Delegation & Orchestration

**C1. Skill-as-prose delegation.** Instead of spawning subagents, an orchestrator
skill *reads another skill's file*, skips already-running preamble sections, and
executes the rest in the same session. Cheap composition, no process explosion,
supports deep chains (A→B→C).

**C2. Persona review panel.** Run the same artifact through multiple specialized
reviewer personas (CEO, Eng, Design, DX) in fixed order, each with its own
criteria, then synthesize. *(hexxu pulls from this family via the `plan-*-review`
skills.)*

**C3. Decision classification tiers.** Every intermediate decision is classified:
**Mechanical** (one right answer → auto-decide silently), **Taste** (reasonable
disagreement → auto-decide but surface at a final gate), **User-Challenge** (would
change the user's stated direction → NEVER auto-decide). Makes "auto-pilot with
guardrails" auditable.

**C4. Staged workflow with explicit gates.** Workflows as numbered steps (Step
0…N) with hard STOPs and soft AskUserQuestion gates between them; steps emit
artifacts later steps consume. Auditable, resumable, debuggable at step
granularity.

**C5. Cross-model tension resolution.** Two models review the same artifact;
agreement → high confidence, disagreement → classified into
adopt/escalate/user-challenge. Adversarial pairing to catch single-model blind
spots.

**C6. Stack-aware parallel specialist dispatch.** Detect tech stack, fan out
*independent* specialist subagents (security/perf/testing) in parallel,
merge+dedup findings. Plus **adaptive gating**: a specialist that finds nothing
over 10+ runs auto-silences.

**C7. Find→Verify→Fix loop with report-only mode.** QA skills run
find→fix→re-verify, committing each fix atomically, with a parallel report-only
variant as a pre-commit checkpoint. The atomic-commit + before/after-score
structure is universal for any quality gate.

**C8. Spawned-session auto-agree protocol.** An env flag
(`OPENCLAW_SESSION`/`SPAWNED_SESSION`) tells a skill it's driven by another agent:
suppress interactive prompts, auto-pick recommended options, return prose. Lets
orchestrators chain skills without deadlocking on gates.

---

## D. Memory & Knowledge

**D1. Append-only JSONL learnings with read-time dedup.** 🔁 Insights stored
one-JSON-per-line, keyed `(key, type)`, latest-timestamp-wins, semantic search at
session start. Append-only = corruption-proof; dedup-on-read = mutable knowledge
on immutable storage. Each entry carries `confidence` + `source`
(observed/stated/inferred) so old low-confidence guesses lose to fresh
observations.

**D2. Capture/recall as distinct lifecycle.** 🔁 Explicit heuristics for *what* to
remember vs skip, and recalled memory surfaced as **background context, not
instructions**.

**D3. Pluggable storage backends (gbrain).** One engine interface, multiple
implementations (PGLite local → Postgres/Supabase cloud). Start single-user
lightweight, scale to multi-tenant without rewrites — maps onto an A→B→C
trajectory.

**D4. Typed fact claims (gbrain).** Facts as
`(entity, metric, value, unit, period, valid_from)` tuples, enabling *automatic*
contradiction detection, trajectory graphs, calibration scoring — interpretation
decoupled from storage.

**D5. Autocut retrieval (score-discontinuity cutoff) (gbrain).** After reranking,
cut the result list at its largest score gap rather than a fixed threshold.
Measure-based, generalizes across models/domains, fail-open.

**D6. Free-text alias resolution layer (gbrain).** A separate alias table joined
at query time resolves nicknames/acronyms/romanizations — cheaper than
re-embedding. Single normalizer shared by ingest + query so aliases can't drift.

---

## E. Safety & Guardrails

**E1. Composable safety modes.** Guardrails as stackable toggleable modes:
`/careful` (warn on destructive cmds), `/freeze` (hard-block edits outside a dir
via state file + PreToolUse hook), `/guard` (both), `/unfreeze` (reset without
ending session). Scope-control separated from hard-safety.

**E2. Trust-boundary flag at the operation layer (gbrain).** A single
`remote: boolean` on every operation context (local CLI = trusted, MCP agent =
untrusted) gates security-sensitive behavior per-op. Cleaner than full RBAC.
*(hexxu design constraint #6 — "permission checks in extensions at the data
layer" — made concrete.)*

**E3. Scan-at-sink redaction.** Secret/PII scanning on the *exact bytes about to
be sent* (write temp file, scan it, pass the same file to `gh`/`git`) — not a
prescan+rerender that leaves gaps. Three tiers: HIGH=block, MEDIUM=confirm,
LOW=FYI; public repos get a sterner bar.

**E4. Layered injection defense with ensemble voting.** Multiple detectors
(deterministic canaries → ML classifier → transcript classifier) where BLOCK
requires 2+ layers agreeing at high confidence. No single classifier trusted
alone; reduces false positives on legitimate instruction-like content.

**E5. Soft-delete + TTL purge (gbrain).** Destructive ops set `deleted_at`, search
hides them, a purge phase hard-deletes after 72h. Recovery window + audit trail,
simpler than version control.

---

## F. Session State & Environment

**F1. Home-dir state, not DB, not git.** Session decisions live in
`~/.tool/projects/$SLUG/` keyed by git-toplevel slug. Survives branch switches,
editor restarts, multi-machine. Timestamp-named files (canonical ordering) beat
mtime (drifts on copy/rsync).

**F2. Config vs marker separation.** User *preferences* in an editable config
file; one-shot *state* gates (telemetry-prompted, feature-prompted) as empty
marker files. Changing a preference doesn't re-trigger one-shot prompts.

**F3. Environment-driven context detection.** Host sets env vars
(`CLAUDE_PLAN_FILE`, `OPENCLAW_SESSION`, skill-prefix config); the shared preamble
branches behavior once, read-once, no re-querying. Cross-process, zero skill-code
changes per host.

**F4. Resumable checkpoints with fingerprint reset (gbrain).** Long bulk ops
checkpoint every N items; resume skips completed; a content-hash fingerprint
auto-resets the checkpoint when inputs change (no manual state-wipe trap).

---

## G. Lifecycle / DevEx

**G1. Ad-hoc → durable skill promotion.** `/scrape` prototypes an interaction;
`/skillify` synthesizes `script.ts` + `script.test.ts` + fixture, runs the test,
asks before committing. The next equivalent request routes to the codified skill
(~10× faster). The general "graduate a successful one-off into a tested,
permanent capability" loop.

**G2. Docs-as-a-skill.** Documentation generation is itself a skill
(Diataxis-typed), with a post-ship variant that diff-audits coverage gaps and
calls the generator per gap. Docs ship as versioned, gated artifacts.

**G3. Self-update + environment-setup skills.** `setup-*` / `*-upgrade` skills
that configure the agent's own environment and self-update on session start. The
skill set bootstraps and maintains itself.

**G4. Structured decision brief format.** A checkable AskUserQuestion template
(ELI10 stakes, ≥2 pros/cons per option, recommendation+reason, completeness
score, `(recommended)` label that AUTO_DECIDE keys off). Machine-parseable *and*
human-readable; the same format drives interactive asks and auto-decisions.

---

## The meta-pattern

Strip away the specifics and the architecture of both systems is consistent:

> **The file is the system.** Skills, routing, memory, and config are all plain
> version-controlled files (YAML frontmatter, JSONL, markdown) — no runtime
> registry server, no DB for control-plane state. Generation-time resolvers
> compose them; runtime preambles read them once; home-dir state persists
> decisions.

> **Decisions are classified, not binary.** Mechanical/taste/challenge tiering +
> confidence/source on every memory + ensemble voting on every block. Autonomy
> scales with stakes.

> **Capabilities graduate.** Ad-hoc run → tested codified skill; single backend →
> pluggable; one host → N hosts via config. The system is built to move along a
> trajectory.

---

## Mapping to hexxu

Gap analysis against the current state of both repos (inventoried 2026-06-02).
Verdicts: **HAS** (implemented) · **PARTIAL** (foundation exists, pattern not
fully realised) · **MISSING** (no precedent). Each gap carries a proposed work
item with a **trigger** — per the SELECTIVE EXPANSION discipline in
`central-brain.md`, adopt individually when the trigger fires, not as a batch.

### Per-area verdicts

| Pattern | hexxu today | Verdict |
|---|---|---|
| A1 dual-channel triggers | `description` prose only; no `triggers:` keyword list | PARTIAL |
| A2 +/- intent boundaries | `scope` + `non_goals` manifest fields (T15) | **HAS** |
| A3 catalog trim | full description always in frontmatter | MISSING |
| A4 project routing override | no `## Skill routing` convention in CLAUDE.md | MISSING |
| A5 voice-triggers | none | MISSING |
| A6 intent-driven result sizing | n/a (no retrieval surface yet) | N/A |
| B1 template + resolver registry | skill-creator scaffolds a static starter `SKILL.md`; no placeholders | MISSING |
| B2 preamble tiers | frontmatter is locked schema; no tiering | MISSING |
| B3 per-model overlays | none (eval harness selects model, skills don't vary) | MISSING |
| B4 host path polymorphism | T16 hard-codes `win32` branches inline | PARTIAL |
| B5 build-time density tuning | none | MISSING |
| C1 skill-as-prose delegation | prompt templates are linear; no skill reads another | MISSING |
| C2 persona review panel | none in-repo (devs use Claude Code `/plan-*` externally) | MISSING |
| C3 decision classification | none | MISSING |
| C4 staged workflow + gates | `wr.md` is a linear checklist; no gates | PARTIAL |
| C5 cross-model tension | eval harness runs one model per pass | MISSING |
| C6 specialist dispatch | none | MISSING |
| C7 find→verify→fix loop | none (evals grade, don't fix-loop) | MISSING |
| C8 spawned-session auto-agree | none | MISSING |
| D1 append-only learnings + dedup | telemetry is append-only JSONL — but usage events, not insights | PARTIAL |
| D2 capture/recall lifecycle | telemetry captures; nothing recalls at session start | PARTIAL |
| D3 pluggable storage | local JSONL only; Supabase is a Phase-B revival item | PARTIAL |
| D4 typed fact claims | none | MISSING |
| D5 autocut retrieval | n/a | N/A |
| D6 alias resolution | n/a | N/A |
| E1 composable safety modes | none (skill edits are PR-gated, not session-scoped) | MISSING |
| E2 trust-boundary remote flag | constraint #6 stated; not yet a `remote` flag in code | PARTIAL |
| E3 scan-at-sink redaction | telemetry/sync write locally; no redaction before any sink | MISSING |
| E4 layered injection defense | none | MISSING |
| E5 soft-delete + TTL purge | telemetry rotates (50MB/90d); no soft-delete on data ops | PARTIAL |
| F1 home-dir state | `~/.hexxu/` cache + state files | **HAS** |
| F2 config vs marker separation | env-var config only; no marker files, no config file | PARTIAL |
| F3 env-driven context detection | `HEXXU_WORKER_ID` contract | **HAS** (single var) |
| F4 resumable checkpoints | sync is atomic clone (no partial state); no checkpointing | N/A |
| G1 ad-hoc → durable promotion | skill-creator promotes workspace → registry PR (manual) | PARTIAL |
| G2 docs-as-a-skill | `pi-docs-map` maps docs; no generate/release skill | MISSING |
| G3 self-update / setup | onboarding is manual multi-step; `hexxu onboard` deferred (T4) | PARTIAL |
| G4 structured decision-brief | `pr.md` uses Good/Bad/Ugly; no decision-brief/verdict format | PARTIAL |

### Proposed work items (with triggers)

Ordered by leverage-against-effort for Phase A, then deferred items.

**Near-term, low-cost, high-fit:**

- **T-RP1 — `## Skill routing` block convention (A4).** Document a routing
  section for worker `CLAUDE.md` mapping common intents → skills, and have the
  sync extension optionally inject a default once. *Trigger: registry reaches
  ~10 skills* (below that, pi's description-matching suffices).
- **T-RP2 — Learnings layer alongside telemetry (D1/D2).** Add an append-only
  `~/.hexxu/learnings.jsonl` (keyed `(key,type)`, latest-wins, `confidence` +
  `source`) and a recall step the sync extension runs at session start to
  surface matches as background context. Reuses the exact JSONL+0600+rotation
  machinery telemetry already has. *Trigger: when worker→dev feedback needs to
  compound across sessions* — directly serves the central-brain "10x" thesis.
- **T-RP3 — Host-path resolver for T16 (B4).** Replace the inline `win32`
  branches with a tiny host-config indirection (path/symlink-style/uuid-cmd per
  platform), so adding a third environment doesn't fork the extensions.
  *Trigger: a third runtime target appears, or the T16 branches need a second
  edit.*

**Medium-term, as the skill set grows:**

- **T-RP4 — `triggers:` + optional `voice-triggers:` manifest fields (A1/A5).**
  Additive schema fields feeding the routing oracle. *Trigger: routing-margin
  CI shows description-only matching missing intents.*
- **T-RP5 — Catalog trim (A3).** Split manifest `description` into lead +
  routing-prose registry once frontmatter load cost matters. *Trigger: ~50
  skills, or measured context cost at session start.*
- **T-RP6 — Decision-classification taxonomy in prompt templates (C3/G4).**
  Add mechanical/taste/challenge tiering + a structured decision-brief format to
  `pr.md`/`is.md`/`wr.md`. Pure prompt-template work, no code. *Trigger: when
  worker prompts start auto-deciding things that need a human gate.*
- **T-RP7 — Skill-template substrate (B1/B2).** Introduce `.tmpl` + a small
  resolver registry in skill-creator so shared preamble/boilerplate is generated,
  not copy-pasted. Highest structural leverage but also highest effort. *Trigger:
  ≥3 skills sharing copy-pasted preamble, or the eval-gate going live.*

**Deferred / Phase B (revival-triggered, not now):**

- **T-RP8 — Trust-boundary `remote` flag (E2).** Make constraint #6 concrete
  when extensions gain a network/multi-tenant data path. *Trigger: Phase-B
  Supabase/federation work begins.*
- **T-RP9 — Scan-at-sink redaction (E3).** Add when telemetry/data first leaves
  the worker's machine. *Trigger: remote telemetry sink lands (currently
  local-only).*
- **T-RP10 — Pluggable storage backend (D3).** The JSONL→Postgres step is
  already the documented A→B trajectory; adopt the engine-interface shape then.
  *Trigger: Phase-B postgres pillar.*

**Explicitly NOT pursuing** (out of scope for a single-dev, file-based,
PR-gated registry): composable session safety modes (E1) — PR review already
bounds edits; specialist-dispatch / persona panels in-repo (C2/C6) — devs run
these via Claude Code externally; injection-defense ensemble (E4) — no untrusted
content sink exists yet.

### Highest-leverage four

If only a few land in Phase A, these have the best fit-to-effort and most
directly serve the central-brain compounding thesis:

1. **T-RP2 (learnings layer)** — turns telemetry from accounting into a
   feedback loop; small, reuses existing machinery.
2. **T-RP1 (routing block)** — cheap, scales skill discovery as the registry
   grows.
3. **T-RP6 (decision classification)** — prompt-only, sharpens every worker
   prompt.
4. **T-RP3 (host-path resolver)** — pays down the T16 inline-branch debt before
   it spreads.
