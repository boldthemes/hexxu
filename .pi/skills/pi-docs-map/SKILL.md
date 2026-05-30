---
name: pi-docs-map
description: Maps pi documentation topics to the right files and examples. Use when answering questions about pi itself, its CLI, SDK, extensions, themes, skills, prompt templates, TUI, providers, models, packages, sessions, settings, or when checking what documentation exists in the local pi source checkout.
---

# Pi Documentation Mapper

Use this skill when the user asks about pi itself or wants help finding the right local documentation files.

## Documentation roots

Treat these as the primary documentation sources:

- Installed main README:
  - `/home/macak/.nvm/versions/node/v24.15.0/lib/node_modules/@earendil-works/pi-coding-agent/README.md`
- Installed docs root:
  - `/home/macak/.nvm/versions/node/v24.15.0/lib/node_modules/@earendil-works/pi-coding-agent/docs`
- Installed examples root:
  - `/home/macak/.nvm/versions/node/v24.15.0/lib/node_modules/@earendil-works/pi-coding-agent/examples`

Also use these local source-checkout files when the user explicitly asks about the repository checkout or wants to know what docs exist in the repo:

- Source repo root:
  - `/home/macak/Development/hexxu/pisource`
- Source repo coding-agent docs:
  - `/home/macak/Development/hexxu/pisource/packages/coding-agent/docs`
- Source repo package READMEs:
  - `/home/macak/Development/hexxu/pisource/packages/coding-agent/README.md`
  - `/home/macak/Development/hexxu/pisource/packages/agent/README.md`
  - `/home/macak/Development/hexxu/pisource/packages/ai/README.md`
  - `/home/macak/Development/hexxu/pisource/packages/tui/README.md`

## Routing references

Start with these files in this skill:

- `references/topics-index.md` — topic-to-file routing guide
- `references/file-map.md` — inventory of installed docs and source repo docs
- `references/examples-map.md` — examples to consult for extensions and SDK usage

## Workflow

1. Identify the user topic using `references/topics-index.md`.
2. Read every mapped `.md` file completely. If a file is truncated, continue reading with larger offsets until complete.
3. Follow cross-references when the main doc points to related docs, especially for:
   - `extensions`
   - `themes`
   - `skills`
   - `prompt templates`
   - `tui`
   - `keybindings`
   - `sdk`
   - `custom providers`
   - `models`
   - `pi packages`
4. When a topic is example-heavy, also consult `references/examples-map.md` and read the relevant example files.
5. Prefer the installed docs as the canonical documentation set. Use the source checkout when:
   - the user asks about files in `/home/macak/Development/hexxu/pisource`
   - the user asks whether the repository contains documentation
   - the user wants local repository paths
6. Do not guess. If the answer depends on specifics, read the actual docs.

## Path resolution rules

When a doc mentions paths like `docs/foo.md` or `examples/bar/...`, resolve them against the installed pi package roots, not the current working directory:

- `docs/...` → `/home/macak/.nvm/versions/node/v24.15.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/...`
- `examples/...` → `/home/macak/.nvm/versions/node/v24.15.0/lib/node_modules/@earendil-works/pi-coding-agent/examples/...`

When the question is specifically about the local repository checkout, use the parallel source paths under `/home/macak/Development/hexxu/pisource`.

## Response format

When answering, structure the response like this when helpful:

- `Topic matched:` short label
- `Files consulted:` bullet list of actual paths read
- `Answer:` concise explanation
- `Related docs:` optional next files to read

## Short routing guide

Use these topic/file pairs first:

- extensions → `docs/extensions.md` + relevant `examples/extensions/...`
- themes → `docs/themes.md`
- skills → `docs/skills.md`
- prompt templates → `docs/prompt-templates.md`
- TUI → `docs/tui.md`
- keybindings → `docs/keybindings.md`
- SDK → `docs/sdk.md` + `examples/sdk/...`
- providers setup → `docs/providers.md`
- models and custom models → `docs/models.md`
- custom provider integrations → `docs/custom-provider.md` + relevant examples
- packages → `docs/packages.md`
- sessions → `docs/sessions.md` + `docs/session-format.md`
- settings → `docs/settings.md`
- compaction → `docs/compaction.md`
- JSON mode → `docs/json.md`
- RPC → `docs/rpc.md`
- platform/terminal setup → `docs/windows.md`, `docs/termux.md`, `docs/tmux.md`, `docs/terminal-setup.md`, `docs/shell-aliases.md`

If the user asks what documentation exists in the repo, consult `references/file-map.md` and report the local source paths.
