const PLAN_TEMPLATE = `# Plan

## Context

## What I Learned

## Recommended Approach

## Files to Modify

## Existing Code to Reuse

## Open Questions

## Verification
`;

export function getInitialPlanTemplate(): string {
  return PLAN_TEMPLATE;
}

export function getPlanModeContextMessage(
  planPath: string,
  planExists: boolean,
  options?: {
    isReentry?: boolean;
    lastReason?: string;
  },
): string {
  const fileInfo = planExists
    ? `A plan file already exists at ${planPath}. Read it first, then keep it up to date with the update_plan tool.`
    : `No plan file exists yet. Create it immediately at ${planPath} with the update_plan tool.`;
  const reentry = options?.isReentry
    ? `\nRe-entry note:\n- You previously exited plan mode for this task. Read the existing plan before changing direction.\n- If this is a different task, overwrite the plan cleanly.\n- If this is the same task, refine the existing plan instead of starting from scratch.\n`
    : "";
  const reason = options?.lastReason?.trim()
    ? `\nWhy plan mode was entered:\n- ${options.lastReason.trim()}\n`
    : "";

  return `[PLAN MODE ACTIVE]
Plan mode is active. The user indicated that they do not want you to execute yet. You MUST NOT edit project files, run mutating shell commands, change configs, or otherwise make changes to the system. This supersedes any other instructions you have received.

Hard rules:
- The ONLY writable artifact is the session plan file.
- Use update_plan to keep the full markdown plan current as your understanding improves.
- Do NOT ask for plan approval in plain text.
- Do NOT ask questions that you could answer by reading the code.
- If the AskUserQuestion tool is available, use it for clarifying questions instead of plain text.
- If you need approval, use request_plan_approval.

Plan file:
${fileInfo}
${reason}${reentry}

## Iterative Planning Workflow

You are pair-planning with the user. Explore the code to build context, ask the user questions when you hit decisions you cannot make alone, and update the plan file as you go. The plan file starts as a rough skeleton and gradually becomes the final implementation plan.

### The Loop

Repeat this cycle until the plan is complete:

1. Explore - Read a few relevant files and look for existing functions, modules, and patterns to reuse.
2. Update the plan file - After each meaningful discovery, rewrite the plan so it stays current. Do not wait until the end.
3. Ask the user - When you hit an ambiguity that code alone cannot resolve, ask a targeted clarifying question. Prefer AskUserQuestion when that tool is available. Then continue the loop.

### First Turn

Start by quickly scanning a few key files to form an initial understanding of the task scope. Then write a skeleton plan immediately. Do not explore exhaustively before engaging the user.

### Asking Good Questions

- Never ask what you could find out by reading the code.
- Batch related questions together when possible.
- Focus on things only the user can answer: requirements, preferences, tradeoffs, and edge-case priorities.
- Prefer AskUserQuestion over plain text when the tool is available.
- Do NOT reference "the plan" in your question phrasing because the user has not reviewed it yet.

### Plan File Structure

Your plan should stay concise enough to scan quickly but detailed enough to execute.
- Begin with Context: why this change is needed and what outcome it should produce.
- Include only your recommended approach, not a long menu of alternatives.
- Name the files that are likely to change.
- Reference existing code to reuse, with file paths.
- Include a concrete Verification section describing how to test the result end to end.

### When to Converge

The plan is ready when it clearly covers:
- what to change
- which files to modify
- what existing code to reuse
- how to verify the implementation

### Ending Your Turn

Your turn should normally end in one of two ways:
- use AskUserQuestion for a targeted clarifying question when available, or
- call request_plan_approval

Never ask about approval via plain text. Use request_plan_approval for that boundary.`;
}

export function getEnterPlanModeToolResult(planPath: string): string {
  return `Plan mode enabled.

You are now in a read-only planning phase.
- Explore with read-only tools only.
- Keep the canonical plan in: ${planPath}
- Write a skeleton plan early, then keep rewriting the full plan as you learn more.
- Ask targeted clarifying questions only when the code cannot answer them, and prefer AskUserQuestion when that tool is available.
- When the plan is ready, call request_plan_approval instead of asking for approval in plain text.`;
}

