import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { withFileMutationQueue } from "@mariozechner/pi-coding-agent";
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
  getPromptPreview,
  getRequestPlanApprovalToolPrompt,
  getUpdatePlanToolPrompt,
} from "./prompts.js";
import {
  reviewPlanInEditor,
  showPlanApprovalPanel,
} from "./review-ui.js";
import type { PlanApprovalAction } from "./review-ui.js";

type PlanModeState = {
  enabled: boolean;
  planPath?: string;
  previousActiveTools?: string[];
  lastReason?: string;
  hasExited?: boolean;
  justReentered?: boolean;
  pendingImplementation?: {
    mode: "fresh";
    plan: string;
    planPath: string;
    previousSessionFile?: string;
  };
};

type CustomEntryWithData = {
  type: string;
  customType?: string;
  data?: unknown;
};

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
const PLAN_ONLY_TOOLS = ["update_plan", "request_plan_approval"] as const;
const READ_ONLY_TOOL_CANDIDATES = ["read", "bash", "grep", "find", "ls"] as const;
const DEFAULT_EXECUTION_TOOLS = ["read", "bash", "edit", "write"] as const;
const PLAN_DIR = [".pi", "claude-plan-mode", "plans"] as const;

function createEmptyState(): PlanModeState {
  return { enabled: false, hasExited: false, justReentered: false };
}

function isPlanState(value: unknown): value is PlanModeState {
  if (!value || typeof value !== "object") return false;
  const input = value as Partial<PlanModeState>;
  return typeof input.enabled === "boolean";
}

function normalizeToolList(pi: ExtensionAPI, tools: string[] | undefined): string[] {
  const available = new Set(pi.getAllTools().map((tool) => tool.name));
  return (tools ?? []).filter((tool) => available.has(tool));
}

function stripPlanOnlyTools(tools: string[]): string[] {
  return tools.filter((tool) => !PLAN_ONLY_TOOLS.includes(tool as (typeof PLAN_ONLY_TOOLS)[number]));
}

function getDisplayPath(ctx: ExtensionContext, planPath: string): string {
  const rel = relative(ctx.cwd, planPath);
  return rel && !rel.startsWith("..") ? rel : planPath;
}

async function readPlanFile(planPath: string): Promise<string> {
  try {
    return await readFile(planPath, "utf8");
  } catch {
    return "";
  }
}

async function writePlanFile(planPath: string, content: string): Promise<void> {
  const normalized = content.endsWith("\n") ? content : `${content}\n`;
  await mkdir(dirname(planPath), { recursive: true });
  await withFileMutationQueue(planPath, async () => {
    await writeFile(planPath, normalized, "utf8");
  });
}

async function ensurePlanFile(
  ctx: ExtensionContext,
  preferredPath?: string,
): Promise<string> {
  const sessionId = ctx.sessionManager.getSessionId();
  const planPath = preferredPath
    ? resolve(preferredPath)
    : resolve(ctx.cwd, ...PLAN_DIR, `${sessionId}.md`);
  await mkdir(dirname(planPath), { recursive: true });
  if (!existsSync(planPath)) {
    await writePlanFile(planPath, getInitialPlanTemplate());
  }
  return planPath;
}

