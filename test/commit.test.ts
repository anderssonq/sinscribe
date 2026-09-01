import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandSpec, GlobalFlags } from "../src/commands.js";
import {
  dryRunCommit,
  GITMOJI_BY_TYPE,
  runCommit,
} from "../src/domain/commit.js";
import { CliError } from "../src/domain/errors.js";
import { NotAGitRepositoryError } from "../src/git/repo.js";
import { git, initRepo, makeTempDir, removeDir } from "./git-fixture.js";

const runSingleShotMock = vi.hoisted(() => vi.fn());

vi.mock("../src/llm/single-shot.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../src/llm/single-shot.js")>();

  return { ...original, runSingleShot: runSingleShotMock };
});

type CommitSpec = Extract<CommandSpec, { name: "commit" }>;

const FLAGS: GlobalFlags = {
  dryRun: false,
  print: false,
  modelId: null,
  provider: null,
  apiKey: null,
};

function makeSpec(overrides: Partial<CommitSpec> = {}): CommitSpec {
  return {
    name: "commit",
    all: false,
    scope: null,
    gitmoji: true,
    ...overrides,
  };
}

function modelReply(payload: unknown): { text: string; modelId: string } {
  return { text: JSON.stringify(payload), modelId: "test-model" };
}

let repo: string;

beforeEach(async () => {
  runSingleShotMock.mockReset();
  repo = await makeTempDir("sinscribe-commit-");
  await initRepo(repo);
});

afterEach(async () => {
  await removeDir(repo);
});

/** Stages an edit so the default (index-only) diff is non-empty. */
async function stageChange(content = "changed\n"): Promise<void> {
  await writeFile(path.join(repo, "file.txt"), content);
  await git(repo, "add", ".");
}

/** Leaves an unstaged edit, which only `--all` should see. */
async function unstagedChange(content = "unstaged\n"): Promise<void> {
  await writeFile(path.join(repo, "file.txt"), content);
}