export function getKeepPlanningToolResult(
  planPath: string,
  feedback?: string,
): string {
  const extra = feedback?.trim()
    ? `\n\nUser feedback:\n${feedback.trim()}`
    : "";

  return `The user wants you to keep planning.

Continue in plan mode.
- Re-read the plan file at ${planPath}
- Refine it with update_plan
- Resolve the remaining ambiguities before asking for approval again, using AskUserQuestion when it is available
- End with either a targeted clarifying question or request_plan_approval${extra}`;
}

export function getApprovedPlanToolResult(
  planPath: string,
): string {
  return `The user approved the plan. Plan mode is now OFF and normal tools are active again.

Canonical plan file: ${planPath}

- Do not summarize the plan again.
- Do not ask for confirmation again.
- If TaskCreate / TaskGet / TaskList / TaskUpdate are available, use them to track non-trivial multi-step execution.
- Start implementing now and make the first concrete tool call or code change.
- Only pause if a genuinely new blocker appears that the approved plan did not cover.`;
}

export function getExecutionHandoffUserMessage(planPath: string): string {
  return `Plan approved. Start implementing now.

Do not restate the plan or ask for confirmation again.
If TaskCreate / TaskGet / TaskList / TaskUpdate are available, use them to track non-trivial multi-step execution.
Make your next step a concrete implementation action.
If you need the exact plan wording, read the canonical plan file at ${planPath}.`;
}

export function getFreshSessionQueuedToolResult(planPath: string): string {
  return `The user approved the plan and requested a fresh implementation session.

Plan mode is complete for this session.
- The approved plan remains at ${planPath}
- A fresh implementation session has been queued
- Do not continue implementing in this planning session`;
}

export function getFreshSessionImplementationPrompt(
  planPath: string,
  plan: string,
  previousSessionPath?: string,
): string {
  const previous = previousSessionPath
    ? `\n\nIf you need to inspect the earlier planning transcript, the parent session file is: ${previousSessionPath}`
    : "";

  return `Implement the following approved plan:\n\n${plan}\n\nCanonical plan file: ${planPath}\n\nYou are in a fresh implementation session. Treat the plan as already approved and start executing it now. If TaskCreate / TaskGet / TaskList / TaskUpdate are available, use them to track non-trivial multi-step execution. Do not re-open a planning loop unless genuinely new information forces it.${previous}`;
}

export function getEnterPlanModeToolPrompt(): string {
  return `Use this tool proactively when you are about to start a non-trivial implementation task. Getting user sign-off on the approach before writing code prevents wasted effort and ensures alignment.

Prefer using enter_plan_mode when ANY of these are true:
- the task adds meaningful new functionality
- there are multiple valid implementation approaches
- the task changes existing behavior or structure
- the task involves important architectural decisions
- the work will likely touch several files
- you need exploration before you even understand the scope
- user preferences or tradeoffs materially affect the implementation

Do NOT use it for:
- tiny typo fixes
- obvious one-line changes
- tasks where the implementation path is already clear
- pure research with no implementation follow-up

When you call this tool, explain why planning is needed. After approval, you must stay read-only, keep a plan file updated, and eventually use request_plan_approval.`;
}

export function getUpdatePlanToolPrompt(): string {
  return `Use this tool during plan mode to update the canonical markdown plan file. Always write the full current plan, not a fragment, so the file stays self-contained and executable. Write an initial skeleton early, then keep refining it as discoveries accumulate.`;
}

export function getRequestPlanApprovalToolPrompt(): string {
  return `Use this tool only in plan mode when the plan file is ready for user review.

How it works:
- The plan must already be written to the canonical plan file.
- This tool is the approval boundary between planning and execution.
- Do not ask "is this plan okay?" or "should I proceed?" in plain text.

Only use it when the task truly requires an implementation plan. Do not use it for pure research tasks where you are just reading code and gathering information.`;
}

export function getPromptPreview(planPath = "/path/to/session-plan.md"): string {
  return getPlanModeContextMessage(planPath, true);
}
