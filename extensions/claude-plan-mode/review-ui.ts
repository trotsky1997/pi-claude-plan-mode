import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  Key,
  Markdown,
  matchesKey,
  truncateToWidth,
} from "@mariozechner/pi-tui";

export type PlanApprovalAction =
  | "implement-here"
  | "implement-fresh"
  | "edit-plan"
  | "keep-planning"
  | "cancel";

type ActionConfig = {
  id: Exclude<PlanApprovalAction, "cancel">;
  hotkey: string;
  label: string;
  description: string;
};

const ACTIONS: ActionConfig[] = [
  {
    id: "implement-here",
    hotkey: "i",
    label: "Approve and implement here",
    description: "Keep this session and restore normal coding tools.",
  },
  {
    id: "implement-fresh",
    hotkey: "f",
    label: "Approve in fresh session",
    description: "Start execution from a new implementation session.",
  },
  {
    id: "edit-plan",
    hotkey: "e",
    label: "Edit plan",
    description: "Open the plan in Pi's editor, then return to this panel.",
  },
  {
    id: "keep-planning",
    hotkey: "p",
    label: "Keep planning",
    description: "Reject execution for now and continue refining the plan.",
  },
];

export async function showPlanApprovalPanel(
  ctx: ExtensionContext,
  options: {
    plan: string;
    planPath: string;
    summary?: string;
  },
): Promise<PlanApprovalAction> {
  if (!ctx.hasUI) return "cancel";

  return ctx.ui.custom<PlanApprovalAction>((tui, theme, _kb, done) => {
    const markdown = new Markdown(options.plan, 0, 0, getMarkdownTheme());
    let actionIndex = 0;
    let cachedWidth: number | undefined;
    let cachedLines: string[] | undefined;
    let cachedPlanLines: string[] | undefined;
    let cachedPlanWidth: number | undefined;

    function invalidate(): void {
      cachedWidth = undefined;
      cachedLines = undefined;
      markdown.invalidate();
      tui.requestRender();
    }

    function getPlanLines(planWidth: number): string[] {
      if (cachedPlanLines && cachedPlanWidth === planWidth) {
        return cachedPlanLines;
      }
      cachedPlanLines = markdown.render(planWidth);
      cachedPlanWidth = planWidth;
      return cachedPlanLines;
    }

    function complete(action: PlanApprovalAction): void {
      done(action);
    }

    function handleInput(data: string): void {
      if (matchesKey(data, Key.escape)) {
        complete("cancel");
        return;
      }
      if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
        actionIndex = (actionIndex + 1) % ACTIONS.length;
        invalidate();
        return;
      }
      if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
        actionIndex = (actionIndex - 1 + ACTIONS.length) % ACTIONS.length;
        invalidate();
        return;
      }
      if (matchesKey(data, Key.enter)) {
        complete(ACTIONS[actionIndex].id);
        return;
      }

      const hotkeyAction = ACTIONS.find((action) => data.toLowerCase() === action.hotkey);
      if (hotkeyAction) {
        complete(hotkeyAction.id);
      }
    }

    return {
      render(width: number): string[] {
        if (cachedLines && cachedWidth === width) return cachedLines;

        const lines: string[] = [];
        const planWidth = Math.max(24, width - 2);
        const planLines = getPlanLines(planWidth);
        const divider = theme.fg("accent", "─".repeat(Math.max(8, width)));

        const add = (line: string = "") => {
          lines.push(truncateToWidth(line, width));
        };

        add(divider);
        add(theme.fg("accent", theme.bold(" Ready to code?")));
        add(theme.fg("muted", ` Plan file: ${options.planPath}`));
        if (options.summary?.trim()) {
          add(theme.fg("dim", ` Summary: ${options.summary.trim()}`));
        }
        add(theme.fg("dim", ` Full plan output (${planLines.length} lines). Use terminal scrollback if needed.`));
        add(divider);

        for (const line of planLines) {
          add(` ${line}`);
        }

        add(divider);
        add(theme.fg("accent", theme.bold(" Actions")));
        for (let i = 0; i < ACTIONS.length; i++) {
          const action = ACTIONS[i];
          const selected = i === actionIndex;
          const prefix = selected ? theme.fg("accent", "> ") : "  ";
          const label = `[${action.hotkey}] ${action.label}`;
          const title = selected
            ? theme.bg("selectedBg", theme.fg("text", label))
            : theme.fg("text", label);
          add(`${prefix}${title}`);
          add(`    ${theme.fg("muted", action.description)}`);
        }
        add("");
        add(
          theme.fg(
            "dim",
            " Tab/Shift+Tab or Left/Right switch action • Enter choose • Esc cancel • Hotkeys: i / f / e / p",
          ),
        );
        add(divider);

        cachedWidth = width;
        cachedLines = lines;
        return lines;
      },
      invalidate() {
        cachedWidth = undefined;
        cachedLines = undefined;
        cachedPlanLines = undefined;
        cachedPlanWidth = undefined;
        markdown.invalidate();
      },
      handleInput,
    };
  });
}
