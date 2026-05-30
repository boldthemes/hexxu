---
name: meeting-action-items
description: Extracts action items, owners, due dates, decisions, blockers, dependencies, and open questions from messy meeting notes, call transcripts, and brainstorm bullets. Use when you need a clear post-meeting follow-up or tracker-ready task list from incomplete, informal, or out-of-order notes.
---

# Meeting Action Items

Use this skill when the user has rough meeting notes and wants a clean, actionable follow-up.

## What this skill owns

This skill is for turning unstructured notes into a useful execution summary:

- identify explicit action items
- extract owners, deadlines, dependencies, and status cues
- separate decisions from follow-up work
- preserve unresolved questions, risks, and blockers
- rewrite vague bullets into clear next-step language
- make uncertainty visible instead of inventing missing facts

## What this skill should avoid

- do not invent owners, due dates, decisions, or commitments that are not supported by the notes
- do not present guesses as facts
- do not collapse distinct tasks into one vague item
- do not turn every discussion point into an action item
- do not lose important nuance when cleaning up messy phrasing

## Default workflow

1. Read through the notes once for overall context.
2. Identify:
   - decisions already made
   - explicit action items
   - implied follow-ups that are strongly supported by the notes
   - which items are explicit versus inferred
   - owners, teams, tentative owners, or speaker cues that suggest ownership
   - dates, deadlines, and time references
   - blockers, dependencies, and risks
   - open questions or unresolved items
3. Clean up the language:
   - turn fragments into complete actions starting with a verb
   - split compound bullets into separate tasks
   - merge duplicates when they clearly refer to the same follow-up
   - keep useful qualifiers such as urgency, dependency, or uncertainty
4. Handle uncertainty carefully:
   - if an owner is missing, mark it as `Unassigned`
   - if a due date is missing, mark it as `TBD`
   - if a task is inferred rather than explicit, label it clearly
   - if an owner or deadline is only tentative, mark that uncertainty in `Notes`
   - if the notes are too ambiguous, ask up to 3 targeted clarifying questions instead of guessing
   - if the user likely wants a quick first pass, provide a best-effort draft and put uncertain details in `Needs Confirmation`
5. Match the user's requested format when one is given. If no format is requested, use the default format below.
6. Produce a structured output that separates action items, decisions, and unresolved issues.

## Default output format

### Summary

Give a short 2-4 bullet summary of the meeting's main outcomes and next-step themes.

### Action Items

Use a table when it fits:

| Action item | Owner | Due | Notes |
| --- | --- | --- | --- |

Guidance:

- keep each action item specific and implementation-oriented
- use `Unassigned` when no owner is given
- use `TBD` when no due date is given
- use `Notes` for dependencies, blockers, confidence, or brief context

### Decisions

List decisions that were clearly made.

### Open Questions / Risks

List unresolved items, assumptions that need confirmation, or issues that may block progress.

### Needs Confirmation

Include this section only when the notes are ambiguous enough that the user should verify an owner, deadline, or inferred next step.

## Writing guidance

- Prefer concise, operational wording over verbatim cleanup.
- Prefer one clear, verb-led action per row or bullet.
- Keep names, dates, and commitments faithful to the source notes.
- Preserve relative dates such as `next Friday` as written unless the provided context lets you resolve them confidently.
- Treat speaker attribution as evidence, not proof, of ownership.
- Separate decisions from tasks even when they appear in the same bullet.
- When the notes contain ambiguity, surface it explicitly.
- If the user asks for another format such as a checklist, Jira-style tickets, JSON, or an email-ready follow-up, keep the same underlying extraction but adapt the presentation.
- If the notes are extremely rough, it is better to provide a best-effort structured draft plus a short confirmation section than to overstate certainty.
- If there are very few true action items, say so instead of padding the output.

## Trigger guidance

This skill should trigger when the user wants help with any of the following:

- turning meeting notes into action items
- cleaning up call notes, workshop notes, or brainstorm notes into next steps
- extracting follow-ups, owners, or deadlines from messy bullets
- preparing a post-meeting summary with decisions and next actions
- converting rough notes into a checklist, tracker-ready task list, or follow-up email draft

This skill should usually not trigger for:

- general meeting summarization with no need for action extraction
- transcript editing unrelated to follow-up work
- project planning from scratch without source notes
- generic to-do list brainstorming that is not based on meeting content
