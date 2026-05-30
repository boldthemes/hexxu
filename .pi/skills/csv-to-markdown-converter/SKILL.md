---
name: csv-to-markdown-converter
description: Builds or improves CSV-to-Markdown converters, scripts, and CLIs. Use when the user wants to turn CSV data into markdown tables or markdown documents, or needs help with CSV parsing rules, markdown escaping, formatting options, and tests for that workflow.
---

# CSV to Markdown Converter

Use this skill when the task is to implement, debug, or refine code that converts CSV input into markdown output.

## What this skill owns

This skill is for requests where markdown output is the point and CSV parsing details matter:

- clarify the exact conversion target: markdown table, README snippet, or a richer markdown document
- inspect sample CSV inputs and existing code before changing logic
- choose a parser strategy that handles real CSV behavior instead of only toy inputs
- define output rules for headers, alignment, escaping, empty cells, and malformed rows
- implement the converter incrementally
- add focused tests and example fixtures
- surface ambiguities instead of hardcoding guesses

## What this skill should avoid

- do not parse CSV with a naive `split(",")` approach when quoted fields, escaped quotes, embedded commas, or embedded newlines are possible
- do not assume the first row is a header unless requested or strongly indicated
- do not silently drop rows, columns, or whitespace-sensitive content without telling the user
- do not overengineer with large dependencies if the language runtime or current project already has a solid CSV parser available
- do not bake one-off cleanup rules into a supposedly generic converter without making those rules explicit

## Default workflow

1. Clarify the requested behavior.
   - input source: file, stdin, pasted text, or in-memory data
   - output form: plain markdown table or richer markdown
   - headers: existing header row, inferred headers, or custom headers
   - options: column selection, renaming, ordering, alignment, filtering, sorting, row limits
   - malformed input handling: fail fast, warn, or best-effort rendering
2. Inspect the current state.
   - read existing converter code, tests, fixtures, and CLI docs
   - if there is no representative input, ask for or create a tiny fixture that includes likely edge cases
3. Lock down conversion rules before coding.
   - choose the parser strategy
   - define how to handle missing cells, extra cells, and blank lines
   - decide how markdown-sensitive characters are rendered inside cells
   - decide whether whitespace is preserved exactly or normalized
4. Implement in small steps.
   - parse input
   - build an internal row model
   - render markdown header, separator, and body rows
   - thread CLI or API options through cleanly
5. Validate with focused examples.
   - simple CSV with headers
   - quoted commas
   - embedded quotes
   - empty cells
   - pipes or markdown-like content inside cells
   - no-header or custom-header behavior when relevant
6. Report the result.
   - summarize what changed
   - call out assumptions and remaining ambiguities
   - show example output when useful

## CSV parsing guidance

- Prefer a real CSV parser from the standard library or an existing dependency when available.
- If the user explicitly wants a lightweight custom parser, warn about the limits and test quoted fields carefully.
- Treat these as first-class edge cases:
  - commas inside quoted cells
  - escaped quotes like `""`
  - CRLF vs LF line endings
  - blank lines
  - inconsistent column counts
  - leading or trailing spaces that may or may not be significant

## Markdown rendering guidance

- Default to GitHub-flavored markdown tables unless the user requests another markdown structure.
- Make sure cell content does not accidentally break the table:
  - replace literal newlines in cells with `<br>` or another requested representation
  - escape `|` where needed
  - preserve code-like text without making the output unreadable
- If alignment matters, render the separator row intentionally rather than leaving alignment accidental.
- If the source data does not fit well into a markdown table, say so and propose a better markdown representation.

## Testing guidance

When adding or revising tests, prioritize compact cases that prove the converter handles:

- a normal header row
- quoted commas
- quotes inside values
- markdown-breaking characters in cells
- empty or missing values
- malformed input behavior

## Output guidance

- For coding tasks, give a short plan, make the code changes, then summarize the resulting behavior.
- For one-off conversion requests, return the converted markdown and briefly note any assumptions.
- When requirements are ambiguous, ask the smallest clarifying question that would materially change the implementation.

## Trigger guidance

This skill should trigger when the user wants help with any of the following:

- building a CSV-to-markdown converter
- fixing CSV parsing bugs in markdown table output
- adding tests or CLI options to a CSV-to-markdown script
- converting CSV files or strings into markdown tables or markdown documents with careful handling of parsing and escaping

This skill should usually not trigger for:

- generic CSV analysis with no markdown output
- markdown editing unrelated to CSV data
- broad ETL or data-cleaning tasks that only happen to mention CSV
- conversions to HTML, JSON, or spreadsheet formats unless markdown output is central
