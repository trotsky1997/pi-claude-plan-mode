import { z } from "zod";

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeOptionalStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const normalized = [...new Set(
    value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter(Boolean),
  )];
  return normalized.length > 0 ? normalized : undefined;
}

const OptionalStringSchema = z.preprocess(
  normalizeOptionalString,
  z.string().min(1).optional(),
);

const OptionalStringListSchema = z.preprocess(
  normalizeOptionalStringList,
  z.array(z.string().min(1)).min(1).optional(),
);

export const PendingImplementationSchema = z.object({
  mode: z.literal("fresh"),
  plan: z.string().min(1),
  planPath: z.string().min(1),
  previousSessionFile: OptionalStringSchema,
});

export const PendingApprovalRequestSchema = z.object({
  requestId: z.string().min(1),
  summary: OptionalStringSchema,
});

export const PlanModeStateSchema = z.object({
  enabled: z.boolean().default(false),
  planPath: OptionalStringSchema,
  previousActiveTools: OptionalStringListSchema,
  lastReason: OptionalStringSchema,
  hasExited: z.boolean().default(false),
  justReentered: z.boolean().default(false),
  queuedStartupPrompt: OptionalStringSchema,
  pendingImplementation: PendingImplementationSchema.optional(),
  pendingApprovalRequest: PendingApprovalRequestSchema.optional(),
});

export type PendingImplementation = z.infer<typeof PendingImplementationSchema>;
export type PendingApprovalRequest = z.infer<typeof PendingApprovalRequestSchema>;
export type PlanModeState = z.infer<typeof PlanModeStateSchema>;

export function createEmptyPlanModeState(): PlanModeState {
  return {
    enabled: false,
    hasExited: false,
    justReentered: false,
  };
}

export function sanitizePlanModeState(value: unknown): PlanModeState {
  const parsed = PlanModeStateSchema.safeParse(value);
  if (!parsed.success) return createEmptyPlanModeState();
  return parsed.data;
}

export function clonePlanModeState(state: PlanModeState): PlanModeState {
  return {
    enabled: state.enabled,
    planPath: state.planPath,
    previousActiveTools: state.previousActiveTools ? [...state.previousActiveTools] : undefined,
    lastReason: state.lastReason,
    hasExited: state.hasExited,
    justReentered: state.justReentered,
    queuedStartupPrompt: state.queuedStartupPrompt,
    pendingImplementation: state.pendingImplementation
      ? { ...state.pendingImplementation }
      : undefined,
    pendingApprovalRequest: state.pendingApprovalRequest
      ? { ...state.pendingApprovalRequest }
      : undefined,
  };
}
