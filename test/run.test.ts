import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GitCommandError,
  runGit,
  runGitStrict,
  tryGit,
} from "../src/git/run.js";
import { initRepo, makeTempDir, removeDir } from "./git-fixture.js";

describe("runGit", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeTempDir("sinscribe-run-test-");
  });

  afterEach(async () => {
    await removeDir(dir);
  });

  it("returns trimmed stdout on success", async () => {
    await initRepo(dir);

    const branch = await runGit(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);

    expect(branch).toBe("main");
  });

  it("returns git's error text instead of throwing on failure", async () => {
    const output = await runGit(dir, ["status"]);

    expect(output).toMatch(/not a git repository/iu);
  });
});

describe("tryGit", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeTempDir("sinscribe-try-git-test-");
  });

  afterEach(async () => {
    await removeDir(dir);
  });

  it("returns trimmed stdout on success", async () => {
    await initRepo(dir);

    const result = await tryGit(dir, ["rev-parse", "--is-inside-work-tree"]);

    expect(result).toBe("true");
  });

  it("returns null when git exits non-zero", async () => {
    const result = await tryGit(dir, ["rev-parse", "--verify", "HEAD"]);

    expect(result).toBeNull();
  });
});

describe("runGitStrict", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeTempDir("sinscribe-strict-git-test-");
  });

  afterEach(async () => {
    await removeDir(dir);
  });

  it("returns trimmed stdout on success", async () => {
    await initRepo(dir);

    const branch = await runGitStrict(dir, [
      "rev-parse",
      "--abbrev-ref",
      "HEAD",
    ]);

    expect(branch).toBe("main");
  });

  it("throws GitCommandError with stderr and args on failure", async () => {
    await initRepo(dir);

    try {
      await runGitStrict(dir, ["checkout", "-b", "bad..name"]);
      expect.unreachable("runGitStrict should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(GitCommandError);

      const gitError = error as GitCommandError;

      expect(gitError.args).toEqual(["checkout", "-b", "bad..name"]);
      expect(gitError.exitCode).not.toBe(0);
      expect(gitError.message).toMatch(/not a valid branch name/iu);
      expect(gitError.stderr).toMatch(/not a valid branch name/iu);
    }
  });
});
