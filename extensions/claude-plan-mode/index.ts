import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
  getApprovedPlanToolResult,
  getEnterPlanModeToolPrompt,
  getEnterPlanModeToolResult,
  getExecutionHandoffUserMessage,
  getFreshSessionImplementationPrompt,
  getFreshSessionQueuedToolResult,
  getInitialPlanTemplate,
  getKeepPlanningToolResult,
  getPlanModeContextMessage,
  getRequestPlanApprovalToolPrompt,
  getUpdatePlanToolPrompt,
} from "./prompts.js";
import {
  reviewPlanInEditor,
  showPlanApprovalPanel,
} from "./review-ui.js";
import type { PlanApprovalAction } from "./review-ui.js";
import { PlanModeManager } from "./plan-mode-manager.js";
import type { PlanModeState } from "./schemas.js";

type EnterPlanModeParams = {
  reason: string;
};

type UpdatePlanParams = {
  content: string;
  note?: string;
};

type RequestPlanApprovalParams = {
  summary?: string;
};

const STATE_ENTRY = "claude-plan-mode-state";
const PLAN_CONTEXT_MESSAGE = "claude-plan-mode-context";
const PLAN_STATUS_WIDGET = "claude-plan-mode-widget";
const PLAN_STATUS_KEY = "claude-plan-mode-status";
const ASK_USER_TOOL_CANDIDATES = ["AskUserQuestion"] as const;
// Keep the full planning control surface active outside plan mode so the model
// can enter planning, update the plan, and request approval within one turn.
const PLAN_TRANSITION_TOOLS = [
  "enter_plan_mode",
  "update_plan",
  "request_plan_approval",
] as const;
const PLAN_ONLY_TOOLS = [] as const;
const READ_ONLY_TOOL_CANDIDATES = [
  "read",
  "bash",
  "grep",
  "find",
  "ls",
  "webfetch",
  "recursive_webfetch",
  "web_search",
] as const;
const DEFAULT_EXECUTION_TOOLS = [
  "read",
  "bash",
  "edit",
  "write",
  "TodoWrite",
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskUpdate",
] as const;
const PLAN_DIR = [".pi", "claude-plan-mode", "plans"] as const;

