import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandSpec, GlobalFlags } from "../src/commands.js";
import {
  approveStage,
  createStageRun,
  dryRunPlan,
  loadPlanContext,
  type PlanContext,
  readLoopPrompt,
  readPlan,
  replaceSection,
  runPlan,
  syncPlan,
} from "../src/domain/plan.js";
import { extractLog, parseIndex } from "../src/domain/plan-docs.js";
import { saveSession, deleteSession } from "../src/session/store.js";
import { git, initRepo, makeTempDir, removeDir } from "./git-fixture.js";

const mocks = vi.hoisted(() => ({
  runExplore:
    vi.fn<
      (
        system: string,
        user: string,
        options: { explore: boolean },
      ) => Promise<unknown>
    >(),
  runSingleShot: vi.fn(),
}));

vi.mock("../src/llm/explore.js", () => ({ runExplore: mocks.runExplore }));
vi.mock("../src/llm/single-shot.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../src/llm/single-shot.js")>();

  return { ...original, runSingleShot: mocks.runSingleShot };
});

const FLAGS: GlobalFlags = {
  dryRun: false,
  print: false,
  modelId: null,
  provider: null,
  apiKey: null,
};

const BRANCH = "feat/reset";

const REQUIREMENTS = [
  "## Objective & users",
  "Users reset forgotten passwords.",
  "",
  "## Functional requirements",
  "### REQ-1: Request a reset link",
  "- AC-1.1: WHEN a known email is submitted THE SYSTEM SHALL email a link",
  "- AC-1.2: WHEN an unknown email is submitted THE SYSTEM SHALL respond identically",
  "",
  "## Out of scope",
  "- SMS. Debug key: sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
].join("\n");

const DESIGN = [
  "## Overview",
  "Token table plus mailer.",
  "",
  "## Context read",
  "_Filled in by Sinscribe._",
  "",
  "## Traceability",
  "| REQ-1 | D-1 |",
].join("\n");

const GOOD_TASKS = [
  "## Phase 1: Reset request",
  "- [ ] T-1: Store reset tokens",
  "  - Implements: AC-1.1",
  "  - Depends on: none",
  "  - Files: `src/tokens.ts`",
  "  - Acceptance: tokens persist",
  "  - Verify: `pnpm test tokens`",
  "  - Size: S",
  "- [ ] T-2: Uniform response",
  "  - Implements: AC-1.2",
  "  - Depends on: T-1",
  "  - Files: `src/reset.ts`",
  "  - Acceptance: same body for unknown emails",
  "  - Verify: `pnpm test reset`",
  "  - Size: XS",
  "- [ ] Checkpoint: reset works end to end",
].join("\n");

const BAD_TASKS = GOOD_TASKS.replace("AC-1.2", "AC-9.9");

const HANDOFF_NARRATIVE = [
  "## Current state",
  "Nothing built yet.",
  "",
  "## Next step",
  "Implement T-1.",
].join("\n");

type PlanSpec = Extract<CommandSpec, { name: "plan" }>;

function spec(overrides: Partial<PlanSpec> = {}): PlanSpec {
  return {
    name: "plan",
    stage: null,
    action: "generate",
    explore: true,
    feedback: null,
    ...overrides,
  };
}

function explored(text: string, filesRead: string[] = []) {
  return {
    text,
    modelId: "m",
    mode: filesRead.length > 0 ? "claude-cli-readonly" : "single-shot",
    filesRead,
    fallbackReason: null,
  };
}

let repo: string;

async function saveContext(): Promise<void> {
  const now = new Date().toISOString();

  await saveSession(repo, {
    version: 1,
    branch: BRANCH,
    context: {
      feature: "Password reset",
      ticket: "AUTH-7",
      requirements: "Links expire",
      baseRef: "main",
    },
    pr: null,
    createdAt: now,
    updatedAt: now,
  });
}

async function generateAndApprove(
  ctx: PlanContext,
  stage: "requirements" | "design" | "tasks" | "handoff",
): Promise<string[]> {
  const run = createStageRun(ctx, await readPlan(ctx), stage, FLAGS, {
    explore: true,
    revise: "fresh",
  });

  await run.generate(null);

  return run.approve();
}

async function readPlanFile(name: string): Promise<string> {
  return readFile(path.join(repo, "specs", "feat-reset", name), "utf8");
}

beforeEach(async () => {
  repo = await makeTempDir("sinscribe-plan-");
  await initRepo(repo);
  await git(repo, "checkout", "-b", BRANCH);
  await saveContext();
  mocks.runExplore.mockReset();
  mocks.runSingleShot.mockReset();
});

