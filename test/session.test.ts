import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deleteSession,
  getSessionPath,
  loadSession,
  sanitizeBranchKey,
  saveSession,
  type BranchSession,
} from "../src/session/store.js";

function makeSession(branch: string): BranchSession {
  const now = new Date().toISOString();

  return {
    version: 1,
    branch,
    context: {
      feature: "Add retry logic to the uploader",
      ticket: "ABC-123",
      requirements: null,
    },
    pr: null,
    createdAt: now,
    updatedAt: now,
  };
}

describe("sanitizeBranchKey", () => {
  it("replaces slashes and unsafe characters", () => {
    expect(sanitizeBranchKey("feat/ABC-123-retry")).toBe("feat-ABC-123-retry");
    expect(sanitizeBranchKey("fix/añadir espacio")).toBe("fix-a-adir-espacio");
  });

  it("trims leading and trailing separators", () => {
    expect(sanitizeBranchKey("/feat/x/")).toBe("feat-x");
    expect(sanitizeBranchKey("...")).toBe("detached-head");
  });

  it("falls back for empty input and caps the length", () => {
    expect(sanitizeBranchKey("")).toBe("detached-head");
    expect(sanitizeBranchKey("a".repeat(300))).toHaveLength(100);
  });
});

describe("session store", () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await mkdtemp(path.join(tmpdir(), "sinscribe-test-"));
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it("round-trips a session through save and load", async () => {
    const session = makeSession("feat/retry");

    await saveSession(repoRoot, session);

    const loaded = await loadSession(repoRoot, "feat/retry");

    expect(loaded).not.toBeNull();
    expect(loaded?.branch).toBe("feat/retry");
    expect(loaded?.context?.feature).toBe("Add retry logic to the uploader");
    expect(loaded?.context?.ticket).toBe("ABC-123");
    expect(loaded?.pr).toBeNull();
  });

  it("writes a self-ignoring .gitignore", async () => {
    await saveSession(repoRoot, makeSession("main"));

    const gitignore = await readFile(
      path.join(repoRoot, ".sinscribe", ".gitignore"),
      "utf8",
    );

    expect(gitignore).toBe("sessions/\n");
  });

  it("does not overwrite an existing .gitignore", async () => {
    await saveSession(repoRoot, makeSession("main"));
    await writeFile(
      path.join(repoRoot, ".sinscribe", ".gitignore"),
      "custom\n",
      "utf8",
    );
    await saveSession(repoRoot, makeSession("main"));

    const gitignore = await readFile(
      path.join(repoRoot, ".sinscribe", ".gitignore"),
      "utf8",
    );

    expect(gitignore).toBe("custom\n");
  });

  it("returns null for a missing session", async () => {
    expect(await loadSession(repoRoot, "no-such-branch")).toBeNull();
  });

  it("returns null for corrupt JSON", async () => {
    await saveSession(repoRoot, makeSession("main"));
    await writeFile(getSessionPath(repoRoot, "main"), "{not json", "utf8");

    expect(await loadSession(repoRoot, "main")).toBeNull();
  });

  it("returns null on branch mismatch (lossy key collision)", async () => {
    await saveSession(repoRoot, makeSession("feat/x"));

    // "feat-x" sanitizes to the same file key but is a different branch.
    expect(getSessionPath(repoRoot, "feat-x")).toBe(
      getSessionPath(repoRoot, "feat/x"),
    );
    expect(await loadSession(repoRoot, "feat-x")).toBeNull();
    expect(await loadSession(repoRoot, "feat/x")).not.toBeNull();
  });

  it("round-trips the context target branch (baseRef)", async () => {
    const session = makeSession("feat/retry");

    await saveSession(repoRoot, {
      ...session,
      context: {
        feature: session.context?.feature ?? "",
        ticket: session.context?.ticket ?? null,
        requirements: session.context?.requirements ?? null,
        baseRef: "develop",
      },
    });

    const loaded = await loadSession(repoRoot, "feat/retry");

    expect(loaded?.context?.baseRef).toBe("develop");
  });

  it("still loads a legacy session context without baseRef", async () => {
    await saveSession(repoRoot, makeSession("main"));

    // Simulate a session written before baseRef existed.
    const legacy = {
      version: 1,
      branch: "main",
      context: { feature: "old", ticket: null, requirements: null },
      pr: null,
      createdAt: "2000-01-01T00:00:00.000Z",
      updatedAt: "2000-01-01T00:00:00.000Z",
    };
    await writeFile(
      getSessionPath(repoRoot, "main"),
      `${JSON.stringify(legacy)}\n`,
      "utf8",
    );

    const loaded = await loadSession(repoRoot, "main");

    expect(loaded).not.toBeNull();
    expect(loaded?.context?.feature).toBe("old");
    expect(loaded?.context?.baseRef ?? null).toBeNull();
  });

  it("deletes a session and tolerates a missing file", async () => {
    await saveSession(repoRoot, makeSession("feat/retry"));
    await deleteSession(repoRoot, "feat/retry");

    expect(await loadSession(repoRoot, "feat/retry")).toBeNull();
    // Deleting again (or a never-saved branch) is a no-op.
    await deleteSession(repoRoot, "feat/retry");
    await deleteSession(repoRoot, "never-saved");
  });

  it("does not delete another branch's file on a lossy key collision", async () => {
    await saveSession(repoRoot, makeSession("feat/x"));

    // "feat-x" maps to the same file key but the file belongs to "feat/x".
    await deleteSession(repoRoot, "feat-x");

    expect(await loadSession(repoRoot, "feat/x")).not.toBeNull();
  });

  it("refreshes updatedAt on save", async () => {
    const session = makeSession("main");
    const stale = "2000-01-01T00:00:00.000Z";

    await saveSession(repoRoot, { ...session, updatedAt: stale });

    const loaded = await loadSession(repoRoot, "main");

    expect(loaded?.updatedAt).not.toBe(stale);
  });
});
