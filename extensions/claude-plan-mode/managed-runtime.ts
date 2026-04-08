import { z } from "zod";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
  getApprovedPlanToolResult,
  getEnterPlanModeToolResult,
  getKeepPlanningToolResult,
  getPlanModeContextMessage,
  getUpdatePlanToolPrompt,
  getRequestPlanApprovalToolPrompt,
} from "./prompts.js";
import { PlanModeManager } from "./plan-mode-manager.js";

const STATE_ENTRY = "claude-plan-mode-state";
const PLAN_CONTEXT_MESSAGE = "claude-plan-mode-context";
const PLAN_APPROVAL_MESSAGE = "claude-plan-mode-approval";
const PLAN_STATUS_WIDGET = "claude-plan-mode-widget";
const PLAN_STATUS_KEY = "claude-plan-mode-status";
const ASK_USER_TOOL_CANDIDATES = ["AskUserQuestion"] as const;
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

const PlanApprovalResponseSchema = z.object({
  type: z.literal("plan_approval_response"),
  request_id: z.string().min(1),
  approve: z.boolean(),
  feedback: z.string().optional(),
});

type ManagedPlanModeOptions = {
  initialReason?: string;
  requestPlanApproval: (request: {
    planPath: string;
    plan: string;
    summary?: string;
  }) => Promise<{ requestId: string }> | { requestId: string };
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

function extractTextParts(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    if (!block || typeof block !== "object") return [];
    const candidate = block as { type?: unknown; text?: unknown };
    return candidate.type === "text" && typeof candidate.text === "string"
      ? [candidate.text]
      : [];
  });
}

function findLatestApprovalResponse(ctx: ExtensionContext, requestId: string) {
  const entries = ctx.sessionManager.getBranch();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] as {
      type?: string;
      message?: { role?: string; content?: unknown };
    };
    if (entry.type !== "message" || entry.message?.role !== "user") continue;
    const textParts = extractTextParts(entry.message.content);
    for (const part of textParts) {
      try {
        const parsed = PlanApprovalResponseSchema.safeParse(JSON.parse(part));
        if (parsed.success && parsed.data.request_id === requestId) {
          return parsed.data;
        }
      } catch {
        // Ignore non-JSON user messages.
      }
    }
  }
  return undefined;
}

function getMutatingShellPattern(): RegExp {
  return /\brm\b|\brmdir\b|\bmv\b|\bcp\b|\bmkdir\b|\btouch\b|(^|[^<])>(?!>)|>>|\bnpm\s+(install|uninstall|update|ci)\b|\byarn\s+(add|remove|install)\b|\bpnpm\s+(add|remove|install)\b|\bpip\s+(install|uninstall)\b|\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|stash|clone)\b|\bsudo\b|\bkill\b/i;
}

