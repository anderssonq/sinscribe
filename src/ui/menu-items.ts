// Pure menu-item state (no Ink) so completion/label logic is unit-testable.
import type { BranchSession } from "../session/store.js";

export type MenuChoice =
  | "chat"
  | "session"
  | "clear"
  | "pr"
  | "prompt"
  | "branch"
  | "docs"
  | "rules"
  | "settings"
  | "theme"
  | "help"
  | "exit";

export type MenuItem = {
  id: MenuChoice;
  label: string;
  hint: string;
  /** Muted uppercase group label rendered above the first item of a group. */
  section?: "CHAT" | "GIT" | "DOCS" | "CONFIG";
  /** Rendered with a right-aligned green "✓ done" when true. */
  done?: boolean;
  /** Rendered dim; enter/click are no-ops. */
  disabled?: boolean;
  /** Rendered in red — a destructive action (e.g. clearing saved context). */
  danger?: boolean;
};

export const MENU_ITEMS: MenuItem[] = [
  {
    id: "chat",
    label: "Interactive chat",
    hint: "Ask about the repo, explore code, get quick answers",
    section: "CHAT",
  },
  {
    id: "session",
    label: "Create session context",
    hint: "Capture feature context for the current branch",
    section: "GIT",
  },
  {
    id: "clear",
    label: "Clear session context",
    hint: "Erase this branch's saved context and start over from scratch",
    section: "GIT",
    danger: true,
  },
  {
    id: "pr",
    label: "Create PR description",
    hint: "Generate a PR description from context + branch diff",
    section: "GIT",
  },
  {
    id: "branch",
    label: "Create branch name",
    hint: "Suggest branch names from a ticket ID or short description",
    section: "GIT",
  },
  {
    id: "prompt",
    label: "Create feature or bugfix prompt",
    hint: "Generate a copy-ready task prompt for your AI coding agent",
    section: "GIT",
  },
  {
    id: "docs",
    label: "Generate documentation",
    hint: "Analyze the project and write markdown docs with mermaid diagrams",
    section: "DOCS",
  },
  {
    id: "rules",
    label: "Project rules",
    hint: "Write rules that get added to every AI command's instructions",
    section: "CONFIG",
  },
  {
    id: "settings",
    label: "AI settings",
    hint: "Change provider, model, and API key",
    section: "CONFIG",
  },
  {
    id: "theme",
    label: "Theme",
    hint: "Switch the color theme (dark and light schemes)",
    section: "CONFIG",
  },
  {
    id: "help",
    label: "Help",
    hint: "Show usage and options",
    section: "CONFIG",
  },
  { id: "exit", label: "Exit", hint: "Quit Sinscribe", section: "CONFIG" },
];

/**
 * True when the current branch differs from the target base — covering both
 * "a branch was just created" and "the user was already on a feature branch".
 * A remote-qualified base ("origin/main", "upstream/main") matches its local
 * short name by suffix, so no remote-name list is needed. The rare false
 * "same" (a local base literally named "x/main" while on "main") only makes
 * the menu offer Create instead of Rename — never a rename of the base.
 */
export function isOnWorkBranch(
  branch: string | null,
  targetBase: string | null,
): boolean {
  return (
    branch !== null &&
    targetBase !== null &&
    branch !== targetBase &&
    !targetBase.endsWith(`/${branch}`)
  );
}

/** Derives per-item completion state and dynamic labels from session/git state. */
export function buildMenuItems(input: {
  session: BranchSession | null;
  branch: string | null;
  targetBase: string | null;
}): MenuItem[] {
  return MENU_ITEMS.map((item) => {
    switch (item.id) {
      case "session":
        return { ...item, done: Boolean(input.session?.context) };
      case "clear":
        // Nothing to clear until a context exists: dim + inert (the dim color
        // takes precedence over the red danger tint while disabled).
        return { ...item, disabled: !input.session?.context };
      case "pr":
        return input.session?.pr
          ? {
              ...item,
              done: true,
              label: "Update PR description",
              hint: "A saved description exists — it will be updated with the fresh diff",
            }
          : item;
      case "branch":
        return isOnWorkBranch(input.branch, input.targetBase)
          ? {
              ...item,
              done: true,
              label: "Rename branch",
              hint: "Pick a new name for the current branch (git branch -m)",
            }
          : item;
      default:
        return item;
    }
  });
}
