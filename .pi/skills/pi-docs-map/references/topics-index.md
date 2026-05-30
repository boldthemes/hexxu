# Pi documentation topics index

Use this file to map user questions to the right pi documentation files.

## Canonical documentation roots

- Installed README: `/home/macak/.nvm/versions/node/v24.15.0/lib/node_modules/@earendil-works/pi-coding-agent/README.md`
- Installed docs root: `/home/macak/.nvm/versions/node/v24.15.0/lib/node_modules/@earendil-works/pi-coding-agent/docs`
- Installed examples root: `/home/macak/.nvm/versions/node/v24.15.0/lib/node_modules/@earendil-works/pi-coding-agent/examples`

## Topic routing

| Topic | Read first | Also read | Examples |
|---|---|---|---|
| overview / what is pi | `README.md` | `docs/index.md`, `docs/quickstart.md`, `docs/usage.md` | `examples/README.md` |
| install / quick start | `README.md`, `docs/quickstart.md` | `docs/usage.md`, platform docs | — |
| interactive mode / commands / editor | `README.md`, `docs/usage.md` | `docs/settings.md`, `docs/keybindings.md` | — |
| keyboard shortcuts / keybindings | `docs/keybindings.md` | `README.md`, `docs/settings.md` | — |
| providers / auth / login | `README.md`, `docs/providers.md` | `docs/models.md`, `docs/custom-provider.md` | `examples/sdk/09-api-keys-and-oauth.ts` |
| models / scoped models / custom models | `docs/models.md` | `README.md`, `docs/providers.md`, `docs/custom-provider.md` | `examples/sdk/02-custom-model.ts` |
| custom providers | `docs/custom-provider.md` | `docs/models.md`, `docs/providers.md`, `docs/sdk.md` | `examples/extensions/custom-provider-anthropic/index.ts`, `examples/extensions/custom-provider-gitlab-duo/index.ts` |
| settings | `docs/settings.md` | `README.md`, `docs/keybindings.md` | `examples/sdk/10-settings.ts` |
| sessions / resume / fork / clone / tree | `docs/sessions.md` | `docs/session-format.md`, `docs/compaction.md`, `README.md` | `examples/sdk/11-sessions.ts`, `examples/sdk/13-session-runtime.ts` |
| compaction | `docs/compaction.md` | `docs/sessions.md`, `README.md` | `examples/extensions/custom-compaction.ts`, `examples/extensions/trigger-compact.ts` |
| JSON mode / print mode | `docs/json.md` | `README.md`, `docs/rpc.md` | — |
| RPC mode | `docs/rpc.md` | `docs/json.md`, `docs/sdk.md` | `examples/rpc-extension-ui.ts`, `examples/extensions/rpc-demo.ts` |
| SDK embedding | `docs/sdk.md` | `README.md`, `docs/models.md`, `docs/providers.md`, `docs/skills.md`, `docs/extensions.md` | `examples/sdk/README.md`, `examples/sdk/01-minimal.ts` through `examples/sdk/13-session-runtime.ts` |
| extensions | `docs/extensions.md` | `docs/tui.md`, `docs/skills.md`, `docs/themes.md`, `docs/custom-provider.md` | `examples/extensions/README.md` plus relevant extension examples |
| themes | `docs/themes.md` | `docs/tui.md`, `docs/settings.md` | theme-related extension examples if needed |
| skills | `docs/skills.md` | `README.md`, `docs/extensions.md`, `docs/packages.md` | `examples/sdk/04-skills.ts`, `examples/extensions/dynamic-resources/SKILL.md` |
| prompt templates | `docs/prompt-templates.md` | `README.md`, `docs/skills.md`, `docs/packages.md` | `examples/sdk/08-prompt-templates.ts` |
| TUI / terminal UI APIs | `docs/tui.md` | `packages/tui/README.md`, `docs/themes.md`, `docs/extensions.md` | extension examples that render UI, overlays, widgets, and editors |
| pi packages | `docs/packages.md` | `docs/extensions.md`, `docs/skills.md`, `docs/prompt-templates.md`, `docs/themes.md` | — |
| development / contributing | `docs/development.md` | root `CONTRIBUTING.md`, root `AGENTS.md`, source repo `README.md` | — |
| platform setup: Windows | `docs/windows.md` | `docs/terminal-setup.md`, `docs/keybindings.md` | — |
| platform setup: Termux | `docs/termux.md` | `docs/terminal-setup.md` | — |
| platform setup: tmux | `docs/tmux.md` | `docs/terminal-setup.md` | — |
| terminal configuration / shell aliases | `docs/terminal-setup.md`, `docs/shell-aliases.md` | platform docs | — |
| repository docs inventory | `references/file-map.md` | source repo `README.md`, package READMEs | — |
| AI library details | source repo `packages/ai/README.md` | source repo `README.md` | — |
| agent core details | source repo `packages/agent/README.md` | source repo `README.md` | — |
| TUI package details | source repo `packages/tui/README.md`, `docs/tui.md` | source repo `README.md` | — |

## Topic synonyms

Use these aliases when matching user intent:

- extension API, hooks, custom commands, overlays, widgets → `extensions`
- skill authoring, skill layout, skill command, Agent Skills → `skills`
- prompt macros, slash prompt commands → `prompt templates`
- themes, colors, styling → `themes`
- terminal UI, component API, overlay API, editor widget → `TUI`
- auth, login, provider setup, API keys, subscription providers → `providers`
- model selection, custom model config, model list → `models`
- local docs, repo docs, available files, documentation in repository → `repository docs inventory`

## Reading rules

- Read the actual mapped files before answering.
- Read each markdown file completely.
- Follow cross-references when the main page points to another required page.
- For implementation examples, prefer examples from the installed examples directory.
- When the user wants repository paths, include the source checkout paths from `references/file-map.md`.
