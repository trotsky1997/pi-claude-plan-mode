import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { withFileMutationQueue } from "@mariozechner/pi-coding-agent";
import { getInitialPlanTemplate } from "./prompts.js";
import {
  clonePlanModeState,
  createEmptyPlanModeState,
  sanitizePlanModeState,
  type PendingApprovalRequest,
  type PendingImplementation,
  type PlanModeState,
} from "./schemas.js";

type CustomEntryWithData = {
  type: string;
  customType?: string;
  data?: unknown;
};

export class PlanModeManager {
  private state: PlanModeState = createEmptyPlanModeState();

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly options: {
      stateEntry: string;
      widgetKey: string;
      statusKey: string;
      askUserToolCandidates: readonly string[];
      planTransitionTools: readonly string[];
      planOnlyTools: readonly string[];
      readOnlyToolCandidates: readonly string[];
      defaultExecutionTools: readonly string[];
      planDir: readonly string[];
    },
  ) {}

  getSnapshot(): PlanModeState {
    return clonePlanModeState(this.state);
  }

  getStateRef(): PlanModeState {
    return this.state;
  }

  isEnabled(): boolean {
    return this.state.enabled;
  }

  isAutoApproveEnabled(): boolean {
    return Boolean(this.state.autoApprove);
  }

  getPlanPath(): string | undefined {
    return this.state.planPath;
  }

  setPlanPath(planPath: string | undefined): void {
    this.state.planPath = planPath;
  }

  setAutoApprove(autoApprove: boolean): void {
    this.state.autoApprove = autoApprove;
  }

  getLastReason(): string | undefined {
    return this.state.lastReason;
  }

  hasJustReentered(): boolean {
    return Boolean(this.state.justReentered);
  }

  consumeJustReentered(): boolean {
    const wasSet = Boolean(this.state.justReentered);
    this.state.justReentered = false;
    return wasSet;
  }

  getPendingImplementation(): PendingImplementation | undefined {
    return this.state.pendingImplementation
      ? { ...this.state.pendingImplementation }
      : undefined;
  }

  getPendingApprovalRequest(): PendingApprovalRequest | undefined {
    return this.state.pendingApprovalRequest
      ? { ...this.state.pendingApprovalRequest }
      : undefined;
  }

  setPendingImplementation(pending: PendingImplementation | undefined): void {
    this.state.pendingImplementation = pending ? { ...pending } : undefined;
  }

  setPendingApprovalRequest(pending: PendingApprovalRequest | undefined): void {
    this.state.pendingApprovalRequest = pending ? { ...pending } : undefined;
  }

  markApprovedAndExited(): void {
    this.state.pendingImplementation = undefined;
    this.state.pendingApprovalRequest = undefined;
    this.state.queuedStartupPrompt = undefined;
    this.state.enabled = false;
    this.state.autoApprove = false;
    this.state.hasExited = true;
    this.state.justReentered = false;
  }

  restoreSnapshot(snapshot: PlanModeState): void {
    this.replaceState(snapshot);
  }

  private replaceState(nextState: PlanModeState): void {
    const normalized = clonePlanModeState(nextState);
    for (const key of Object.keys(this.state) as Array<keyof PlanModeState>) {
      delete this.state[key];
    }
    Object.assign(this.state, normalized);
  }

  persistState(): void {
    this.pi.appendEntry<PlanModeState>(this.options.stateEntry, this.getSnapshot());
  }

  normalizeToolList(tools: string[] | undefined): string[] {
    const available = new Set(this.pi.getAllTools().map((tool: { name: string }) => tool.name));
    return (tools ?? []).filter((tool) => available.has(tool));
  }

  stripApprovalOnlyTools(tools: string[]): string[] {
    return tools.filter((tool) => !this.options.planOnlyTools.includes(tool));
  }

  getExecutionTools(): string[] {
    const saved = this.state.previousActiveTools && this.state.previousActiveTools.length > 0
      ? this.state.previousActiveTools
      : this.stripApprovalOnlyTools(this.pi.getActiveTools());
    const normalized = this.normalizeToolList([
      ...this.stripApprovalOnlyTools(saved),
      ...this.options.planTransitionTools,
    ]);
    if (normalized.length > 0) return normalized;
    return this.normalizeToolList([
      ...this.options.defaultExecutionTools,
      ...this.options.planTransitionTools,
    ]);
  }

  getPlanModeTools(): string[] {
    const available = new Set(this.pi.getAllTools().map((tool: { name: string }) => tool.name));
    return [
      ...this.options.readOnlyToolCandidates,
      ...this.options.askUserToolCandidates,
      ...this.options.planTransitionTools,
      ...this.options.planOnlyTools,
    ].filter((tool) => available.has(tool));
  }

  applyToolState(): void {
    if (this.state.enabled) {
      this.pi.setActiveTools(this.getPlanModeTools());
      return;
    }
    this.pi.setActiveTools(this.getExecutionTools());
  }

  updateUi(ctx: ExtensionContext): void {
    if (!this.state.enabled || !this.state.planPath) {
      ctx.ui.setStatus(this.options.statusKey, undefined);
      ctx.ui.setWidget(this.options.widgetKey, undefined);
      return;
    }

    ctx.ui.setStatus(this.options.statusKey, "plan:on");
    ctx.ui.setWidget(this.options.widgetKey, [
      "Claude-style plan mode is active.",
      `Plan file: ${this.getDisplayPath(ctx, this.state.planPath)}`,
      this.state.autoApprove
        ? "Auto handoff is enabled: request_plan_approval exits plan mode and starts implementing here without another approval gate."
        : "Manual approval is enabled: request_plan_approval opens the review gate before execution resumes.",
      "Read-only tools plus planning/question tools are enabled, including research tools when available.",
    ]);
  }

  getDisplayPath(ctx: ExtensionContext, planPath: string): string {
    const rel = relative(ctx.cwd, planPath);
    return rel && !rel.startsWith("..") ? rel : planPath;
  }

  async readPlanFile(planPath: string): Promise<string> {
    try {
      return await readFile(planPath, "utf8");
    } catch {
      return "";
    }
  }

  async writePlanFile(planPath: string, content: string): Promise<void> {
    const normalized = content.endsWith("\n") ? content : `${content}\n`;
    await mkdir(dirname(planPath), { recursive: true });
    await withFileMutationQueue(planPath, async () => {
      await writeFile(planPath, normalized, "utf8");
    });
  }

  async ensurePlanFile(
    ctx: ExtensionContext,
    preferredPath?: string,
  ): Promise<string> {
    const sessionId = ctx.sessionManager.getSessionId();
    const planPath = preferredPath
      ? resolve(preferredPath)
      : resolve(ctx.cwd, ...this.options.planDir, `${sessionId}.md`);
    await mkdir(dirname(planPath), { recursive: true });
    if (!existsSync(planPath)) {
      await this.writePlanFile(planPath, getInitialPlanTemplate());
    }
    return planPath;
  }

  async enterPlanMode(
    ctx: ExtensionContext,
    reason?: string,
    options?: { autoApprove?: boolean },
  ): Promise<string> {
    const planPath = await this.ensurePlanFile(ctx, this.state.planPath);
    if (!this.state.enabled) {
      this.state.previousActiveTools = this.normalizeToolList(
        this.stripApprovalOnlyTools(this.pi.getActiveTools()),
      );
    }
    const reentering = !!this.state.hasExited && existsSync(planPath);
    this.state.enabled = true;
    this.state.autoApprove = options?.autoApprove ?? false;
    this.state.planPath = planPath;
    this.state.lastReason = reason?.trim() || this.state.lastReason;
    this.state.justReentered = reentering;
    this.state.pendingImplementation = undefined;
    this.persistState();
    this.applyToolState();
    this.updateUi(ctx);
    return planPath;
  }

  exitPlanMode(ctx: ExtensionContext): void {
    this.state.enabled = false;
    this.state.autoApprove = false;
    this.state.hasExited = true;
    this.state.justReentered = false;
    this.persistState();
    this.applyToolState();
    this.updateUi(ctx);
  }

  async restoreFromBranch(
    ctx: ExtensionContext,
    options?: { allowFlagBootstrap?: boolean },
  ): Promise<void> {
    this.replaceState(createEmptyPlanModeState());
    let changed = false;

    for (const entry of ctx.sessionManager.getBranch()) {
      const customEntry = entry as CustomEntryWithData;
      if (
        customEntry.type === "custom"
        && customEntry.customType === this.options.stateEntry
      ) {
        this.replaceState(sanitizePlanModeState(customEntry.data));
      }
    }

    if (
      options?.allowFlagBootstrap
      && this.pi.getFlag("claude-plan") === true
      && !this.state.enabled
      && !this.state.hasExited
      && !this.state.planPath
    ) {
      this.state.previousActiveTools = this.normalizeToolList(
        this.stripApprovalOnlyTools(this.pi.getActiveTools()),
      );
      this.state.enabled = true;
      changed = true;
    }

    if (this.state.enabled || this.state.planPath) {
      const planPath = await this.ensurePlanFile(ctx, this.state.planPath);
      if (this.state.planPath !== planPath) changed = true;
      this.state.planPath = planPath;
    }

    if (changed) this.persistState();

    this.applyToolState();
    this.updateUi(ctx);
  }
}
