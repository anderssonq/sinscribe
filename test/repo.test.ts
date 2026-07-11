import { realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ensureGitRepo,
  getCurrentBranch,
  getRepoRoot,
  isGitRepo,
  NotAGitRepositoryError,
  resolveBaseRef,
} from "../src/git/repo.js";
import { git, initRepo, makeTempDir, removeDir } from "./git-fixture.js";

describe("repo", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeTempDir("sinscribe-repo-test-");
  });

  afterEach(async () => {
    await removeDir(dir);
  });

  it("isGitRepo is false outside and true inside a repo", async () => {
    expect(await isGitRepo(dir)).toBe(false);

    await initRepo(dir);

    expect(await isGitRepo(dir)).toBe(true);
  });

  it("ensureGitRepo throws NotAGitRepositoryError outside a repo", async () => {
    await expect(ensureGitRepo(dir)).rejects.toThrow(NotAGitRepositoryError);
  });

  it("getCurrentBranch returns the branch name", async () => {
    await initRepo(dir);

    expect(await getCurrentBranch(dir)).toBe("main");
  });

  it("getCurrentBranch returns null on a detached HEAD", async () => {
    await initRepo(dir);
    await git(dir, "checkout", "--detach");

    expect(await getCurrentBranch(dir)).toBeNull();
  });

  it("getRepoRoot returns the repository root", async () => {
    await initRepo(dir);

    const root = await getRepoRoot(dir);

    // git resolves symlinks (e.g. /tmp -> /private/tmp on macOS).
    expect(root).toBe(await realpath(dir));
  });

  it("getRepoRoot returns null outside a repo", async () => {
    expect(await getRepoRoot(dir)).toBeNull();
  });
});

describe("resolveBaseRef", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeTempDir("sinscribe-base-ref-test-");
  });

  afterEach(async () => {
    await removeDir(dir);
  });

  it("returns a verifiable override as-is", async () => {
    await initRepo(dir);

    expect(await resolveBaseRef(dir, "main")).toBe("main");
  });

  it("returns null for an override that does not resolve", async () => {
    await initRepo(dir);

    expect(await resolveBaseRef(dir, "does-not-exist")).toBeNull();
  });

  it("falls back to a local default branch when there is no origin", async () => {
    await initRepo(dir);
    await git(dir, "checkout", "-b", "feature/x");

    expect(await resolveBaseRef(dir, null)).toBe("main");
  });

  it("prefers origin/HEAD in a cloned repo", async () => {
    const upstream = path.join(dir, "upstream");
    const clone = path.join(dir, "clone");
    await git(dir, "init", "-b", "main", "upstream");
    await initRepoContents(upstream);
    await git(dir, "clone", upstream, clone);

    expect(await resolveBaseRef(clone, null)).toBe("origin/main");
  });

  it("auto-detects develop when no main/master exists", async () => {
    await initRepo(dir, "develop");
    await git(dir, "checkout", "-b", "feature/x");

    expect(await resolveBaseRef(dir, null)).toBe("develop");
  });

  it("returns null when no candidate branch exists", async () => {
    await initRepo(dir, "trunk");

    expect(await resolveBaseRef(dir, null)).toBeNull();
  });
});

async function initRepoContents(cwd: string): Promise<void> {
  await writeFile(path.join(cwd, "file.txt"), "hello\n");
  await git(cwd, "add", ".");
  await git(cwd, "commit", "-m", "init");
}