afterEach(async () => {
  await removeDir(repo);
});

describe("plan pipeline", () => {
  it("gates each stage on its approved upstream", async () => {
    const ctx = await loadPlanContext(repo);
    const snap = await readPlan(ctx);

    expect(snap.next).toBe("requirements");
    expect(() =>
      createStageRun(ctx, snap, "design", FLAGS, {
        explore: true,
        revise: "fresh",
      }),
    ).toThrow("Approve requirements.md first.");
  });

  it("runs requirements → design → tasks → handoff with traceable, linked files", async () => {
    const ctx = await loadPlanContext(repo);

    mocks.runExplore.mockResolvedValueOnce(explored(REQUIREMENTS));

    const reqRun = createStageRun(
      ctx,
      await readPlan(ctx),
      "requirements",
      FLAGS,
      {
        explore: true,
        revise: "fresh",
      },
    );
    const reqDraft = await reqRun.generate(null);

    expect(reqDraft.content).not.toContain("sk-ant-api03");
    expect(reqDraft.warnings).toContain("redacted 1 secret-looking value(s)");
    expect(mocks.runExplore.mock.calls[0][1]).toContain(
      "Feature: Password reset",
    );
    expect(mocks.runExplore.mock.calls[0][2].explore).toBe(true);
    expect(await reqRun.approve()).toContain("Next: Design (design.md)");

    // design: explores, sees the approved requirements, records files read.
    mocks.runExplore.mockResolvedValueOnce(explored(DESIGN, ["src/auth.ts"]));
    await generateAndApprove(ctx, "design");
    expect(mocks.runExplore.mock.calls[1][1]).toContain(
      "===== APPROVED requirements.md =====",
    );
    expect(await readPlanFile("design.md")).toContain("- `src/auth.ts`");
    expect(await readPlanFile("design.md")).toContain(
      "[Requirements](requirements.md)",
    );

    // tasks: a dangling AC reference blocks approval…
    mocks.runExplore.mockResolvedValueOnce(explored(BAD_TASKS));

    const badRun = createStageRun(ctx, await readPlan(ctx), "tasks", FLAGS, {
      explore: true,
      revise: "fresh",
    });
    const badDraft = await badRun.generate(null);

    expect(badDraft.warnings).toContain(
      "✗ T-2 implements AC-9.9, which requirements.md lacks",
    );
    expect(mocks.runExplore.mock.calls[2][2].explore).toBe(false);
    await expect(badRun.approve()).rejects.toThrow("Cannot approve tasks.md");

    // …and the revised list passes, writing the loop prompt.
    mocks.runExplore.mockResolvedValueOnce(explored(GOOD_TASKS));
    await badRun.generate("cover AC-1.2");
    expect(mocks.runExplore.mock.calls[3][1]).toContain("cover AC-1.2");
    expect(await badRun.approve()).toContain(
      "Wrote specs/feat-reset/LOOP_PROMPT.md",
    );

    // handoff: single-shot, wrapped in code-owned zones.
    mocks.runSingleShot.mockResolvedValueOnce({
      text: `${HANDOFF_NARRATIVE}\n\n## Log\nmodel junk`,
      modelId: "m",
    });

    const lines = await generateAndApprove(ctx, "handoff");
    const handoff = await readPlanFile("handoff.md");

    expect(lines.at(-1)).toMatch(/Plan approved/u);
    expect(handoff).toContain("<!-- sinscribe:status:start -->");
    expect(handoff).toContain("| T-1: Store reset tokens | **next** | — |");
    expect(handoff).not.toContain("model junk");
    expect(handoff).toContain("## Log");

    const snap = await readPlan(ctx);

    expect(snap.next).toBeNull();
    expect(snap.views.handoff.status).toBe("approved");
    expect(
      parseIndex(await readPlanFile("index.md"))?.stages.design?.mode,
    ).toBe("claude-cli-readonly");
    expect(await readLoopPrompt(ctx)).toContain("specs/feat-reset/tasks.md");
  });

  it("hand edits upstream make downstream stale until accepted and regenerated", async () => {
    const ctx = await loadPlanContext(repo);

    mocks.runExplore
      .mockResolvedValueOnce(explored(REQUIREMENTS))
      .mockResolvedValueOnce(explored(DESIGN));
    await generateAndApprove(ctx, "requirements");
    await generateAndApprove(ctx, "design");

    const file = path.join(ctx.dir, "requirements.md");

    await writeFile(
      file,
      (await readFile(file, "utf8")).replace("identically", "the same way"),
    );

    let snap = await readPlan(ctx);

    expect(snap.views.requirements.editedSinceApproval).toBe(true);
    expect(snap.views.design.status).toBe("stale");
    expect(snap.next).toBe("requirements");

    expect(await approveStage(ctx, null)).toEqual(
      expect.arrayContaining([
        "Approved specs/feat-reset/requirements.md",
        "Now stale: design.md — regenerate in order.",
      ]),
    );

    snap = await readPlan(ctx);
    expect(snap.views.requirements.editedSinceApproval).toBe(false);
    await expect(approveStage(ctx, "design")).rejects.toThrow(/stale/u);
  });

  it("accepts consistent hand edits to an upstream and its downstream", async () => {
    const ctx = await loadPlanContext(repo);

    mocks.runExplore
      .mockResolvedValueOnce(explored(REQUIREMENTS))
      .mockResolvedValueOnce(explored(DESIGN));
    await generateAndApprove(ctx, "requirements");
    await generateAndApprove(ctx, "design");

    for (const name of ["requirements.md", "design.md"]) {
      const file = path.join(ctx.dir, name);
      const raw = await readFile(file, "utf8");

      // Inside the body markers, where an edit changes the approved hash.
      await writeFile(
        file,
        raw.replace(
          "<!-- sinscribe:body:end -->",
          "Edited.\n<!-- sinscribe:body:end -->",
        ),
      );
    }

    expect((await readPlan(ctx)).views.design.status).toBe("stale");

    await approveStage(ctx, "requirements");
    await approveStage(ctx, "design");

    const snap = await readPlan(ctx);

    expect(snap.views.design.status).toBe("approved");
    expect(snap.views.design.editedSinceApproval).toBe(false);
  });

  it("print mode will not regenerate a hand-edited approved stage", async () => {
    const ctx = await loadPlanContext(repo);

    mocks.runExplore.mockResolvedValueOnce(explored(REQUIREMENTS));
    await generateAndApprove(ctx, "requirements");

    const file = path.join(ctx.dir, "requirements.md");
    const edited = (await readFile(file, "utf8")).replace(
      "identically",
      "the same way",
    );

    await writeFile(file, edited);

    const output = await runPlan(spec(), FLAGS, repo);

    expect(output).toContain("was edited after approval");
    expect(await readFile(file, "utf8")).toBe(edited);
    expect(mocks.runExplore).toHaveBeenCalledTimes(1);
  });

  it("feedback on a saved draft revises that draft", async () => {
    mocks.runExplore.mockResolvedValueOnce(explored(REQUIREMENTS));
    await runPlan(spec(), FLAGS, repo);

    const ctx = await loadPlanContext(repo);
    const run = createStageRun(
      ctx,
      await readPlan(ctx),
      "requirements",
      FLAGS,
      {
        explore: true,
        revise: "fresh",
      },
    );

    mocks.runExplore.mockResolvedValueOnce(explored(REQUIREMENTS));
    await run.generate("split REQ-2 in two");

    const prompt = mocks.runExplore.mock.calls[1][1];

    expect(prompt).toContain("Previous version of requirements.md");
    expect(prompt).toContain("split REQ-2 in two");
  });

  it("syncs progress from [T-n] commits without touching the log", async () => {
    const ctx = await loadPlanContext(repo);

    mocks.runExplore
      .mockResolvedValueOnce(explored(REQUIREMENTS))
      .mockResolvedValueOnce(explored(DESIGN))
      .mockResolvedValueOnce(explored(GOOD_TASKS));
    mocks.runSingleShot.mockResolvedValueOnce({
      text: HANDOFF_NARRATIVE,
      modelId: "m",
    });

    for (const stage of [
      "requirements",
      "design",
      "tasks",
      "handoff",
    ] as const) {
      await generateAndApprove(ctx, stage);
    }

    // The agent appends a log entry, ticks T-1 and commits it.
    const handoffPath = path.join(ctx.dir, "handoff.md");
    const tasksPath = path.join(ctx.dir, "tasks.md");
    const entry = "\n### 2026-10-07 · T-1: Store reset tokens\n- Commit: abc\n";

    await writeFile(
      handoffPath,
      (await readFile(handoffPath, "utf8")).replace(
        "<!-- sinscribe:body:end -->",
        `${entry}<!-- sinscribe:body:end -->`,
      ),
    );
    await writeFile(
      tasksPath,
      (await readFile(tasksPath, "utf8")).replace("- [ ] T-1", "- [x] T-1"),
    );
    await git(repo, "add", ".");
    await git(repo, "commit", "-m", "feat: store tokens [T-1]");

    const logBefore = extractLog((await readPlan(ctx)).bodies.handoff ?? "");
    const lines = await syncPlan(ctx);

    expect(lines[0]).toBe("tasks 1/2 · ACs 1/2 done · next T-2");
    expect(lines).toContain("Next task: T-2: Uniform response");

    const after = await readPlan(ctx);

    expect(extractLog(after.bodies.handoff ?? "")).toBe(logBefore);
    expect(after.bodies.handoff).toMatch(
      /\| T-1: Store reset tokens \| done \| [0-9a-f]+ \|/u,
    );
    // Ticking a box is progress, not an edit: the plan stays approved.
    expect(after.views.tasks.editedSinceApproval).toBe(false);
    expect(after.next).toBeNull();

    // Regenerating the handoff feeds back the agent's log and the checkbox
    // truth, last, so the narrative cannot drift from the real state.
    mocks.runSingleShot.mockResolvedValueOnce({
      text: HANDOFF_NARRATIVE,
      modelId: "m",
    });
    await generateAndApprove(ctx, "handoff");

    const handoffPrompt = String(mocks.runSingleShot.mock.calls.at(-1)?.[1]);

    expect(handoffPrompt).toContain("### 2026-10-07 · T-1: Store reset tokens");
    expect(handoffPrompt).toContain("- Done (checked): T-1");
    expect(handoffPrompt.trimEnd().endsWith("Write handoff.md now.")).toBe(
      true,
    );
    expect(handoffPrompt.indexOf("AUTHORITATIVE task state")).toBeGreaterThan(
      handoffPrompt.indexOf("===== END tasks.md ====="),
    );
    expect(extractLog((await readPlan(ctx)).bodies.handoff ?? "")).toBe(
      logBefore,
    );
  });

  it("print mode saves a draft and never approves it", async () => {
    mocks.runExplore.mockResolvedValueOnce(explored(REQUIREMENTS));

    const output = await runPlan(spec(), FLAGS, repo);
    const ctx = await loadPlanContext(repo);
    const snap = await readPlan(ctx);

    expect(output).toContain("Saved draft specs/feat-reset/requirements.md");
    expect(output).toContain("sinscribe plan --approve --stage requirements");
    expect(snap.views.requirements.status).toBe("draft");

    await runPlan(spec({ action: "approve" }), FLAGS, repo);
    expect((await readPlan(ctx)).views.requirements.status).toBe("approved");
  });

  it("a teammate without the local session continues from index.md", async () => {
    mocks.runExplore.mockResolvedValueOnce(explored(REQUIREMENTS));
    await generateAndApprove(await loadPlanContext(repo), "requirements");
    await deleteSession(repo, BRANCH);

    const ctx = await loadPlanContext(repo);

    expect(ctx.feature).toBe("Password reset");
  });

  it("refuses a plan directory written for another branch", async () => {
    mocks.runExplore.mockResolvedValueOnce(explored(REQUIREMENTS));

    const ctx = await loadPlanContext(repo);

    await generateAndApprove(ctx, "requirements");

    const indexPath = path.join(ctx.dir, "index.md");

    await writeFile(
      indexPath,
      (await readFile(indexPath, "utf8")).replace(
        '"branch":"feat/reset"',
        '"branch":"feat-reset"',
      ),
    );

    expect((await readPlan(ctx)).conflict).toMatch(
      /belongs to branch feat-reset/u,
    );
    await expect(syncPlan(ctx)).rejects.toThrow(/belongs to branch/u);
  });

  it("dry run reports the plan without a model", async () => {
    const output = await dryRunPlan(spec({ explore: false }), null, repo);

    expect(output).toContain("dry run: no LLM call");
    expect(output).toContain("specs/feat-reset/ (tracked by git");
    expect(output).toContain("generate requirements.md (single-shot");
    expect(mocks.runExplore).not.toHaveBeenCalled();
    await rm(path.join(repo, ".sinscribe"), { recursive: true, force: true });
    expect(await dryRunPlan(spec(), null, repo)).toContain("(missing");
  });
});

describe("replaceSection", () => {
  it("swaps one section's content and keeps the rest", () => {
    expect(replaceSection("## A\nold\n\n## B\nkeep", "A", "new")).toBe(
      "## A\nnew\n\n## B\nkeep",
    );
    expect(replaceSection("## B\nkeep", "A", "new")).toBe("## B\nkeep");
  });
});
