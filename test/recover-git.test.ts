import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CommandSpec } from "../src/commands.js";
import { openRecoveryWorkspace } from "../src/domain/recover.js";
import {
  matchRecoveryTarget,
  pickRecoveryBranch,
  recoveryBaseConflict,
  type BranchListing,
} from "../src/git/recover.js";
import { git, initRepo, makeTempDir, removeDir } from "./git-fixture.js";

type RecoverSpec = Extract<CommandSpec, { name: "recover" }>;

function spec(overrides: Partial<RecoverSpec> = {}): RecoverSpec {
  return {
    name: "recover",
    target: "ABC-123",
    worktree: false,
    fetch: true,
    from: null,
    save: false,
    ...overrides,
  };
}

describe("recoveryBaseConflict", () => {
  it.each([
    ["main", "origin/main", true],
    ["main", "main", true],
    ["develop", "upstream/develop", true],
    ["ai/BIN-42", "origin/main", false],
    ["main", null, false],
  ])("%s against base %s → refused: %s", (branch, base, refused) => {
    expect(recoveryBaseConflict(branch, base) !== null).toBe(refused);
  });
});

describe("matchRecoveryTarget", () => {
  const listing: BranchListing = {
    local: ["main", "kiro/ABC-123-design"],
    remote: [
      "origin/main",
      "origin/kiro/ABC-123",
      "origin/kiro/ABC-123-design",
      "origin/feat/ABC-1234-other",
      "upstream/kiro/ABC-123",
    ],
  };
  const remotes = ["origin", "upstream"];

  it("matches an exact branch name, with or without its remote", () => {
    expect(matchRecoveryTarget("kiro/ABC-123", listing, remotes)).toEqual([
      { name: "kiro/ABC-123", existsLocally: false, remote: "origin" },
    ]);
    expect(
      matchRecoveryTarget("origin/kiro/ABC-123-design", listing, remotes),
    ).toEqual([
      { name: "kiro/ABC-123-design", existsLocally: true, remote: "origin" },
    ]);
  });

  it("matches a ticket as a whole token, not as a prefix of another", () => {
    expect(
      matchRecoveryTarget("abc-123", listing, remotes).map((b) => b.name),
    ).toEqual(["kiro/ABC-123", "kiro/ABC-123-design"]);
  });

  it("prefers the branch that ends with the ticket", () => {
    const picked = pickRecoveryBranch(
      "ABC-123",
      matchRecoveryTarget("ABC-123", listing, remotes),
    );

    expect(picked).toMatchObject({ name: "kiro/ABC-123" });
  });

  it("asks for the branch when the matches are ambiguous", () => {
    const picked = pickRecoveryBranch("ABC-9", [
      { name: "feat/ABC-9-a", existsLocally: true, remote: null },
      { name: "feat/ABC-9-b", existsLocally: true, remote: null },
    ]);

    expect(picked).toMatch(/Several branches match "ABC-9"/u);
    expect(picked).toContain("feat/ABC-9-b");
  });

  it("explains a target that matches nothing", () => {
    expect(pickRecoveryBranch("nope", [])).toMatch(/No branch matches/u);
  });
});

