import { describe, expect, it } from "vitest";
import type { BranchSession } from "../src/session/store.js";
import {
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
});
