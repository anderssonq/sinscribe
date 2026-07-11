import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyBranchName } from "../src/domain/branch-actions.js";
import { CliError } from "../src/domain/errors.js";
import { branchExists, getCurrentBranch } from "../src/git/repo.js";
import { GitCommandError } from "../src/git/run.js";
import {
  loadSession,
  saveSession,
  type BranchSession,
} from "../src/session/store.js";
import { git, initRepo, makeTempDir, removeDir } from "./git-fixture.js";

function makeSession(branch: string, withPr = false): BranchSession {
  const now = new Date().toISOString();

  return {
    version: 1,
    branch,
    context: {
      feature: "Add retry logic",
      ticket: "ABC-123",
      requirements: null,
      baseRef: "main",
    },
    pr: withPr
      ? {
          template: "github",
          description: "## Summary",
          baseRef: "main",
          generatedAt: now,
        }
      : null,
    createdAt: now,
    updatedAt: now,
  };
}

let repo: string;

beforeEach(async () => {
  repo = await makeTempDir("sinscribe-branch-actions-");
  await initRepo(repo);
});

afterEach(async () => {
  await removeDir(repo);
});

describe("applyBranchName (create)", () => {
  it("creates the branch from the base and migrates the context", async () => {
    const result = await applyBranchName({
      cwd: repo,
      repoRoot: repo,
      name: "feat/ABC-123-retry",
      mode: "create",
      baseRef: "main",
      sourceSession: makeSession("main", true),
    });

    expect(result).toEqual({
      branch: "feat/ABC-123-retry",
      mode: "create",
      baseRef: "main",
      sessionMigrated: true,
    });
    expect(await getCurrentBranch(repo)).toBe("feat/ABC-123-retry");
    expect(await git(repo, "rev-parse", "feat/ABC-123-retry")).toBe(
      await git(repo, "rev-parse", "main"),
    );

    const migrated = await loadSession(repo, "feat/ABC-123-retry");

    expect(migrated?.context?.feature).toBe("Add retry logic");
    // A generated PR belongs to the branch it described.
    expect(migrated?.pr).toBeNull();
  });

  it("reports no migration when there is no source session", async () => {
    const result = await applyBranchName({
      cwd: repo,
      repoRoot: repo,
      name: "feat/blank",
      mode: "create",
      baseRef: "main",
      sourceSession: null,
    });

    expect(result.sessionMigrated).toBe(false);
    expect(await loadSession(repo, "feat/blank")).toBeNull();
  });

  it("rejects a name that already exists", async () => {
    await git(repo, "branch", "feat/taken");

    await expect(
      applyBranchName({
        cwd: repo,
        repoRoot: repo,
        name: "feat/taken",
        mode: "create",
        baseRef: "main",
        sourceSession: null,
      }),
    ).rejects.toThrow(/already exists/u);
  });

  it("rejects an unresolved base", async () => {
    await expect(
      applyBranchName({
        cwd: repo,
        repoRoot: repo,
        name: "feat/x",
        mode: "create",
        baseRef: null,
        sourceSession: null,
      }),
    ).rejects.toThrow(CliError);
  });

  it("rejects a base that does not exist", async () => {
    await expect(
      applyBranchName({
        cwd: repo,
        repoRoot: repo,
        name: "feat/x",
        mode: "create",
        baseRef: "no-such-branch",
        sourceSession: null,
      }),
    ).rejects.toThrow(/does not exist/u);
  });
});

describe("applyBranchName (rename)", () => {
  it("renames the current branch and keeps context and pr", async () => {
    await git(repo, "checkout", "-b", "feature/old-name");

    const source = makeSession("feature/old-name", true);

    await saveSession(repo, source);

    const result = await applyBranchName({
      cwd: repo,
      repoRoot: repo,
      name: "feature/new-name",
      mode: "rename",
      baseRef: null,
      sourceSession: source,
    });

    expect(result.mode).toBe("rename");
    expect(result.baseRef).toBeNull();
    expect(await getCurrentBranch(repo)).toBe("feature/new-name");
    expect(await branchExists(repo, "feature/old-name")).toBe(false);

    const migrated = await loadSession(repo, "feature/new-name");

    expect(migrated?.context?.ticket).toBe("ABC-123");
    // A rename keeps the same line of work, so the PR survives.
    expect(migrated?.pr?.template).toBe("github");
    // The retired name's session is gone — a future branch reusing it
    // must not inherit this feature's context.
    expect(await loadSession(repo, "feature/old-name")).toBeNull();
  });

  it("keeps the migrated session when old and new names share a file key", async () => {
    // "feat/x" and "feat-x" both sanitize to the key "feat-x": the delete of
    // the old name must not remove the file just written for the new name.
    await git(repo, "checkout", "-b", "feat/x");

    const source = makeSession("feat/x");

    await saveSession(repo, source);

    await applyBranchName({
      cwd: repo,
      repoRoot: repo,
      name: "feat-x",
      mode: "rename",
      baseRef: null,
      sourceSession: source,
    });

    const migrated = await loadSession(repo, "feat-x");

    expect(migrated?.context?.feature).toBe("Add retry logic");
  });

  it("surfaces git's stderr through GitCommandError on an invalid name", async () => {
    await git(repo, "checkout", "-b", "feature/ok");

    try {
      await applyBranchName({
        cwd: repo,
        repoRoot: repo,
        name: "bad..name",
        mode: "rename",
        baseRef: null,
        sourceSession: null,
      });
      expect.unreachable("applyBranchName should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(GitCommandError);
      expect((error as GitCommandError).message).toMatch(
        /not a valid branch name/iu,
      );
      expect((error as GitCommandError).args).toEqual([
        "branch",
        "-m",
        "bad..name",
      ]);
    }
  });
});
