import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

export type PlanApprovalAction =
  | "implement-here"
  | "implement-fresh"
  | "edit-plan"
  | "keep-planning"
  | "cancel";

type ActionConfig = {
  id: Exclude<PlanApprovalAction, "cancel">;
  label: string;
  description: string;
};

const ACTIONS: ActionConfig[] = [
  {
    id: "implement-here",
    label: "Approve and implement here",
    description: "Restore normal tools in this session and start working now.",
  },
  {
    id: "implement-fresh",
    label: "Approve in fresh session",
    description: "Open a new implementation session from the approved plan.",
  },
  {
    id: "edit-plan",
    label: "Edit plan",
    description: "Open the plan in Pi's editor, then review it again.",
  },
  {
    id: "keep-planning",
    label: "Keep planning",
    description: "Reject execution for now and continue refining the plan.",
  },
];

function getReviewTitle(options: {
  plan: string;
  planPath: string;
  summary?: string;
}): string {
  return options.summary?.trim()
    ? `Review plan: ${options.summary.trim()}`
    : `Review plan: ${options.planPath}`;
}

export async function reviewPlanInEditor(
  ctx: ExtensionContext,
  options: {
    plan: string;
    planPath: string;
    summary?: string;
  },
): Promise<string | undefined> {
  if (!ctx.hasUI) return undefined;

  return ctx.ui.editor(getReviewTitle(options), options.plan);
}

export async function showPlanApprovalPanel(
  ctx: ExtensionContext,
  options: {
    plan: string;
    planPath: string;
    summary?: string;
  },
): Promise<PlanApprovalAction> {
  if (!ctx.hasUI) return "cancel";

  const choice = await ctx.ui.select(
    "Plan review - choose next step",
    ACTIONS.map((action) => `${action.label} - ${action.description}`),
  );

  if (!choice) return "cancel";

  const selected = ACTIONS.find(
    (action) => `${action.label} - ${action.description}` === choice,
  );

  return selected?.id ?? "cancel";
}
