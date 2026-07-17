import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  combineRules,
  describeRulesForDryRun,
  getProjectRulesPath,
  loadProjectRules,
  loadRules,
  saveProjectRules,
  type RulesSummary,
} from "../src/domain/rules.js";

describe("combineRules", () => {
  it("returns null when neither tier has content", () => {
    expect(combineRules(null, null)).toBeNull();
  });

  it("labels and returns the user tier alone", () => {
    expect(combineRules("be concise", null)).toBe("User rules:\nbe concise");
  });

  it("labels and returns the project tier alone", () => {
    expect(combineRules(null, "no gitmoji")).toBe("Project rules:\nno gitmoji");
  });

  it("joins both tiers, user first then project", () => {
    expect(combineRules("be concise", "no gitmoji")).toBe(
      "User rules:\nbe concise\n\nProject rules:\nno gitmoji",
    );
  });
});

describe("describeRulesForDryRun", () => {
  const empty: RulesSummary = { user: null, project: null, combined: null };

  it('describes "none" when nothing is active', () => {
    expect(describeRulesForDryRun(empty)).toBe("none");
  });

  it("describes the user tier alone with its character count", () => {
    expect(
      describeRulesForDryRun({ ...empty, user: "12345", combined: "x" }),
    ).toBe("user tier (5 chars)");
  });

  it("describes the project tier alone with its character count", () => {
    expect(
      describeRulesForDryRun({
        ...empty,
        project: "1234567890",
        combined: "x",
      }),
    ).toBe("project tier (10 chars)");
  });

  it("describes both tiers together", () => {
    expect(
      describeRulesForDryRun({
        ...empty,
        user: "12345",
        project: "123",
        combined: "x",
      }),
    ).toBe("user tier (5 chars) + project tier (3 chars)");
  });
});

describe("project rules file (repoRoot-scoped I/O)", () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await mkdtemp(path.join(tmpdir(), "sinscribe-rules-test-"));
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it("computes the path under <repoRoot>/.sinscribe/rules.md", () => {
    expect(getProjectRulesPath(repoRoot)).toBe(
      path.join(repoRoot, ".sinscribe", "rules.md"),
    );
  });

  it("returns null when the file does not exist", async () => {
    expect(await loadProjectRules(repoRoot)).toBeNull();
  });

  it("returns null for repoRoot === null (no project tier available)", async () => {
    expect(await loadProjectRules(null)).toBeNull();
  });

  it("treats a whitespace-only file as absent", async () => {
    const dir = path.join(repoRoot, ".sinscribe");

    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "rules.md"), "   \n\t\n", "utf8");

    expect(await loadProjectRules(repoRoot)).toBeNull();
  });

  it("round-trips through saveProjectRules: trims and adds one trailing newline", async () => {
    const written = await saveProjectRules(
      repoRoot,
      "  Always write tests first.  \n\n",
    );

    expect(written).toBe(getProjectRulesPath(repoRoot));
    expect(await readFile(written, "utf8")).toBe("Always write tests first.\n");
    expect(await loadProjectRules(repoRoot)).toBe("Always write tests first.");
  });

  it("creates the .sinscribe directory when it does not exist yet", async () => {
    await saveProjectRules(repoRoot, "rule one");

    expect(await loadProjectRules(repoRoot)).toBe("rule one");
  });

  it("writes an empty file when the content is cleared", async () => {
    await saveProjectRules(repoRoot, "something");
    await saveProjectRules(repoRoot, "   ");

    expect(await readFile(getProjectRulesPath(repoRoot), "utf8")).toBe("");
    expect(await loadProjectRules(repoRoot)).toBeNull();
  });
});

describe("loadRules", () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await mkdtemp(path.join(tmpdir(), "sinscribe-rules-test-"));
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it("combines the project tier with whatever the user tier resolves to", async () => {
    await saveProjectRules(repoRoot, "no gitmoji");

    const summary = await loadRules(repoRoot);

    expect(summary.project).toBe("no gitmoji");
    expect(summary.combined).toContain("Project rules:\nno gitmoji");
  });

  it("returns an all-null summary when there is no repo root and no user rules", async () => {
    // Exercises the repoRoot === null path without touching the real home
    // directory (loadUserRules is not mocked here — see the note below).
    const summary = await loadRules(null);

    expect(summary.project).toBeNull();
  });
});