describe("runCommit", () => {
  it("assembles a gitmoji, type, scope and subject into a header", async () => {
    await stageChange();
    runSingleShotMock.mockResolvedValue(
      modelReply({ type: "feat", scope: "api", subject: "add retry logic" }),
    );

    await expect(runCommit(makeSpec(), FLAGS, repo)).resolves.toBe(
      "✨ feat(api): add retry logic",
    );
  });

  it("omits the gitmoji prefix when --no-gitmoji is passed", async () => {
    await stageChange();
    runSingleShotMock.mockResolvedValue(
      modelReply({ type: "fix", scope: "api", subject: "handle empty files" }),
    );

    await expect(
      runCommit(makeSpec({ gitmoji: false }), FLAGS, repo),
    ).resolves.toBe("fix(api): handle empty files");
  });

  it("omits the scope entirely when neither flag nor model supplies one", async () => {
    await stageChange();
    runSingleShotMock.mockResolvedValue(
      modelReply({ type: "docs", subject: "update the readme" }),
    );

    await expect(runCommit(makeSpec(), FLAGS, repo)).resolves.toBe(
      "📝 docs: update the readme",
    );
  });

  it("lets --scope override the scope the model chose", async () => {
    await stageChange();
    runSingleShotMock.mockResolvedValue(
      modelReply({ type: "feat", scope: "ignored", subject: "add a flag" }),
    );

    await expect(
      runCommit(makeSpec({ scope: "cli" }), FLAGS, repo),
    ).resolves.toBe("✨ feat(cli): add a flag");
  });

  it("trims a padded model scope rather than rendering the padding", async () => {
    await stageChange();
    runSingleShotMock.mockResolvedValue(
      modelReply({ type: "feat", scope: "  api  ", subject: "add a flag" }),
    );

    await expect(runCommit(makeSpec(), FLAGS, repo)).resolves.toBe(
      "✨ feat(api): add a flag",
    );
  });

  it("treats a blank model scope as no scope", async () => {
    await stageChange();
    runSingleShotMock.mockResolvedValue(
      modelReply({ type: "feat", scope: "   ", subject: "add a flag" }),
    );

    await expect(runCommit(makeSpec(), FLAGS, repo)).resolves.toBe(
      "✨ feat: add a flag",
    );
  });

  it("falls back to chore when the model returns a type outside the vocabulary", async () => {
    await stageChange();
    runSingleShotMock.mockResolvedValue(
      modelReply({ type: "improvement", subject: "tidy things up" }),
    );

    await expect(runCommit(makeSpec(), FLAGS, repo)).resolves.toBe(
      "🔧 chore: tidy things up",
    );
  });

  it("falls back to chore when the model omits the type", async () => {
    await stageChange();
    runSingleShotMock.mockResolvedValue(modelReply({ subject: "tidy up" }));

    await expect(runCommit(makeSpec(), FLAGS, repo)).resolves.toBe(
      "🔧 chore: tidy up",
    );
  });

  it("separates the body from the header with a blank line", async () => {
    await stageChange();
    runSingleShotMock.mockResolvedValue(
      modelReply({
        type: "feat",
        subject: "add retry logic",
        body: "Retries three times with backoff.",
      }),
    );

    await expect(runCommit(makeSpec(), FLAGS, repo)).resolves.toBe(
      "✨ feat: add retry logic\n\nRetries three times with backoff.",
    );
  });

  it("marks a breaking change with ! and appends the footer", async () => {
    await stageChange();
    runSingleShotMock.mockResolvedValue(
      modelReply({
        type: "feat",
        scope: "api",
        subject: "drop v1 uploads",
        breaking: "v1 upload endpoints are removed.",
      }),
    );

    await expect(runCommit(makeSpec(), FLAGS, repo)).resolves.toBe(
      "✨ feat(api)!: drop v1 uploads\n\nBREAKING CHANGE: v1 upload endpoints are removed.",
    );
  });

  it("orders body before the breaking-change footer", async () => {
    await stageChange();
    runSingleShotMock.mockResolvedValue(
      modelReply({
        type: "feat",
        subject: "drop v1",
        body: "Why this had to happen.",
        breaking: "v1 is gone.",
      }),
    );

    await expect(runCommit(makeSpec(), FLAGS, repo)).resolves.toBe(
      "✨ feat!: drop v1\n\nWhy this had to happen.\n\nBREAKING CHANGE: v1 is gone.",
    );
  });

  it("ignores non-string body and breaking values instead of rendering them", async () => {
    await stageChange();
    runSingleShotMock.mockResolvedValue(
      modelReply({
        type: "feat",
        subject: "add a flag",
        body: 42,
        breaking: [],
      }),
    );

    await expect(runCommit(makeSpec(), FLAGS, repo)).resolves.toBe(
      "✨ feat: add a flag",
    );
  });

  it("rejects a reply whose subject is missing, and shows the raw output", async () => {
    await stageChange();
    runSingleShotMock.mockResolvedValue(modelReply({ type: "feat" }));

    await expect(runCommit(makeSpec(), FLAGS, repo)).rejects.toThrow(CliError);
    await expect(runCommit(makeSpec(), FLAGS, repo)).rejects.toThrow(
      /Model did not produce a commit subject/u,
    );
  });

  it("rejects a reply whose subject is only whitespace", async () => {
    await stageChange();
    runSingleShotMock.mockResolvedValue(
      modelReply({ type: "feat", subject: "   " }),
    );

    await expect(runCommit(makeSpec(), FLAGS, repo)).rejects.toThrow(CliError);
  });

  it("rejects output that is not JSON at all", async () => {
    await stageChange();
    runSingleShotMock.mockResolvedValue({
      text: "I could not do that.",
      modelId: "test-model",
    });

    await expect(runCommit(makeSpec(), FLAGS, repo)).rejects.toThrow();
  });

  it("propagates a model failure rather than inventing a message", async () => {
    await stageChange();
    runSingleShotMock.mockRejectedValue(new Error("network down"));

    await expect(runCommit(makeSpec(), FLAGS, repo)).rejects.toThrow(
      "network down",
    );
  });

  it("sends the required scope to the model when --scope is set", async () => {
    await stageChange();
    runSingleShotMock.mockResolvedValue(
      modelReply({ type: "feat", subject: "add a flag" }),
    );

    await runCommit(makeSpec({ scope: "cli" }), FLAGS, repo);

    const [, userPrompt] = runSingleShotMock.mock.calls[0] as [string, string];

    expect(userPrompt).toContain("Required scope: cli");
  });

  it("sends the staged diff to the model", async () => {
    await stageChange("retry logic here\n");
    runSingleShotMock.mockResolvedValue(
      modelReply({ type: "feat", subject: "add a flag" }),
    );

    await runCommit(makeSpec(), FLAGS, repo);

    const [, userPrompt] = runSingleShotMock.mock.calls[0] as [string, string];

    expect(userPrompt).toContain("Changed files:");
    expect(userPrompt).toContain("retry logic here");
  });

  it("refuses to run when nothing is staged", async () => {
    runSingleShotMock.mockResolvedValue(
      modelReply({ type: "feat", subject: "unused" }),
    );

    await expect(runCommit(makeSpec(), FLAGS, repo)).rejects.toThrow(
      /Nothing staged/u,
    );
    expect(runSingleShotMock).not.toHaveBeenCalled();
  });

  it("refuses to run when --all finds no tracked changes", async () => {
    runSingleShotMock.mockResolvedValue(
      modelReply({ type: "feat", subject: "unused" }),
    );

    await expect(
      runCommit(makeSpec({ all: true }), FLAGS, repo),
    ).rejects.toThrow(/No tracked changes found/u);
    expect(runSingleShotMock).not.toHaveBeenCalled();
  });

  it("sees an unstaged edit only with --all", async () => {
    await unstagedChange("only in the worktree\n");
    runSingleShotMock.mockResolvedValue(
      modelReply({ type: "feat", subject: "add a flag" }),
    );

    await expect(runCommit(makeSpec(), FLAGS, repo)).rejects.toThrow(
      /Nothing staged/u,
    );

    await expect(runCommit(makeSpec({ all: true }), FLAGS, repo)).resolves.toBe(
      "✨ feat: add a flag",
    );
  });

  it("fails cleanly outside a git repository", async () => {
    const plain = await makeTempDir("sinscribe-not-a-repo-");

    try {
      await expect(runCommit(makeSpec(), FLAGS, plain)).rejects.toThrow(
        NotAGitRepositoryError,
      );
    } finally {
      await removeDir(plain);
    }
  });
});

