import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  capText,
  getLocalDiff,
  getStagedDiff,
  getWorktreeShortStat,
  parseNumStat,
} from "../src/git/diff.js";
import { git, initRepo, makeTempDir, removeDir } from "./git-fixture.js";

describe("capText", () => {
  it("returns text unchanged when under the cap", () => {
    const result = capText("small diff\n", 1000);

    expect(result).toEqual({ text: "small diff\n", truncated: false });
  });

  it("truncates at a line boundary and appends a marker", () => {
    const original = Array.from({ length: 20 }, (_, i) => `line-${i}`).join(
      "\n",
    );

    const result = capText(original, 50);

    expect(result.truncated).toBe(true);
    expect(result.text).toContain("[diff truncated to 50 bytes]");

    const kept = result.text.slice(0, result.text.indexOf("\n[diff truncated"));
    expect(original.startsWith(kept)).toBe(true);
    expect(kept.endsWith("\n")).toBe(false);
  });

  it("caps at a raw byte offset, which can split a multi-byte character", () => {
    // 60 two-byte characters on one line; a 99-byte cap lands mid-character,
    // so the 49 whole characters survive and the split byte decodes as U+FFFD.
    const original = "é".repeat(60);

    const result = capText(original, 99);

    expect(result.truncated).toBe(true);
    expect(result.text.startsWith("é".repeat(49))).toBe(true);
    expect(result.text).toContain("[diff truncated to 99 bytes]");
  });
});

describe("parseNumStat", () => {
  it("sums files, insertions and deletions across lines", () => {
    const stat = parseNumStat("10\t2\tsrc/a.ts\n0\t4\tsrc/b.ts\n3\t0\tc.md\n");

    expect(stat).toEqual({ files: 3, insertions: 13, deletions: 6 });
  });

  it("counts binary files without line counts", () => {
    const stat = parseNumStat("5\t1\tsrc/a.ts\n-\t-\tassets/logo.png\n");

    expect(stat).toEqual({ files: 2, insertions: 5, deletions: 1 });
  });

  it("handles paths containing tabs (only the first two fields count)", () => {
    const stat = parseNumStat("1\t1\tweird\tname.txt\n");

    expect(stat).toEqual({ files: 1, insertions: 1, deletions: 1 });
  });

  it("returns null for an empty diff", () => {
    expect(parseNumStat("")).toBeNull();
  });

  it("returns null for unrecognized output", () => {
    expect(parseNumStat("fatal: not a git repository")).toBeNull();
  });
});

describe("getWorktreeShortStat", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeTempDir("sinscribe-shortstat-test-");
    await initRepo(dir);
  });

  afterEach(async () => {
    await removeDir(dir);
  });

  it("returns null when the worktree is clean", async () => {
    expect(await getWorktreeShortStat(dir)).toBeNull();
  });

  it("counts insertions and deletions of tracked changes", async () => {
    // initRepo writes "hello\n"; replace it with two new lines: -1 +2.
    await writeFile(path.join(dir, "file.txt"), "goodbye\nworld\n");

    const stat = await getWorktreeShortStat(dir);

    expect(stat).toEqual({ files: 1, insertions: 2, deletions: 1 });
  });

  it("returns null outside a git repository", async () => {
    const plain = await makeTempDir("sinscribe-shortstat-plain-");

    try {
      expect(await getWorktreeShortStat(plain)).toBeNull();
    } finally {
      await removeDir(plain);
    }
  });
});

describe("getStagedDiff", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeTempDir("sinscribe-diff-test-");
    await initRepo(dir);
  });

  afterEach(async () => {
    await removeDir(dir);
  });

  it("reports an empty diff when nothing is staged", async () => {
    const diff = await getStagedDiff(dir);

    expect(diff.isEmpty).toBe(true);
    expect(diff.truncated).toBe(false);
    expect(diff.patch).toBe("");
  });

  it("captures a staged change", async () => {
    await writeFile(path.join(dir, "file.txt"), "hello\nworld\n");
    await git(dir, "add", "file.txt");

    const diff = await getStagedDiff(dir);

    expect(diff.isEmpty).toBe(false);
    expect(diff.truncated).toBe(false);
    expect(diff.patch).toContain("+world");
    expect(diff.nameStatus).toContain("file.txt");
    expect(diff.stat).toContain("file.txt");
  });
});

describe("getLocalDiff", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeTempDir("sinscribe-localdiff-test-");
    await initRepo(dir);
    await git(dir, "checkout", "-b", "feature");
  });

  afterEach(async () => {
    await removeDir(dir);
  });

  it("describes uncommitted worktree changes vs the target branch by default", async () => {
    // The exact scenario a user hits: a fresh branch, changes not committed.
    await writeFile(path.join(dir, "file.txt"), "hello\nworld\n");

    const diff = await getLocalDiff(dir, "main", { staged: false });

    expect(diff.isEmpty).toBe(false);
    expect(diff.patch).toContain("+world");
    expect(diff.nameStatus).toContain("file.txt");
  });

  it("ignores unstaged changes when staged is true", async () => {
    await writeFile(path.join(dir, "file.txt"), "hello\nworld\n");

    const worktree = await getLocalDiff(dir, "main", { staged: false });
    const stagedOnly = await getLocalDiff(dir, "main", { staged: true });

    expect(worktree.isEmpty).toBe(false);
    expect(stagedOnly.isEmpty).toBe(true);

    await git(dir, "add", "file.txt");
    const afterAdd = await getLocalDiff(dir, "main", { staged: true });

    expect(afterAdd.isEmpty).toBe(false);
    expect(afterAdd.patch).toContain("+world");
  });

  it("excludes commits that landed on the target after divergence (merge-base)", async () => {
    // Advance main past the branch point; the branch's diff must not show it.
    await git(dir, "checkout", "main");
    await writeFile(path.join(dir, "on-main.txt"), "main-only\n");
    await git(dir, "add", "on-main.txt");
    await git(dir, "commit", "-m", "main moves ahead");
    await git(dir, "checkout", "feature");
    await writeFile(path.join(dir, "file.txt"), "hello\nworld\n");

    const diff = await getLocalDiff(dir, "main", { staged: false });

    expect(diff.patch).toContain("+world");
    expect(diff.nameStatus).not.toContain("on-main.txt");
  });
});