export default function claudePlanMode(pi: ExtensionAPI): void {
  const manager = new PlanModeManager(pi, {
    stateEntry: STATE_ENTRY,
    widgetKey: PLAN_STATUS_WIDGET,
    statusKey: PLAN_STATUS_KEY,
    askUserToolCandidates: ASK_USER_TOOL_CANDIDATES,
    planTransitionTools: PLAN_TRANSITION_TOOLS,
    planOnlyTools: PLAN_ONLY_TOOLS,
    readOnlyToolCandidates: READ_ONLY_TOOL_CANDIDATES,
    defaultExecutionTools: DEFAULT_EXECUTION_TOOLS,
    planDir: PLAN_DIR,
  });
  const state = manager.getStateRef();

  const persistState = (): void => manager.persistState();
  const getExecutionTools = (): string[] => manager.getExecutionTools();
  const getPlanModeTools = (): string[] => manager.getPlanModeTools();
  const applyToolState = (): void => manager.applyToolState();
  const updateUi = (ctx: ExtensionContext): void => manager.updateUi(ctx);
  const getDisplayPath = (ctx: ExtensionContext, planPath: string): string =>
    manager.getDisplayPath(ctx, planPath);
  const readPlanFile = async (planPath: string): Promise<string> =>
    manager.readPlanFile(planPath);
  const writePlanFile = async (planPath: string, content: string): Promise<void> =>
    manager.writePlanFile(planPath, content);
  const ensurePlanFile = async (
    ctx: ExtensionContext,
    preferredPath?: string,
  ): Promise<string> => manager.ensurePlanFile(ctx, preferredPath);
  const enterPlanMode = async (
    ctx: ExtensionContext,
    reason?: string,
  ): Promise<string> => manager.enterPlanMode(ctx, reason);
  const exitPlanMode = (ctx: ExtensionContext): void => manager.exitPlanMode(ctx);
  const restoreFromBranch = async (ctx: ExtensionContext): Promise<void> =>
    manager.restoreFromBranch(ctx);
  const restoreFromBranchWithOptions = async (
    ctx: ExtensionContext,
    options?: { allowFlagBootstrap?: boolean },
  ): Promise<void> => manager.restoreFromBranch(ctx, options);

  pi.registerFlag("claude-plan", {
    description: "Start Pi in Claude-style planning mode",
    type: "boolean",
    default: false,
  });

  pi.registerShortcut("ctrl+alt+p", {
    description: "Toggle Claude-style plan mode",
    handler: async (ctx: ExtensionContext) => {
      if (state.enabled) {
        exitPlanMode(ctx);
        ctx.ui.notify("Plan mode disabled.", "info");
        return;
      }
      const planPath = await enterPlanMode(ctx);
      ctx.ui.notify(`Plan mode enabled: ${getDisplayPath(ctx, planPath)}`, "info");
    },
  });

  pi.registerCommand("claude-plan", {
    description: "Enter plan mode; use '/claude-plan off' to exit or '/claude-plan show' to inspect the plan",
    getArgumentCompletions: (prefix: string) => {
      const items = [
        { value: "off", label: "off" },
        { value: "disable", label: "disable" },
        { value: "exit", label: "exit" },
        { value: "show", label: "show" },
        { value: "edit", label: "edit" },
        { value: "apply-fresh", label: "apply-fresh" },
      ];
      const filtered = items.filter((item) => item.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const trimmed = args.trim();
      const lowered = trimmed.toLowerCase();

      if (lowered === "off" || lowered === "disable" || lowered === "exit") {
        exitPlanMode(ctx);
        ctx.ui.notify("Plan mode disabled.", "info");
        return;
      }

      if (lowered === "show" || lowered === "edit") {
        const planPath = state.planPath ?? (await ensurePlanFile(ctx));
        let current = await readPlanFile(planPath);
        if (!current.trim()) current = getInitialPlanTemplate();
        const edited = await ctx.ui.editor(
          `Plan file: ${getDisplayPath(ctx, planPath)}`,
          current,
        );
        if (typeof edited === "string" && edited !== current) {
          await writePlanFile(planPath, edited);
          ctx.ui.notify("Saved plan file.", "info");
        }
        if (!state.enabled) {
          ctx.ui.notify("Plan mode is currently off.", "info");
        }
        return;
      }

      if (lowered === "apply-fresh") {
        const pending = manager.getPendingImplementation();
        if (!pending || pending.mode !== "fresh") {
          ctx.ui.notify("No queued fresh implementation session.", "warning");
          return;
        }

        const previousSessionFile =
          pending.previousSessionFile ?? ctx.sessionManager.getSessionFile();
        const executionTools = getExecutionTools();
        const prompt = getFreshSessionImplementationPrompt(
          pending.planPath,
          previousSessionFile,
        );
        const inheritedState: PlanModeState = {
          enabled: false,
          planPath: pending.planPath,
          previousActiveTools: executionTools,
          lastReason: manager.getLastReason(),
          hasExited: true,
          justReentered: false,
          queuedStartupPrompt: prompt,
        };

        const previousState = manager.getSnapshot();

        manager.markApprovedAndExited();
        persistState();

        const newSessionResult = await ctx.newSession({
          parentSession: previousSessionFile,
          setup: async (sessionManager: any) => {
            sessionManager.appendCustomEntry(STATE_ENTRY, inheritedState);
          },
        });

        if (newSessionResult.cancelled) {
          manager.restoreSnapshot(previousState);
          persistState();
          applyToolState();
          updateUi(ctx);
          ctx.ui.notify("Fresh implementation session cancelled. Approved handoff is still queued.", "info");
          return;
        }

        ctx.ui.notify("Fresh implementation session created.", "info");
        return;
      }

      if (!state.enabled) {
        const planPath = await enterPlanMode(ctx, trimmed || undefined);
        ctx.ui.notify(`Plan mode enabled: ${getDisplayPath(ctx, planPath)}`, "info");
      }

      if (trimmed) {
        pi.sendUserMessage(trimmed);
        return;
      }

      if (state.planPath) {
        ctx.ui.notify(`Plan mode active: ${getDisplayPath(ctx, state.planPath)}`, "info");
      }
    },
  });

  pi.registerTool({
    name: "enter_plan_mode",
    label: "Enter Plan Mode",
    description: getEnterPlanModeToolPrompt(),
    promptSnippet: "Request Claude-style planning mode for complex implementation tasks.",
    promptGuidelines: [
      "Use enter_plan_mode for non-trivial implementation tasks where you should explore and get alignment before editing code.",
    ],
    parameters: Type.Object({
      reason: Type.String({
        description:
          "Why planning is needed, including the ambiguity, trade-offs, or expected scope.",
      }),
    }),
    async execute(
      _toolCallId: string,
      params: EnterPlanModeParams,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      if (state.enabled) {
        const planPath = state.planPath ?? (await ensurePlanFile(ctx));
        return {
          content: [{ type: "text", text: getEnterPlanModeToolResult(planPath) }],
          details: { entered: true, alreadyEnabled: true, planPath },
        };
      }

      if (!ctx.hasUI) {
        throw new Error(
          "enter_plan_mode requires an interactive Pi session because the user must approve planning mode.",
        );
      }

      const approved = await ctx.ui.confirm(
        "Enter plan mode?",
        `${params.reason}\n\nPi will switch to read-only planning tools until the plan is approved.`,
      );

      if (!approved) {
        return {
          content: [
            {
              type: "text",
              text: "The user declined plan mode. Continue without it, or ask a direct clarifying question if needed.",
            },
          ],
          details: { entered: false },
        };
      }

      const planPath = await enterPlanMode(ctx, params.reason);
      return {
        content: [{ type: "text", text: getEnterPlanModeToolResult(planPath) }],
        details: { entered: true, planPath },
      };
    },
  });

  pi.registerTool({
    name: "update_plan",
    label: "Update Plan",
    description: getUpdatePlanToolPrompt(),
    promptSnippet: "Write the full current markdown plan to the canonical session plan file.",
    promptGuidelines: [
      "During plan mode, keep the plan file current with update_plan instead of waiting until the end.",
    ],
    parameters: Type.Object({
      content: Type.String({
        description:
          "The complete markdown contents of the current plan file. Always send the full plan, not a partial diff.",
      }),
      note: Type.Optional(
        Type.String({
          description: "Optional short note about what changed in this revision.",
        }),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: UpdatePlanParams,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      if (!state.enabled) {
        throw new Error(
          "update_plan can only be used while plan mode is active. Call enter_plan_mode first.",
        );
      }

      const planPath = state.planPath ?? (await ensurePlanFile(ctx));
      manager.setPlanPath(planPath);
      await writePlanFile(planPath, params.content);
      persistState();
      updateUi(ctx);

      const noteSuffix = params.note?.trim()
        ? ` Updated: ${params.note.trim()}`
        : "";

      return {
        content: [
          {
            type: "text",
            text: `Saved the canonical plan to ${planPath}.${noteSuffix}`,
          },
        ],
        details: {
          planPath,
          chars: params.content.length,
        },
      };
    },
  });

  pi.registerTool({
    name: "request_plan_approval",
    label: "Request Plan Approval",
    description: getRequestPlanApprovalToolPrompt(),
    promptSnippet: "Ask the user to review the current plan file and approve the transition from planning to implementation.",
    promptGuidelines: [
      "Never ask whether the plan is good enough in plain text; use request_plan_approval instead.",
    ],
    parameters: Type.Object({
      summary: Type.Optional(
        Type.String({
          description: "Optional one-line summary of why the plan is ready.",
        }),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: RequestPlanApprovalParams,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) {
      if (!state.enabled) {
        throw new Error(
          "request_plan_approval can only be used while plan mode is active.",
        );
      }
      if (!ctx.hasUI) {
        throw new Error(
          "request_plan_approval requires an interactive Pi session because the user must review the plan.",
        );
      }

      const planPath = state.planPath ?? (await ensurePlanFile(ctx));
      manager.setPlanPath(planPath);
      let plan = await readPlanFile(planPath);
      if (!plan.trim()) {
        throw new Error(
          "The plan file is empty. Use update_plan first, then call request_plan_approval.",
        );
      }

      const displayPlanPath = getDisplayPath(ctx, planPath);

      let reviewed = await reviewPlanInEditor(ctx, {
        plan,
        planPath: displayPlanPath,
        summary: params.summary,
      });

      let action: PlanApprovalAction = "cancel";

      while (typeof reviewed === "string") {
        if (reviewed !== plan) {
          if (!reviewed.trim()) {
            return {
              content: [
                {
                  type: "text",
                  text: "The reviewed plan is empty. Stay in plan mode and rebuild the plan before requesting approval again.",
                },
              ],
              details: {
                approved: false,
                planPath,
                reason: "empty-plan",
              },
            };
          }
          plan = reviewed;
          await writePlanFile(planPath, plan);
        }

        action = await showPlanApprovalPanel(ctx, {
          plan,
          planPath: displayPlanPath,
          summary: params.summary,
        });

        if (action !== "edit-plan") break;

        reviewed = await reviewPlanInEditor(ctx, {
          plan,
          planPath: displayPlanPath,
          summary: params.summary,
        });
        if (typeof reviewed !== "string") {
          action = "cancel";
          break;
        }
      }

      if (action === "cancel") {
        return {
          content: [
            {
              type: "text",
              text: "Plan review was cancelled. Stay in plan mode and wait for the user's next instruction.",
            },
          ],
          details: {
            approved: false,
            cancelled: true,
            planPath,
          },
        };
      }

      if (action === "keep-planning") {
        const feedback = await ctx.ui.input(
          "Optional feedback for the next planning pass:",
          "Add constraints or leave blank",
        );
        return {
          content: [
            {
              type: "text",
              text: getKeepPlanningToolResult(planPath, feedback),
            },
          ],
          details: {
            approved: false,
            planPath,
            feedback: feedback ?? "",
          },
        };
      }

      if (action === "implement-fresh") {
        manager.setPendingImplementation({
          mode: "fresh",
          plan: plan,
          planPath,
          previousSessionFile: ctx.sessionManager.getSessionFile(),
        });
        exitPlanMode(ctx);
        ctx.ui.setEditorText("/claude-plan apply-fresh");
        ctx.ui.notify("Plan approved. Run '/claude-plan apply-fresh' to open the new implementation session.", "info");

        return {
          content: [
            {
              type: "text",
              text: getFreshSessionQueuedToolResult(planPath),
            },
          ],
          details: {
            approved: true,
            mode: "fresh",
            planPath,
          },
        };
      }

      manager.setPendingImplementation(undefined);
      exitPlanMode(ctx);
      ctx.ui.notify("Plan approved. Normal tools are active again.", "info");
      pi.sendUserMessage(getExecutionHandoffUserMessage(planPath), {
        deliverAs: "steer",
      });

      return {
        content: [
          {
            type: "text",
            text: getApprovedPlanToolResult(planPath),
          },
        ],
        details: {
          approved: true,
          planPath,
        },
      };
    },
  });

  pi.on("tool_call", async (event: any) => {
    if (!state.enabled) return;

    const allowedTools = new Set(getPlanModeTools());
    if (!allowedTools.has(event.toolName)) {
      return {
        block: true,
        reason:
          `Tool ${event.toolName} is not available during plan mode. Stay read-only and use the plan tools until the plan is approved.`,
      };
    }

    if (event.toolName !== "bash") return;

    const command = String((event.input as { command?: unknown }).command ?? "");
    const mutatingPattern =
      /\brm\b|\brmdir\b|\bmv\b|\bcp\b|\bmkdir\b|\btouch\b|(^|[^<])>(?!>)|>>|\bnpm\s+(install|uninstall|update|ci)\b|\byarn\s+(add|remove|install)\b|\bpnpm\s+(add|remove|install)\b|\bpip\s+(install|uninstall)\b|\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|stash|clone)\b|\bsudo\b|\bkill\b/i;
    if (!mutatingPattern.test(command)) return;

    return {
      block: true,
      reason:
        "Plan mode only allows read-only shell commands. Leave plan mode before using mutating bash commands.",
    };
  });

  pi.on("context", async (event: any) => {
    const lastPlanContextIndex = event.messages.reduce((last: number, message: any, index: number) => {
      const customType = (message as { customType?: string }).customType;
      return customType === PLAN_CONTEXT_MESSAGE ? index : last;
    }, -1);

    return {
      messages: event.messages.filter((message: any, index: number) => {
        const customType = (message as { customType?: string }).customType;
        if (customType === PLAN_CONTEXT_MESSAGE) {
          return state.enabled && index === lastPlanContextIndex;
        }
        return true;
      }),
    };
  });

  pi.on("before_agent_start", async (_event: unknown, ctx: ExtensionContext) => {
    if (!state.enabled) return;

    const planPath = state.planPath ?? (await ensurePlanFile(ctx, state.planPath));
    manager.setPlanPath(planPath);
    const planExists = (await readPlanFile(planPath)).trim().length > 0;
    const isReentry = manager.consumeJustReentered();
    if (isReentry) {
      persistState();
    }

    return {
      message: {
        customType: PLAN_CONTEXT_MESSAGE,
        content: getPlanModeContextMessage(planPath, planExists, {
          isReentry,
          lastReason: manager.getLastReason(),
        }),
        display: false,
      },
    };
  });

  pi.on("session_start", async (event: any, ctx: ExtensionContext) => {
    await restoreFromBranchWithOptions(ctx, {
      allowFlagBootstrap: event?.reason === "startup",
    });

    if (event?.reason === "new" && state.queuedStartupPrompt) {
      const prompt = state.queuedStartupPrompt;
      state.queuedStartupPrompt = undefined;
      persistState();
      pi.sendUserMessage(prompt);
    }
  });

  pi.on("session_switch", async (_event: unknown, ctx: ExtensionContext) => {
    await restoreFromBranch(ctx);
  });

  pi.on("session_fork", async (_event: unknown, ctx: ExtensionContext) => {
    await restoreFromBranch(ctx);
  });

  pi.on("session_tree", async (_event: unknown, ctx: ExtensionContext) => {
    await restoreFromBranch(ctx);
  });
}

export {
  getEnterPlanModeToolPrompt,
  getRequestPlanApprovalToolPrompt,
  getUpdatePlanToolPrompt,
};
