import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandSpec, GlobalFlags } from "../src/commands.js";
import { createSessionDraftSystemPrompt } from "../src/domain/prompts.js";
import { dryRunRecover, runRecover } from "../src/domain/recover.js";
import {
  listRecoveryCandidates,
  RECOVERY_DIRECTION,
} from "../src/domain/recover-evidence.js";
import {
  createSessionDraftRun,
  withoutRecoveryGoal,
} from "../src/domain/session-draft.js";
import { loadSession } from "../src/session/store.js";
import { git, initRepo, makeTempDir, removeDir } from "./git-fixture.js";

const mocks = vi.hoisted(() => ({
  runExplore: vi.fn(),
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
  print: true,
  modelId: null,
  provider: "claude-cli",
  apiKey: null,
};

type RecoverSpec = Extract<CommandSpec, { name: "recover" }>;

function spec(overrides: Partial<RecoverSpec> = {}): RecoverSpec {
  return {
    name: "recover",
    target: null,
    worktree: false,
    fetch: false,
    from: null,
    save: false,
    ...overrides,
  };
}

const REPLY = JSON.stringify({
  feature:
    "Predictive bin alerts. Blocked: the threshold test still fails after two attempts.",
  requirements: [
    "Alert when a bin is predicted full within 2 hours",
    "Failure: BinAlertTests.Threshold expects 2h, the code uses 120s",
    "Remaining: wire the alert into the scheduler",
  ],
  ticket: "ABC-123",
  sources: [{ path: "docs/specs/ABC-123/spec.md", why: "acceptance criteria" }],
  openQuestions: ["Is the 2h window measured from the last pickup?"],
});

let repo: string;
let cwd: string;

beforeEach(async () => {
  cwd = process.cwd();
  repo = await makeTempDir("sinscribe-recover-domain-");
  await initRepo(repo);
  await git(repo, "checkout", "-b", "kiro/ABC-123");
  await mkdir(path.join(repo, "docs", "specs", "ABC-123"), { recursive: true });
  await mkdir(path.join(repo, "tests", "plan"), { recursive: true });
  await mkdir(path.join(repo, "src"), { recursive: true });
  await writeFile(
    path.join(repo, "docs", "specs", "ABC-123", "spec.md"),
    "# Spec\nAlert when a bin is predicted full within 2 hours.\n",
  );
  await writeFile(
    path.join(repo, "tests", "plan", "ABC-123.yml"),
    "cases: 3\n",
  );
  await writeFile(path.join(repo, "src", "alerts.ts"), "export {};\n");
  await writeFile(path.join(repo, "build-report.json"), "{}\n");
  await writeFile(path.join(repo, ".env"), "TOKEN=secret\n");
  await git(repo, "add", "docs", "tests", "src", "build-report.json");
  await git(repo, "add", "-f", ".env");
  await git(repo, "commit", "-m", "feat(ABC-123): attempt 2");
  mocks.runExplore.mockReset();
  mocks.runSingleShot.mockReset();
});

afterEach(async () => {
  process.chdir(cwd);
  await removeDir(repo);
});

describe("listRecoveryCandidates", () => {
  it("lists ticket paths and changed reports, prose first, never secrets or code", async () => {
    const candidates = await listRecoveryCandidates(repo, {
      ticket: "ABC-123",
      baseRef: "main",
    });

    expect(candidates).toEqual([
      "docs/specs/ABC-123/spec.md",
      "tests/plan/ABC-123.yml",
      "build-report.json",
    ]);
  });

  it("still finds the ticket's files without a base", async () => {
    expect(
      await listRecoveryCandidates(repo, { ticket: "abc-123", baseRef: null }),
    ).toEqual(["docs/specs/ABC-123/spec.md", "tests/plan/ABC-123.yml"]);
  });
});

describe("dryRunRecover", () => {
  it("describes the recovery without fetching, checking out or calling a model", async () => {
    await git(repo, "checkout", "main");

    const output = await dryRunRecover(
      spec({ target: "ABC-123", worktree: true, fetch: true }),
      repo,
    );

    expect(output).toContain("dry run: no fetch, no checkout");
    expect(output).toContain("Branch:     kiro/ABC-123 (local)");
    expect(output).toContain("Ticket:     ABC-123");
    expect(output).toContain("  docs/specs/ABC-123/spec.md");
    expect(output).toContain(path.join(repo, ".worktrees"));
    expect(await git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(mocks.runExplore).not.toHaveBeenCalled();
  });

  it("flags the base branch instead of listing its evidence", async () => {
    await git(repo, "checkout", "main");

    const output = await dryRunRecover(spec(), repo);

    expect(output).toContain("Refused:    main is the base branch (main)");
    expect(output).toContain("Evidence the AI would read first (0):");
  });
});

describe("withoutRecoveryGoal", () => {
  it("drops the pre-filled goal, or the opening sentence a model echoes", () => {
    expect(withoutRecoveryGoal(RECOVERY_DIRECTION)).toBe("");
    expect(
      withoutRecoveryGoal(
        `${RECOVERY_DIRECTION}\n\nThe PM confirmed: inclusive.`,
      ),
    ).toBe("The PM confirmed: inclusive.");
    expect(
      withoutRecoveryGoal(
        "Recover this branch: an automated pipeline worked on it and could not finish. The branch implements BIN-42.",
      ),
    ).toBe("The branch implements BIN-42.");
    expect(withoutRecoveryGoal("BIN-42 alerts")).toBe("BIN-42 alerts");
  });
});

describe("recovery session draft", () => {
  it("briefs the explorer on the failure: diagnosis, read-first files, recovery rules", async () => {
    const diagnosis = path.join(repo, "..", "diagnosis-recover-test.md");

    await writeFile(
      diagnosis,
      "Build attempt 2 failed: BinAlertTests.Threshold — expected 7200, got 120.\n",
    );
    mocks.runExplore.mockResolvedValue({
      text: REPLY,
      modelId: "m",
      mode: "claude-cli-readonly",
      filesRead: ["docs/specs/ABC-123/spec.md"],
      fallbackReason: null,
    });

    try {
      const run = await createSessionDraftRun(FLAGS, repo, {
        previous: null,
        recovery: { diagnosisPath: diagnosis },
      });

      expect(run.meta.recovery).toEqual({
        candidates: 3,
        diagnosis,
      });

      const draft = await run.generate({
        feedback: null,
        explore: true,
        direction: RECOVERY_DIRECTION,
      });
      const [systemPrompt, userPrompt] = mocks.runExplore.mock.calls[0] as [
        string,
        string,
      ];

      expect(systemPrompt).toContain("RECOVERY MODE");
      expect(systemPrompt).toContain("Never propose making tests pass");
      expect(userPrompt).toContain("RECOVERY MODE: an automated pipeline");
      expect(userPrompt).toContain("expected 7200, got 120");
      expect(userPrompt).toContain("- docs/specs/ABC-123/spec.md");
      expect(draft.requirements).toContain(
        "- Failure: BinAlertTests.Threshold expects 2h",
      );
    } finally {
      await removeDir(diagnosis);
    }
  });

  it("hands a model that cannot open files excerpts of the pipeline's files", async () => {
    mocks.runExplore.mockResolvedValue({
      text: REPLY,
      modelId: "m",
      mode: "single-shot",
      filesRead: [],
      fallbackReason: "this provider cannot explore",
    });

    const run = await createSessionDraftRun(FLAGS, repo, {
      previous: null,
      recovery: { diagnosisPath: null },
    });

    await run.generate({
      feedback: null,
      explore: true,
      direction: RECOVERY_DIRECTION,
    });

    const [, userPrompt, options] = mocks.runExplore.mock.calls[0] as [
      string,
      string,
      { fallbackContext: () => Promise<string> },
    ];
    const fallback = await options.fallbackContext();

    expect(userPrompt).toContain("No diagnosis was supplied");
    expect(fallback).toContain(
      "Files the failed pipeline left on this branch (excerpts):",
    );
    expect(fallback).toContain(
      "--- docs/specs/ABC-123/spec.md ---\n# Spec\nAlert when a bin is predicted full within 2 hours.",
    );
    expect(fallback).toContain("--- tests/plan/ABC-123.yml ---");
    expect(fallback).not.toContain("TOKEN=secret");
  });

  it("keeps the recovery instruction out of the feature, the author's additions in", async () => {
    mocks.runExplore.mockResolvedValue({
      text: JSON.stringify({
        ...JSON.parse(REPLY),
        feature:
          "Recover this branch: an automated pipeline worked on it and could not finish. BIN-42 predictive bin alerts — blocked on the threshold test.",
      }),
      modelId: "m",
      mode: "claude-cli-readonly",
      filesRead: [],
      fallbackReason: null,
    });

    const run = await createSessionDraftRun(FLAGS, repo, {
      previous: null,
      recovery: { diagnosisPath: null },
    });
    const untouched = await run.generate({
      feedback: null,
      explore: true,
      direction: RECOVERY_DIRECTION,
    });

    expect(untouched.feature).toBe(
      "BIN-42 predictive bin alerts — blocked on the threshold test.",
    );

    const added = await (
      await createSessionDraftRun(FLAGS, repo, {
        previous: null,
        recovery: { diagnosisPath: null },
      })
    ).generate({
      feedback: null,
      explore: true,
      direction: `${RECOVERY_DIRECTION}\n\nThe PM confirmed the boundary is inclusive.`,
    });

    expect(added.feature).toBe(
      "The PM confirmed the boundary is inclusive.\n\nBIN-42 predictive bin alerts — blocked on the threshold test.",
    );
  });

  it("keeps the plain session draft free of recovery rules", () => {
    expect(createSessionDraftSystemPrompt({}, null)).not.toContain(
      "RECOVERY MODE",
    );
  });
});

describe("runRecover", () => {
  beforeEach(() => {
    mocks.runExplore.mockResolvedValue({
      text: REPLY,
      modelId: "m",
      mode: "claude-cli-readonly",
      filesRead: [],
      fallbackReason: null,
    });
  });

  it("prints the drafted context and saves nothing without --save", async () => {
    const output = await runRecover(spec(), FLAGS, repo);

    expect(output).toContain("Recovering the current branch, kiro/ABC-123.");
    expect(output).toContain("Failure: BinAlertTests.Threshold");
    expect(output).toContain("Not saved.");
    expect(await loadSession(repo, "kiro/ABC-123")).toBeNull();
  });

  it("saves the context with --save, open questions included", async () => {
    const output = await runRecover(spec({ save: true }), FLAGS, repo);
    const session = await loadSession(repo, "kiro/ABC-123");

    expect(output).toContain("Saved as the session context of kiro/ABC-123");
    expect(session?.context?.ticket).toBe("ABC-123");
    expect(session?.context?.requirements).toContain(
      "Open questions:\n- Is the 2h window measured from the last pickup?",
    );
  });

  it("checks the diagnosis file before touching git", async () => {
    await git(repo, "checkout", "main");

    await expect(
      runRecover(
        spec({ target: "ABC-123", from: "missing-diagnosis.md" }),
        FLAGS,
        repo,
      ),
    ).rejects.toThrow(/Cannot read the diagnosis file/u);
    expect(await git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  });
});