describe("dryRunCommit", () => {
  it("reports the source, the staged files and a skeleton without calling the model", async () => {
    await stageChange();

    const output = await dryRunCommit(makeSpec(), repo);

    expect(output).toContain("no LLM call, no credentials read");
    expect(output).toContain("Source:    staged changes");
    expect(output).toContain("file.txt");
    expect(output).toContain("<gitmoji> <type>(<scope>): <subject>");
    expect(runSingleShotMock).not.toHaveBeenCalled();
  });

  it("names --all as the source when the whole worktree is used", async () => {
    await unstagedChange();

    const output = await dryRunCommit(makeSpec({ all: true }), repo);

    expect(output).toContain("Source:    all tracked changes (--all)");
  });

  it("pins the scope in the skeleton when --scope is set", async () => {
    await stageChange();

    const output = await dryRunCommit(makeSpec({ scope: "cli" }), repo);

    expect(output).toContain("<gitmoji> <type>(cli): <subject>");
  });

  it("drops the gitmoji placeholder from the skeleton with --no-gitmoji", async () => {
    await stageChange();

    const output = await dryRunCommit(makeSpec({ gitmoji: false }), repo);

    expect(output).toContain("<type>(<scope>): <subject>");
    expect(output).not.toContain("<gitmoji>");
  });

  it("refuses a dry run when there is nothing to describe", async () => {
    await expect(dryRunCommit(makeSpec(), repo)).rejects.toThrow(
      /Nothing staged/u,
    );
  });
});

describe("GITMOJI_BY_TYPE", () => {
  it("maps every Conventional Commit type this CLI emits", () => {
    expect(Object.keys(GITMOJI_BY_TYPE)).toEqual([
      "feat",
      "fix",
      "docs",
      "style",
      "refactor",
      "perf",
      "test",
      "build",
      "ci",
      "chore",
      "revert",
    ]);
  });
});