export default function claudePlanMode(pi: ExtensionAPI): void {
  let state: PlanModeState = createEmptyState();

  function persistState(): void {
    pi.appendEntry<PlanModeState>(STATE_ENTRY, state);
  }

  function getExecutionTools(): string[] {
    const saved = state.previousActiveTools && state.previousActiveTools.length > 0
      ? state.previousActiveTools
      : stripPlanOnlyTools(pi.getActiveTools());
    const normalized = normalizeToolList(pi, stripPlanOnlyTools(saved));
    if (normalized.length > 0) return normalized;
    return normalizeToolList(pi, [...DEFAULT_EXECUTION_TOOLS]);
  }

  function getPlanModeTools(): string[] {
    const available = new Set(pi.getAllTools().map((tool) => tool.name));
    return [...READ_ONLY_TOOL_CANDIDATES, ...PLAN_ONLY_TOOLS].filter((tool) =>
      available.has(tool),
    );
  }

  function applyToolState(): void {
    if (state.enabled) {
      pi.setActiveTools(getPlanModeTools());
      return;
    }
    pi.setActiveTools(getExecutionTools());
  }

  function updateUi(ctx: ExtensionContext): void {
    if (!state.enabled || !state.planPath) {
      ctx.ui.setStatus(PLAN_STATUS_KEY, undefined);
      ctx.ui.setWidget(PLAN_STATUS_WIDGET, undefined);
      return;
    }

    ctx.ui.setStatus(PLAN_STATUS_KEY, "plan:on");
    ctx.ui.setWidget(PLAN_STATUS_WIDGET, [
      "Claude-style plan mode is active.",
      `Plan file: ${getDisplayPath(ctx, state.planPath)}`,
      "Only read-only tools plus the plan tools are enabled.",
    ]);
  }

  async function enterPlanMode(
    ctx: ExtensionContext,
    reason?: string,
  ): Promise<string> {
    const planPath = await ensurePlanFile(ctx, state.planPath);
    if (!state.enabled) {
      state.previousActiveTools = normalizeToolList(
        pi,
        stripPlanOnlyTools(pi.getActiveTools()),
      );
    }
    const reentering = !!state.hasExited && existsSync(planPath);
    state.enabled = true;
    state.planPath = planPath;
    state.lastReason = reason?.trim() || state.lastReason;
    state.justReentered = reentering;
    state.pendingImplementation = undefined;
    persistState();
    applyToolState();
    updateUi(ctx);
    return planPath;
  }

  function exitPlanMode(ctx: ExtensionContext): void {
    state.enabled = false;
    state.hasExited = true;
    state.justReentered = false;
    persistState();
    applyToolState();
    updateUi(ctx);
  }

  async function restoreFromBranch(ctx: ExtensionContext): Promise<void> {
    state = createEmptyState();
    let changed = false;

    for (const entry of ctx.sessionManager.getBranch()) {
      const customEntry = entry as CustomEntryWithData;
      if (
        customEntry.type === "custom" &&
        customEntry.customType === STATE_ENTRY &&
        isPlanState(customEntry.data)
      ) {
        state = {
          enabled: customEntry.data.enabled,
          planPath: customEntry.data.planPath,
          previousActiveTools: normalizeToolList(
            pi,
            customEntry.data.previousActiveTools,
          ),
          lastReason: customEntry.data.lastReason,
          hasExited: customEntry.data.hasExited,
          justReentered: customEntry.data.justReentered,
          pendingImplementation: customEntry.data.pendingImplementation,
        };
      }
    }

    if (pi.getFlag("claude-plan") === true && !state.enabled) {
      state.previousActiveTools = normalizeToolList(
        pi,
        stripPlanOnlyTools(pi.getActiveTools()),
      );
      state.enabled = true;
      changed = true;
    }

    if (state.enabled || state.planPath) {
      const planPath = await ensurePlanFile(ctx, state.planPath);
      if (state.planPath !== planPath) changed = true;
      state.planPath = planPath;
    }

    if (changed) persistState();

    applyToolState();
    updateUi(ctx);
  }

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
    description: "Enter, inspect, or exit Claude-style plan mode",
    handler: async (args: string, ctx: ExtensionContext) => {
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

  pi.registerCommand("claude-plan-prompt", {
    description: "Preview the Claude-style planning prompt",
    handler: async (_args: string, ctx: ExtensionContext) => {
      const planPath = state.planPath ?? (await ensurePlanFile(ctx));
      await ctx.ui.editor(
        "Claude-style plan prompt preview",
        getPromptPreview(getDisplayPath(ctx, planPath)),
      );
    },
  });

  pi.registerCommand("claude-plan-apply-fresh", {
    description: "Internal: start a fresh implementation session from the approved plan",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const pending = state.pendingImplementation;
      if (!pending || pending.mode !== "fresh") {
        ctx.ui.notify("No queued fresh implementation session.", "warning");
        return;
      }

      const previousSessionFile =
        pending.previousSessionFile ?? ctx.sessionManager.getSessionFile();
      const executionTools = getExecutionTools();
      const prompt = getFreshSessionImplementationPrompt(
        pending.planPath,
        pending.plan,
        previousSessionFile,
      );
      const inheritedState: PlanModeState = {
        enabled: false,
        planPath: pending.planPath,
        previousActiveTools: executionTools,
        lastReason: state.lastReason,
        hasExited: true,
        justReentered: false,
      };

      state.pendingImplementation = undefined;
      state.enabled = false;
      state.hasExited = true;
      state.justReentered = false;
      persistState();

      const newSessionResult = await ctx.newSession({
        parentSession: previousSessionFile,
        setup: async (sessionManager: any) => {
          sessionManager.appendCustomEntry(STATE_ENTRY, inheritedState);
        },
      });

      if (newSessionResult.cancelled) {
        ctx.ui.notify("Fresh implementation session cancelled.", "info");
        return;
      }

      ctx.ui.notify("Fresh implementation session created.", "info");
      pi.sendUserMessage(prompt);
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
        throw new Error("update_plan can only be used while plan mode is active.");
      }

      const planPath = state.planPath ?? (await ensurePlanFile(ctx));
      state.planPath = planPath;
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
      state.planPath = planPath;
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
      }

      if (action === "keep-planning" || action === "cancel") {
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
        state.pendingImplementation = {
          mode: "fresh",
          plan,
          planPath,
          previousSessionFile: ctx.sessionManager.getSessionFile(),
        };
        exitPlanMode(ctx);
        ctx.ui.notify("Plan approved. Fresh implementation session queued.", "info");
        pi.sendUserMessage("/claude-plan-apply-fresh", { deliverAs: "followUp" });

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

      state.pendingImplementation = undefined;
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
    state.planPath = planPath;
    const planExists = existsSync(planPath) && (await readPlanFile(planPath)).trim().length > 0;
    const isReentry = !!state.justReentered;
    if (state.justReentered) {
      state.justReentered = false;
      persistState();
    }

    return {
      message: {
        customType: PLAN_CONTEXT_MESSAGE,
        content: getPlanModeContextMessage(planPath, planExists, {
          isReentry,
          lastReason: state.lastReason,
        }),
        display: false,
      },
    };
  });

  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    await restoreFromBranch(ctx);
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
