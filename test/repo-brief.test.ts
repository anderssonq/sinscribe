import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildRepoBrief, isSecretPath } from "../src/domain/repo-brief.js";
import { git, initRepo, makeTempDir, removeDir } from "./git-fixture.js";

describe("isSecretPath", () => {
  it.each([
    ".env",
    "app/.env.local",
    "certs/server.pem",
    "deploy/id_rsa",
    ".npmrc",
    "config/credentials.json",
    "secrets/db.yml",
    ".sinscribe/sessions/x.json",
  ])("treats %s as secret", (file) => {
    expect(isSecretPath(file)).toBe(true);
  });

  it.each(["src/env.ts", "src/secret-manager.ts", "docs/keys.md"])(
    "keeps %s",
    (file) => {
      expect(isSecretPath(file)).toBe(false);
    },
  );
});

describe("buildRepoBrief", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeTempDir("sinscribe-brief-");
    await initRepo(dir);
    await mkdir(path.join(dir, "src"));
    await writeFile(path.join(dir, "src", "a.ts"), "export {};\n");
    await writeFile(path.join(dir, "src", "b.ts"), "export {};\n");
    await writeFile(path.join(dir, ".env.example"), "KEY=\n");
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ scripts: { test: "vitest run", build: "tsc" } }),
    );
    await writeFile(
      path.join(dir, "CLAUDE.md"),
      "Use pnpm.\nOPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123\n",
    );
    await writeFile(path.join(dir, "untracked.ts"), "x\n");
    await git(dir, "add", "src", "package.json", "CLAUDE.md", ".env.example");
    await git(dir, "commit", "-m", "add");
  });

  afterEach(async () => {
    await removeDir(dir);
  });

  it("lists tracked, non-secret files with scripts and rule docs, redacted", async () => {
    const brief = await buildRepoBrief(dir);

    expect(brief).toContain("src/a.ts");
    expect(brief).not.toContain("untracked.ts");
    expect(brief).not.toContain(".env.example");
    expect(brief).toContain("- test: vitest run");
    expect(brief).toContain("Build manifests at the root: package.json");
    expect(brief).toContain("CLAUDE.md:\nUse pnpm.");
    expect(brief).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123");
  });

  it("truncates the file list with a count", async () => {
    const brief = await buildRepoBrief(dir, { maxFiles: 2 });

    expect(brief).toMatch(/… \+\d+ more files/u);
  });
});