describe("openRecoveryWorkspace", () => {
  let root: string;
  let origin: string;
  let seed: string;
  let work: string;

  beforeEach(async () => {
    root = await realpath(await makeTempDir("sinscribe-recover-"));
    origin = path.join(root, "origin.git");
    seed = path.join(root, "seed");
    work = path.join(root, "work");
    await git(root, "init", "--bare", "-b", "main", origin);
    await mkdir(seed);
    await initRepo(seed);
    await git(seed, "remote", "add", "origin", origin);
    await git(seed, "push", "origin", "main");
    // What a pipeline leaves: its build branch, and a design side branch.
    await git(seed, "checkout", "-b", "kiro/ABC-123");
    await mkdir(path.join(seed, "docs", "specs", "ABC-123"), {
      recursive: true,
    });
    await writeFile(
      path.join(seed, "docs", "specs", "ABC-123", "spec.md"),
      "# Spec\n",
    );
    await git(seed, "add", ".");
    await git(seed, "commit", "-m", "feat(ABC-123): attempt 2");
    await git(seed, "push", "origin", "kiro/ABC-123");
    await git(seed, "checkout", "-b", "kiro/ABC-123-design", "main");
    await git(seed, "push", "origin", "kiro/ABC-123-design");
    await git(root, "clone", origin, work);
  });

  afterEach(async () => {
    await removeDir(root);
  });

  it("checks out a remote-only branch in place, tracking it", async () => {
    const workspace = await openRecoveryWorkspace(spec(), work);

    expect(workspace).toMatchObject({
      branch: "kiro/ABC-123",
      workdir: work,
      mode: "checkout",
    });
    expect(workspace.notes).toEqual([
      "Fetched origin.",
      "Checked out kiro/ABC-123.",
    ]);
    expect(await git(work, "rev-parse", "--abbrev-ref", "HEAD")).toBe(
      "kiro/ABC-123",
    );
    expect(await git(work, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe(
      "origin/kiro/ABC-123",
    );
  });

  it("refuses to check out over uncommitted changes", async () => {
    await writeFile(path.join(work, "file.txt"), "edited\n");

    await expect(openRecoveryWorkspace(spec(), work)).rejects.toThrow(
      /uncommitted changes.*--worktree/u,
    );
    expect(await git(work, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  });

  it("opens a worktree beside the work in progress, kept out of git status", async () => {
    await writeFile(path.join(work, "file.txt"), "edited\n");

    const workspace = await openRecoveryWorkspace(
      spec({ worktree: true }),
      work,
    );
    const workdir = path.join(work, ".worktrees", "ABC-123");

    expect(workspace).toMatchObject({
      branch: "kiro/ABC-123",
      workdir,
      mode: "worktree",
    });
    expect(await git(workdir, "rev-parse", "--abbrev-ref", "HEAD")).toBe(
      "kiro/ABC-123",
    );
    expect(
      await readFile(path.join(work, ".git", "info", "exclude"), "utf8"),
    ).toContain("/.worktrees/");
    // The edit stays where it was; the worktree does not show up as untracked.
    expect(await git(work, "status", "--porcelain")).toBe("M file.txt");

    const again = await openRecoveryWorkspace(
      spec({ worktree: true, fetch: false }),
      work,
    );

    expect(again).toMatchObject({ workdir, mode: "worktree" });
    expect(again.notes[0]).toMatch(/already checked out at/u);
  });

  it("fast-forwards a local branch the pipeline pushed to since", async () => {
    await openRecoveryWorkspace(spec(), work);
    await git(work, "checkout", "main");
    await git(seed, "checkout", "kiro/ABC-123");
    await writeFile(path.join(seed, "attempt.txt"), "3\n");
    await git(seed, "add", ".");
    await git(seed, "commit", "-m", "feat(ABC-123): attempt 3");
    await git(seed, "push", "origin", "kiro/ABC-123");

    const workspace = await openRecoveryWorkspace(spec(), work);

    expect(workspace.notes).toContain(
      "Fast-forwarded kiro/ABC-123 to origin/kiro/ABC-123 (+1).",
    );
    expect(await git(work, "log", "-1", "--format=%s")).toBe(
      "feat(ABC-123): attempt 3",
    );
  });

  it("leaves a diverged branch alone and says so", async () => {
    await openRecoveryWorkspace(spec(), work);
    await writeFile(path.join(work, "mine.txt"), "local fix\n");
    await git(work, "add", ".");
    await git(work, "commit", "-m", "fix: local attempt");
    await git(work, "checkout", "main");
    await git(seed, "checkout", "kiro/ABC-123");
    await writeFile(path.join(seed, "attempt.txt"), "3\n");
    await git(seed, "add", ".");
    await git(seed, "commit", "-m", "feat(ABC-123): attempt 3");
    await git(seed, "push", "origin", "kiro/ABC-123");

    const workspace = await openRecoveryWorkspace(spec(), work);

    expect(workspace.notes).toContain(
      "kiro/ABC-123 has diverged from origin/kiro/ABC-123 (1 local, 1 remote commits) — left as is; reconcile it before pushing.",
    );
    expect(await git(work, "log", "-1", "--format=%s")).toBe(
      "fix: local attempt",
    );
  });

  it("recovers the current branch without moving when no target is given", async () => {
    await git(work, "checkout", "-q", "kiro/ABC-123");

    const workspace = await openRecoveryWorkspace(spec({ target: null }), work);

    expect(workspace).toMatchObject({
      branch: "kiro/ABC-123",
      workdir: work,
      mode: "current",
    });
  });

  it("refuses to recover the base branch, in place or by name", async () => {
    await expect(
      openRecoveryWorkspace(spec({ target: null }), work),
    ).rejects.toThrow(
      /main is the base branch \(origin\/main\).*sinscribe recover <ticket\|branch>/u,
    );

    await git(work, "checkout", "-q", "-b", "scratch");
    await expect(
      openRecoveryWorkspace(spec({ target: "main", fetch: false }), work),
    ).rejects.toThrow(/main is the base branch/u);
    // Refused before anything moved.
    expect(await git(work, "rev-parse", "--abbrev-ref", "HEAD")).toBe(
      "scratch",
    );
  });

  it("does not see a remote branch it was told not to fetch", async () => {
    await git(seed, "checkout", "-b", "kiro/XYZ-9", "main");
    await git(seed, "push", "origin", "kiro/XYZ-9");

    await expect(
      openRecoveryWorkspace(spec({ target: "XYZ-9", fetch: false }), work),
    ).rejects.toThrow(/No branch matches "XYZ-9"/u);
    await expect(
      openRecoveryWorkspace(spec({ target: "XYZ-9" }), work),
    ).resolves.toMatchObject({ branch: "kiro/XYZ-9" });
  });
});
