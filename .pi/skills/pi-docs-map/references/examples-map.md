# Pi examples map

Use this file when the documentation points to examples or when the user asks for concrete implementation references.

## Example roots

- `/home/macak/.nvm/versions/node/v24.15.0/lib/node_modules/@earendil-works/pi-coding-agent/examples/README.md`
- `/home/macak/.nvm/versions/node/v24.15.0/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/README.md`
- `/home/macak/.nvm/versions/node/v24.15.0/lib/node_modules/@earendil-works/pi-coding-agent/examples/sdk/README.md`

## SDK examples

Read these when the user wants embedding or programmatic usage:

- `examples/sdk/01-minimal.ts` — smallest SDK setup
- `examples/sdk/02-custom-model.ts` — custom model selection
- `examples/sdk/03-custom-prompt.ts` — custom prompts
- `examples/sdk/04-skills.ts` — loading and using skills
- `examples/sdk/05-tools.ts` — custom tools
- `examples/sdk/06-extensions.ts` — extension integration from SDK usage
- `examples/sdk/07-context-files.ts` — context files
- `examples/sdk/08-prompt-templates.ts` — prompt templates from SDK
- `examples/sdk/09-api-keys-and-oauth.ts` — auth and provider configuration
- `examples/sdk/10-settings.ts` — settings configuration
- `examples/sdk/11-sessions.ts` — session management
- `examples/sdk/12-full-control.ts` — advanced control
- `examples/sdk/13-session-runtime.ts` — session runtime details

Resolve those against:

- `/home/macak/.nvm/versions/node/v24.15.0/lib/node_modules/@earendil-works/pi-coding-agent/examples/sdk/`

## Extension examples by theme

### Basic structure and simple hooks

- `examples/extensions/hello.ts`
- `examples/extensions/commands.ts`
- `examples/extensions/tools.ts`
- `examples/extensions/event-bus.ts`
- `examples/extensions/reload-runtime.ts`

### Input and prompt behavior

- `examples/extensions/input-transform.ts`
- `examples/extensions/input-transform-streaming.ts`
- `examples/extensions/prompt-customizer.ts`
- `examples/extensions/send-user-message.ts`
- `examples/extensions/structured-output.ts`

### UI and rendering

- `examples/extensions/custom-header.ts`
- `examples/extensions/custom-footer.ts`
- `examples/extensions/status-line.ts`
- `examples/extensions/widget-placement.ts`
- `examples/extensions/message-renderer.ts`
- `examples/extensions/built-in-tool-renderer.ts`
- `examples/extensions/border-status-editor.ts`
- `examples/extensions/rainbow-editor.ts`
- `examples/extensions/overlay-test.ts`
- `examples/extensions/overlay-qa-tests.ts`
- `examples/extensions/question.ts`
- `examples/extensions/questionnaire.ts`
- `examples/extensions/qna.ts`

### TUI-heavy examples

- `examples/extensions/doom-overlay/index.ts`
- `examples/extensions/modal-editor.ts`
- `examples/extensions/minimal-mode.ts`
- `examples/extensions/model-status.ts`

### Workflow automation and safeguards

- `examples/extensions/auto-commit-on-exit.ts`
- `examples/extensions/dirty-repo-guard.ts`
- `examples/extensions/confirm-destructive.ts`
- `examples/extensions/permission-gate.ts`
- `examples/extensions/protected-paths.ts`
- `examples/extensions/git-checkpoint.ts`
- `examples/extensions/git-merge-and-resolve.ts`
- `examples/extensions/session-name.ts`
- `examples/extensions/shutdown-command.ts`
- `examples/extensions/notify.ts`

### Shell and external process integration

- `examples/extensions/inline-bash.ts`
- `examples/extensions/interactive-shell.ts`
- `examples/extensions/ssh.ts`
- `examples/extensions/bash-spawn-hook.ts`

### Custom provider examples

- `examples/extensions/custom-provider-anthropic/index.ts`
- `examples/extensions/custom-provider-gitlab-duo/index.ts`
- `examples/extensions/provider-payload.ts`

### Skills and packaged resources

- `examples/extensions/dynamic-resources/SKILL.md`
- `examples/extensions/dynamic-resources/index.ts`
- `examples/extensions/preset.ts`

### Advanced / experimental workflow examples

- `examples/extensions/handoff.ts`
- `examples/extensions/subagent/index.ts`
- `examples/extensions/plan-mode/index.ts`
- `examples/extensions/custom-compaction.ts`
- `examples/extensions/trigger-compact.ts`
- `examples/extensions/tool-override.ts`

## Reading rules

- Read the main doc first, then the example.
- If a topic is extension-related, start with `docs/extensions.md` before reading example code.
- If a topic is TUI-related, read `docs/tui.md` and then the UI-oriented extension examples.
- If a topic is SDK-related, read `docs/sdk.md` and then the specific `examples/sdk/...` file.
- If a topic is custom-provider-related, read `docs/custom-provider.md` plus the relevant custom-provider example.
