# Prompt evals

Data-driven contract tests for prompts you send directly to OpenAI `gpt-4o-mini`.

## Local usage

Run the harness from the repo root:

```bash
OPENAI_API_KEY=... bash ./.pi/sdk/prompt-evals/test.sh
```

To run only a subset of suites or cases:

```bash
PROMPT_EVALS_FILTER=refund OPENAI_API_KEY=... bash ./.pi/sdk/prompt-evals/test.sh
```

## CI

`.github/workflows/prompt-evals.yml` runs this harness on pushes and pull requests to `main`.
Set the repository secret `OPENAI_API_KEY` so CI can hit the real model.

If the secret is missing, the workflow still validates the harness and suite files, but skips the live OpenAI calls.

## File format

Create one or more `*.eval.json` files in this directory.

```json
{
  "suiteId": "my-prompts",
  "description": "Contract tests for a prompt family.",
  "modelId": "gpt-4o-mini",
  "defaults": {
    "systemPrompt": "You are a precise assistant. Follow instructions exactly.",
    "temperature": 0,
    "maxTokens": 200,
    "repeat": 2,
    "passThreshold": 2,
    "timeoutMs": 30000,
    "messages": [
      { "role": "user", "content": "Optional shared setup message" }
    ]
  },
  "cases": [
    {
      "id": "exact-echo",
      "prompt": "Reply with exactly: ok",
      "assertions": {
        "equals": "ok"
      }
    }
  ]
}
```

## Supported assertions

- `equals`: exact text match after trimming and normalizing newlines
- `contains`: every string must appear in the response
- `containsAny`: at least one string must appear
- `notContains`: strings that must not appear
- `regex`: every regex must match; use either a string pattern or `{ "pattern": "...", "flags": "m" }`
- `notRegex`: regexes that must not match
- `json.requiredPaths`: dot-paths that must exist after parsing the response as JSON
- `json.equals`: exact matches for JSON values
- `json.contains`: substring checks against string values in parsed JSON

## Tips

- Prefer short, stable contract checks over snapshotting long free-form outputs.
- Use `repeat` plus `passThreshold` when a prompt has mild variance.
- Start by copying your current ad hoc scripts into a few representative cases, then tighten the assertions until they catch real regressions without being brittle.