export function createManagedPlanModeExtensionFactory(options: ManagedPlanModeOptions) {
  return function managedPlanMode(pi: ExtensionAPI): void {
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
    const applyToolState = (): void => manager.applyToolState();
    const updateUi = (ctx: ExtensionContext): void => manager.updateUi(ctx);
    const ensurePlanFile = async (ctx: ExtensionContext, preferredPath?: string): Promise<string> =>
      manager.ensurePlanFile(ctx, preferredPath);
    const readPlanFile = async (planPath: string): Promise<string> =>
      manager.readPlanFile(planPath);
    const writePlanFile = async (planPath: string, content: string): Promise<void> =>
      manager.writePlanFile(planPath, content);
    const getDisplayPath = (ctx: ExtensionContext, planPath: string): string =>
      manager.getDisplayPath(ctx, planPath);
    const enterPlanMode = async (ctx: ExtensionContext, reason?: string): Promise<string> =>
      manager.enterPlanMode(ctx, reason ?? options.initialReason);

    pi.registerTool({
      name: "enter_plan_mode",
      label: "Enter Plan Mode",
      description: "Enter the managed Claude-style planning phase for this runtime.",
      parameters: Type.Object({
        reason: Type.String({
          description: "Why planning is needed for this managed runtime.",
        }),
      }),
      async execute(
        _toolCallId: string,
        params: EnterPlanModeParams,
        _signal: AbortSignal | undefined,
        _onUpdate: unknown,
        ctx: ExtensionContext,
      ) {
        const planPath = state.planPath ?? (await enterPlanMode(ctx, params.reason));
        manager.setPlanPath(planPath);
        persistState();
        updateUi(ctx);
        return {
          content: [{ type: "text", text: getEnterPlanModeToolResult(planPath) }],
          details: { entered: true, alreadyEnabled: state.enabled, planPath },
        };
      },
    });

    pi.registerTool({
      name: "update_plan",
      label: "Update Plan",
      description: getUpdatePlanToolPrompt(),
      parameters: Type.Object({
        content: Type.String({
          description: "The complete markdown contents of the current plan file.",
        }),
        note: Type.Optional(Type.String({ description: "Optional short note about what changed." })),
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
        manager.setPlanPath(planPath);
        await writePlanFile(planPath, params.content);
        persistState();
        updateUi(ctx);
        const noteSuffix = params.note?.trim() ? ` Updated: ${params.note.trim()}` : "";
        return {
          content: [{ type: "text", text: `Saved the canonical plan to ${planPath}.${noteSuffix}` }],
          details: { planPath, chars: params.content.length },
        };
      },
    });

    pi.registerTool({
      name: "request_plan_approval",
      label: "Request Plan Approval",
      description: getRequestPlanApprovalToolPrompt(),
      parameters: Type.Object({
        summary: Type.Optional(Type.String({ description: "Optional one-line summary of why the plan is ready." })),
      }),
      async execute(
        _toolCallId: string,
        params: RequestPlanApprovalParams,
        _signal: AbortSignal | undefined,
        _onUpdate: unknown,
        ctx: ExtensionContext,
      ) {
        if (!state.enabled) {
          throw new Error("request_plan_approval can only be used while plan mode is active.");
        }

        const planPath = state.planPath ?? (await ensurePlanFile(ctx));
        manager.setPlanPath(planPath);
        const plan = await readPlanFile(planPath);
        if (!plan.trim()) {
          throw new Error("The plan file is empty. Use update_plan first, then request approval.");
        }

        const delegated = await options.requestPlanApproval({
          planPath,
          plan,
          summary: params.summary?.trim() || undefined,
        });
        manager.setPendingApprovalRequest({
          requestId: delegated.requestId,
          summary: params.summary?.trim() || undefined,
        });
        persistState();
        updateUi(ctx);

        return {
          content: [{
            type: "text",
            text: `Plan approval requested from team-lead. Request ID: ${delegated.requestId}. Stay in plan mode until a plan_approval_response arrives.`,
          }],
          details: { approved: false, delegated: true, planPath, requestId: delegated.requestId },
        };
      },
    });

    pi.on("tool_call", async (event: any) => {
      if (!state.enabled) return;

      const allowedTools = new Set(manager.getPlanModeTools());
      if (!allowedTools.has(event.toolName)) {
        return {
          block: true,
          reason: `Tool ${event.toolName} is not available during plan mode. Stay read-only and use the plan tools until approval arrives.`,
        };
      }

      if (event.toolName !== "bash") return;

      const command = String((event.input as { command?: unknown }).command ?? "");
      if (!getMutatingShellPattern().test(command)) return;

      return {
        block: true,
        reason: "Plan mode only allows read-only shell commands. Leave plan mode before using mutating bash commands.",
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
      const pendingApproval = manager.getPendingApprovalRequest();
      if (pendingApproval) {
        const response = findLatestApprovalResponse(ctx, pendingApproval.requestId);
        if (response) {
          const planPath = state.planPath ?? (await ensurePlanFile(ctx, state.planPath));
          manager.setPlanPath(planPath);
          manager.setPendingApprovalRequest(undefined);
          if (response.approve) {
            manager.markApprovedAndExited();
            persistState();
            applyToolState();
            updateUi(ctx);
            return {
              message: {
                customType: PLAN_APPROVAL_MESSAGE,
                content: getApprovedPlanToolResult(planPath),
                display: false,
              },
            };
          }

          persistState();
          updateUi(ctx);
          return {
            message: {
              customType: PLAN_APPROVAL_MESSAGE,
              content: `${getKeepPlanningToolResult(planPath, response.feedback)}\n\n${getPlanModeContextMessage(planPath, true, {
                isReentry: false,
                lastReason: manager.getLastReason(),
                autoApprove: manager.isAutoApproveEnabled(),
              })}`,
              display: false,
            },
          };
        }
      }

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
            autoApprove: manager.isAutoApproveEnabled(),
          }),
          display: false,
        },
      };
    });

    pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
      await manager.restoreFromBranch(ctx);
      if (!state.enabled && !state.hasExited && !state.planPath) {
        await enterPlanMode(ctx, options.initialReason);
      }
    });
  };
}
