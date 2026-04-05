# pi-claude-plan-mode

A Pi extension package that recreates the core feel of Claude Code's plan mode:

- read-only planning phase
- persistent per-session plan file
- explicit `enter_plan_mode -> update_plan -> request_plan_approval` workflow
- approval gate before normal coding tools are restored
- optional fresh-session implementation handoff
- plan-file continuity when re-entering planning later
- custom visual plan review panel with scrolling preview and approval actions
- prompt text separated into a dedicated file for easy tweaking

## What it reproduces

This package intentionally mirrors the parts of Claude Code plan mode that map well onto Pi's extension API:

1. `plan` becomes a real extension state, not just a user prompt.
2. The agent gets a strong planning prompt with a canonical plan artifact.
3. Normal file-editing tools are removed during planning.
4. Only read-only tools plus plan tools stay active.
5. Bash is filtered to block obvious mutating commands.
6. The model must use `request_plan_approval` instead of asking for approval in plain text.
7. Approval can continue in-place or branch into a fresh implementation session.

## Where the prompt lives

The main planning prompt is in:

- `extensions/claude-plan-mode/prompts.ts`

The most important function is:

- `getPlanModeContextMessage()`

That is the closest analogue to Claude Code's injected plan-mode instructions.

The visual approval panel lives in:

- `extensions/claude-plan-mode/review-ui.ts`

## Commands

- `/claude-plan` - enable plan mode
- `/claude-plan off` - disable it
- `/claude-plan show` - open the current plan file in Pi's editor
- `/claude-plan edit` - same as `show`, but meant as an editing entrypoint
- `/claude-plan some task here` - enable plan mode and immediately send that task to the agent
- `/claude-plan-prompt` - preview the injected planning prompt
- `/claude-plan-apply-fresh` - internal command used for fresh-session handoff after approval

Shortcut:

- `Ctrl+Alt+P` - toggle plan mode

Flag:

- `--claude-plan` - start the session in plan mode

## Tools exposed to the model

- `enter_plan_mode`
- `update_plan`
- `request_plan_approval`

Suggested flow:

1. The model calls `enter_plan_mode` for a non-trivial task, or the user starts with `/claude-plan`.
2. During planning, the model keeps rewriting the full markdown plan with `update_plan`.
3. When the plan is ready, the model calls `request_plan_approval`.
4. `request_plan_approval` opens a custom review panel with a scrollable plan preview and explicit actions.
5. If approved, the user can either keep implementing in the current session or start from a fresh implementation session.
6. Fresh-session approval turns the approved plan into the first prompt of the new session: `Implement the following approved plan:`

## Plan file location

Per-session plans are written to:

- `.pi/claude-plan-mode/plans/<session-id>.md`

This keeps the artifact local to the project and avoids touching product source files during planning.

When the user approves into a fresh session, that new session inherits the same plan path so later re-entry still points at the same artifact.

## Install locally into a project

```bash
pi install -l /absolute/path/to/pi-claude-plan-mode
```

Or run directly for testing:

```bash
pi -e /absolute/path/to/pi-claude-plan-mode/extensions/claude-plan-mode/index.ts
```

## Important differences from real Claude Code

This is an approximation, not a byte-for-byte clone.

What Pi can do well here:

- inject planning instructions
- change active tool sets
- block tool calls
- persist plan-mode state
- show approval dialogs

What Pi cannot fully mirror without deeper core changes:

- Claude Code's native permission-mode state machine
- its exact hidden attachment protocol
- model-routing tricks like `opusplan`
- write access to only one built-in file path without introducing a custom plan tool

So this package uses a pragmatic Pi-native design:

- built-in `edit` and `write` are disabled during planning
- a custom `update_plan` tool is the only write path
- approval uses a custom plan review panel with keyboard navigation
- fresh-session handoff is emulated with `ctx.newSession()` plus a queued internal slash command

## Notes for prompt hacking

If you want to make it feel even closer to Claude Code, start by editing these functions in `extensions/claude-plan-mode/prompts.ts`:

- `getPlanModeContextMessage()`
- `getEnterPlanModeToolResult()`
- `getKeepPlanningToolResult()`
- `getApprovedPlanToolResult()`
- `getFreshSessionImplementationPrompt()`

Those strings define most of the behavior the model feels while moving between planning and execution.
