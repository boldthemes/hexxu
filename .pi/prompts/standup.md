---
description: Draft a standup update from git history since yesterday
argument-hint: "[since]"
---
Prepare a standup update from local git activity.

Time-range override from the command arguments: `$ARGUMENTS`
- If the override is empty, use `yesterday`.
- Otherwise, use the override verbatim as the value for `git log --since`.

Workflow:
1. Read the local git history for the selected range, starting with:
   - `git log --since="<range>" --reverse --stat --decorate`
2. If the log is not enough to understand the work, inspect the most relevant commits with `git show --stat --summary <sha>` and read any key changed files needed for accurate summarization.
3. Summarize the work into our standard standup format.

Requirements:
- Base `Yesterday` on actual git history, not guesses.
- `Today` should be the most likely next steps implied by the recent work. If evidence is weak, keep it conservative and concrete.
- `Blockers` must only include real blockers visible from the git history or conversation. If none are clear, say `- None`.
- Keep the update concise, specific, and written in first person.
- Group related commits into a single bullet instead of listing commit messages.
- Do not include commit SHAs, raw command output, or extra commentary outside the format.

Output exactly in this format:

Yesterday:
- ...

Today:
- ...

Blockers:
- ...
