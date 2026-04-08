# pi-claude-plan-mode

A Pi extension package that recreates the core feel of Claude Code's plan mode:

- read-only planning phase
- persistent per-session plan file
- explicit `enter_plan_mode -> update_plan -> request_plan_approval` workflow
- approval gate before normal coding tools are restored
- optional fresh-session implementation handoff
- plan-file continuity when re-entering planning later
- safe plan review flow that opens the full plan in Pi's built-in editor and then asks for the next action
- optional AskUserQuestion integration for Claude-style clarifying questions during planning
- prompt text separated into a dedicated file for easy tweaking

## What it reproduces

This package intentionally mirrors the parts of Claude Code plan mode that map well onto Pi's extension API:

1. `plan` becomes a real extension state, not just a user prompt.
2. The agent gets a strong planning prompt with a canonical plan artifact.
3. Normal file-editing tools are removed during planning.
4. Only read-only tools plus plan tools stay active, including research tools like `web_search`, `webfetch`, and `recursive_webfetch` when installed.
5. If `AskUserQuestion` is installed, plan mode keeps it active for structured clarifying questions.
6. Bash stays available for read-only inspection and is filtered only to block obvious mutating commands.
7. The model must use `request_plan_approval` instead of asking for approval in plain text.
8. Approval can continue in-place or branch into a fresh implementation session.

## Where the prompt lives

The main planning prompt is in:

- `extensions/claude-plan-mode/prompts.ts`

The most important function is:

- `getPlanModeContextMessage()`

That is the closest analogue to Claude Code's injected plan-mode instructions.

The approval review flow lives in:

- `extensions/claude-plan-mode/review-ui.ts`

## Commands

- `/claude-plan` - enable plan mode
- `/claude-plan off` - disable it (`disable` and `exit` also work)
- `/claude-plan show` - open the current plan file in Pi's editor
- `/claude-plan edit` - same as `show`, but meant as an editing entrypoint
- `/claude-plan apply-fresh` - if a fresh-session approval is pending, open the new implementation session and trigger the carried implementation prompt from the new session startup flow
- `/claude-plan some task here` - enable plan mode and immediately send that task to the agent

Shortcut:

- `Ctrl+Alt+P` - toggle plan mode

Flag:

- `--claude-plan` - start the session in plan mode

## Tools exposed to the model

- `enter_plan_mode`
- `update_plan`
- `request_plan_approval`

If `pi-claude-code-ask-user` is also loaded, plan mode additionally keeps:

- `AskUserQuestion`

Suggested flow:

1. The model calls `enter_plan_mode` for a non-trivial task, or the user starts with `/claude-plan`.
2. During planning, the model keeps rewriting the full markdown plan with `update_plan`.
3. When the plan is ready, the model calls `request_plan_approval`.
4. `request_plan_approval` opens the full plan in Pi's built-in editor for review, then asks the user what to do next.
5. If approved, the user can either keep implementing in the current session or start from a fresh implementation session.
6. Current-session approval immediately injects a synthetic "start implementing now" user message so the agent resumes execution without waiting for another prompt, and that handoff now nudges the model to prefer `TodoWrite` for multi-step execution tracking.
7. Fresh-session approval stages the handoff and prefills `/claude-plan apply-fresh` in the editor. When the user submits that command, the extension opens a new session automatically, carries the generated implementation prompt through session state, and triggers it from the new session startup hook.

## Plan file location

Per-session plans are written to:

- `.pi/claude-plan-mode/plans/<session-id>.md`

This keeps the artifact local to the project and avoids touching product source files during planning.

When the user approves into a fresh session, that new session inherits the same plan path so later re-entry still points at the same artifact.

## Install with `pi install`

Recommended: install from GitHub with `git:`.

Install into the current project only:

```bash
pi install -l git:github.com/trotsky1997/pi-claude-plan-mode
```

Pin a tag, branch, or commit if you want a fixed revision:

```bash
pi install -l git:github.com/trotsky1997/pi-claude-plan-mode@main
```

Install globally into Pi so it is available in any project:

```bash
pi install git:github.com/trotsky1997/pi-claude-plan-mode
```

If you are developing from a local checkout instead, you can still install from disk:

```bash
pi install -l /absolute/path/to/pi-claude-plan-mode
```

After installation, start Pi normally and use `/claude-plan`, or start directly in plan mode:

```bash
pi --claude-plan
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
- share the same planning runtime pieces with other packages through helper modules such as `PlanModeManager` and the managed-runtime extension factory

What Pi cannot fully mirror without deeper core changes:

- Claude Code's native permission-mode state machine
- its exact hidden attachment protocol
- model-routing tricks like `opusplan`
- write access to only one built-in file path without introducing a custom plan tool

So this package uses a pragmatic Pi-native design:

- built-in `edit` and `write` are disabled during planning
- a custom `update_plan` tool is the only write path
- if available, `AskUserQuestion` is the preferred clarifying-question path during planning
- approval uses a safer built-in flow: review the plan in Pi's editor, then prompt for the next action
- fresh-session handoff is split across the tool/UI boundary: approval stages the handoff, then `/claude-plan apply-fresh` creates the new session with `ctx.newSession()`, carries the implementation prompt in extension state, and triggers it from the new session startup hook

## Recommended pairing

For a closer Claude-style planning loop, load `pi-claude-code-ask-user` alongside this package:

```bash
pi install -l /home/aka/pi-playground/pi-claude-code-ask-user
```

When that package is available, the plan-mode prompt nudges the model to use `AskUserQuestion` for genuine requirement or preference questions instead of plain-text back-and-forth.

## Notes for prompt hacking

If you want to make it feel even closer to Claude Code, start by editing these functions in `extensions/claude-plan-mode/prompts.ts`:

- `getPlanModeContextMessage()`
- `getEnterPlanModeToolResult()`
- `getKeepPlanningToolResult()`
- `getApprovedPlanToolResult()`
- `getFreshSessionImplementationPrompt()`

Those strings define most of the behavior the model feels while moving between planning and execution.

## Execution tracking preference

After approval, the execution handoff now tells the model to:

- prefer `TodoWrite` for normal multi-step implementation tracking
- fall back to `TaskCreate` / `TaskGet` / `TaskList` / `TaskUpdate` only when it needs explicit ownership or dependency management

The default execution-tool fallback list also includes `TodoWrite` and the task tools when they are installed, so fresh implementation sessions keep that tracking surface available.
