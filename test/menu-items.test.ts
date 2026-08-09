import { describe, expect, it } from "vitest";
import type { BranchSession } from "../src/session/store.js";
import {
  buildMenuDetail,
  buildMenuItems,
  isOnWorkBranch,
  MENU_ITEMS,
} from "../src/ui/menu-items.js";

function makeSession(overrides: Partial<BranchSession> = {}): BranchSession {
  const now = "2026-07-09T00:00:00.000Z";

  return {
    version: 1,
    branch: "feature/x",
    context: {
      feature: "Add retry logic",
      ticket: "ABC-123",
      requirements: null,
      baseRef: "main",
    },
    pr: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("isOnWorkBranch", () => {
  it("is true when the current branch differs from the target base", () => {
    expect(isOnWorkBranch("feature/x", "origin/main")).toBe(true);
    expect(isOnWorkBranch("feature/x", "main")).toBe(true);
  });

  it("is false on the base branch itself, even remote-qualified", () => {
    expect(isOnWorkBranch("main", "origin/main")).toBe(false);
    expect(isOnWorkBranch("main", "upstream/main")).toBe(false);
    expect(isOnWorkBranch("feature/x", "origin/feature/x")).toBe(false);
    expect(isOnWorkBranch("main", "main")).toBe(false);
  });

  it("is false when either side is unknown", () => {
    expect(isOnWorkBranch(null, "main")).toBe(false);
    expect(isOnWorkBranch("feature/x", null)).toBe(false);
  });
});

describe("MENU_ITEMS", () => {
  it("offers interactive chat as the first, always-available option", () => {
    expect(MENU_ITEMS[0]).toMatchObject({ id: "chat", section: "CHAT" });
  });

  it("offers a rules item in the CONFIG section", () => {
    expect(MENU_ITEMS.find((item) => item.id === "rules")).toMatchObject({
      section: "CONFIG",
    });
  });
});

describe("buildMenuItems", () => {
  it("marks nothing done without a session on the base branch", () => {
    const items = buildMenuItems({
      session: null,
      branch: "main",
      targetBase: "origin/main",
    });

    expect(items.map((item) => item.id)).toEqual(
      MENU_ITEMS.map((item) => item.id),
    );
    expect(items.every((item) => !item.done)).toBe(true);
  });

  it("checks the session item when a context exists", () => {
    const items = buildMenuItems({
      session: makeSession(),
      branch: "main",
      targetBase: "main",
    });

    expect(items.find((item) => item.id === "session")?.done).toBe(true);
    expect(items.find((item) => item.id === "session")?.label).toBe(
      "Create session context",
    );
  });

  it("checks and relabels the pr item when a description was generated", () => {
    const session = makeSession({
      pr: {
        template: "github",
        description: "## Summary",
        baseRef: "main",
        generatedAt: "2026-07-09T00:00:00.000Z",
      },
    });
    const item = buildMenuItems({
      session,
      branch: "main",
      targetBase: "main",
    }).find((entry) => entry.id === "pr");

    expect(item?.done).toBe(true);
    expect(item?.label).toBe("Update PR description");
  });

  it("checks and relabels the branch item on a work branch", () => {
    const item = buildMenuItems({
      session: makeSession(),
      branch: "feature/x",
      targetBase: "origin/main",
    }).find((entry) => entry.id === "branch");

    expect(item?.done).toBe(true);
    expect(item?.label).toBe("Rename branch");
  });

  it("keeps the branch item unchecked on the base branch", () => {
    const item = buildMenuItems({
      session: makeSession(),
      branch: "main",
      targetBase: "origin/main",
    }).find((entry) => entry.id === "branch");

    expect(item?.done).toBeFalsy();
    expect(item?.label).toBe("Create branch name");
  });

  it("disables the clear item until a context exists, then enables it red", () => {
    const withoutContext = buildMenuItems({
      session: null,
      branch: "feature/x",
      targetBase: "main",
    }).find((entry) => entry.id === "clear");

    expect(withoutContext?.disabled).toBe(true);
    expect(withoutContext?.danger).toBe(true);

    const withContext = buildMenuItems({
      session: makeSession(),
      branch: "feature/x",
      targetBase: "main",
    }).find((entry) => entry.id === "clear");

    expect(withContext?.disabled).toBe(false);
    expect(withContext?.danger).toBe(true);
  });

  it("includes the docs item without completion state", () => {
    const item = buildMenuItems({
      session: null,
      branch: null,
      targetBase: null,
    }).find((entry) => entry.id === "docs");

    expect(item?.label).toBe("Generate documentation");
    expect(item?.done).toBeUndefined();
  });

  it("offers agent setup, then relabels to refresh once definitions exist", () => {
    const base = { session: null, branch: null, targetBase: null };
    const fresh = buildMenuItems(base).find(
      (entry) => entry.id === "agent-setup",
    );

    expect(fresh?.label).toBe("Set up project agents");
    expect(fresh?.done).toBeUndefined();

    const existing = buildMenuItems({ ...base, agentFiles: 3 }).find(
      (entry) => entry.id === "agent-setup",
    );

    expect(existing?.label).toBe("Refresh project agents");
    expect(existing?.done).toBe(true);
    expect(existing?.hint).toContain("3 definitions");

    const one = buildMenuItems({ ...base, agentFiles: 1 }).find(
      (entry) => entry.id === "agent-setup",
    );

    expect(one?.hint).toContain("1 definition exist");
  });

  it("groups agent setup under DOCS, right after documentation", () => {
    const ids = MENU_ITEMS.map((item) => item.id);
    const item = MENU_ITEMS.find((entry) => entry.id === "agent-setup");

    expect(item?.section).toBe("DOCS");
    expect(ids.indexOf("agent-setup")).toBe(ids.indexOf("docs") + 1);
  });
});

describe("buildMenuDetail", () => {
  it("lists the repository context the wide layout shows", () => {
    const detail = buildMenuDetail({
      branch: "feature/x",
      targetBase: "origin/main",
      hasContext: true,
      stat: { insertions: 12, deletions: 3, files: 2 },
    });

    expect(detail.map((row) => row.label)).toEqual([
      "Branch",
      "Target",
      "Context",
      "Changes",
    ]);
    expect(detail[0].value).toBe("feature/x");
    expect(detail[2].value).toBe("saved");
    expect(detail[3].value).toBe("+12 -3 (2 files)");
  });

  it("falls back to readable placeholders outside a repository", () => {
    const detail = buildMenuDetail({
      branch: null,
      targetBase: null,
      hasContext: false,
      stat: null,
    });

    expect(detail).toHaveLength(3);
    expect(detail[0].value).toBe("(not a git repository)");
    expect(detail[1].value).toBe("(auto-detect)");
    expect(detail[2].value).toBe("not captured");
  });

  it("singularizes a one-file change", () => {
    const detail = buildMenuDetail({
      branch: "x",
      targetBase: "main",
      hasContext: false,
      stat: { insertions: 1, deletions: 0, files: 1 },
    });

    expect(detail[3].value).toBe("+1 -0 (1 file)");
  });
});
