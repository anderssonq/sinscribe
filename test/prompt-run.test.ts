import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandSpec, GlobalFlags } from "../src/commands.js";
import {
  createPromptRun,
  dryRunPrompt,
  inferPromptKind,
  runPrompt,
  stripMarkdownFence,
} from "../src/domain/prompt.js";
import { saveSession } from "../src/session/store.js";
import { git, initRepo, makeTempDir, removeDir } from "./git-fixture.js";

const runSingleShotMock = vi.hoisted(() => vi.fn());

vi.mock("../src/llm/single-shot.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../src/llm/single-shot.js")>();

  return { ...original, runSingleShot: runSingleShotMock };
});

type PromptSpec = Extract<CommandSpec, { name: "prompt" }>;

const FLAGS: GlobalFlags = {
  dryRun: false,
  print: false,
  modelId: null,
  provider: null,
  apiKey: null,
};

const DOC = "# Implement retries\n\n## Objective\n\nRetry failed uploads.";

function makeSpec(overrides: Partial<PromptSpec> = {}): PromptSpec {
  return {
    name: "prompt",
    type: "feature",
    description: "add retry logic to the uploader",
    out: null,
    ...overrides,
  };
}

function modelReply(text: string): { text: string; modelId: string } {
  return { text, modelId: "test-model" };
}

async function saveLoginContext(repo: string): Promise<void> {
  const now = new Date().toISOString();

  await saveSession(repo, {
    version: 1,
    branch: "feature/login",
    context: {
      feature: "Login retry epic",
      ticket: "ABC-123",
      requirements: "Keep v1 compatibility",
      baseRef: null,
    },
    pr: null,
    createdAt: now,
    updatedAt: now,
  });
}

let repo: string;

beforeEach(async () => {
  runSingleShotMock.mockReset();
  repo = await makeTempDir("sinscribe-prompt-run-");
  await initRepo(repo);
  // Fresh branch with zero changes vs main: the empty diff must not be fatal
  // (the prompt is written before the work starts — the inverse of pr).
  await git(repo, "checkout", "-b", "feature/login");
});

afterEach(async () => {
  await removeDir(repo);
});

describe("inferPromptKind", () => {
  it("detects bugfix keywords and defaults to feature", () => {
    expect(inferPromptKind("fix crash when saving")).toBe("bugfix");
    expect(inferPromptKind("uploads failing on retry")).toBe("bugfix");
    expect(inferPromptKind("add dark mode")).toBe("feature");
  });
});

describe("stripMarkdownFence", () => {
  it("unwraps one whole-document fence and leaves plain text alone", () => {
    expect(stripMarkdownFence(`\`\`\`markdown\n${DOC}\n\`\`\``)).toBe(DOC);
    expect(stripMarkdownFence(`\n${DOC}\n`)).toBe(DOC);
  });
});

describe("createPromptRun", () => {
  it("passes the model markdown through on a branch with an empty diff", async () => {
    runSingleShotMock.mockResolvedValue(modelReply(DOC));

    const run = await createPromptRun(makeSpec(), FLAGS, repo);
    const content = await run.generate(null);

    expect(content).toBe(DOC);
    expect(run.meta.kind).toBe("feature");
    expect(run.meta.baseRef).toBe("main");

    const [systemPrompt, userPrompt] = runSingleShotMock.mock.calls[0] as [
      string,
      string,
    ];

    expect(systemPrompt).toContain("## Objective");
    expect(userPrompt).toContain("Recent commits on this branch:");
    expect(userPrompt).toContain("(none yet)");
    expect(userPrompt).not.toContain("Files changed so far");
  });

  it("unwraps a fence-wrapped model reply", async () => {
    runSingleShotMock.mockResolvedValue(
      modelReply(`\`\`\`markdown\n${DOC}\n\`\`\``),
    );

    const run = await createPromptRun(makeSpec(), FLAGS, repo);

    expect(await run.generate(null)).toBe(DOC);
  });

  it("threads the saved session context into the user prompt", async () => {
    await saveLoginContext(repo);
    runSingleShotMock.mockResolvedValue(modelReply(DOC));

    const run = await createPromptRun(makeSpec(), FLAGS, repo);

    await run.generate(null);

    const [, userPrompt] = runSingleShotMock.mock.calls[0] as [string, string];

    expect(run.meta.ticket).toBe("ABC-123");
    expect(userPrompt).toContain("Business context");
    expect(userPrompt).toContain("Login retry epic");
    expect(userPrompt).toContain("Keep v1 compatibility");
  });

  it("threads feedback and the previous candidate into the refine prompt", async () => {
    runSingleShotMock
      .mockResolvedValueOnce(modelReply("First draft."))
      .mockResolvedValueOnce(modelReply("Tighter draft."));

    const run = await createPromptRun(makeSpec(), FLAGS, repo);
    const first = await run.generate(null);
    const second = await run.generate("Tighten the scope.");

    expect(second).toBe("Tighter draft.");
    expect(runSingleShotMock).toHaveBeenCalledTimes(2);

    const [firstSystem, firstUser] = runSingleShotMock.mock.calls[0] as [
      string,
      string,
    ];
    const [secondSystem, secondUser] = runSingleShotMock.mock.calls[1] as [
      string,
      string,
    ];

    expect(firstSystem).not.toContain("previously generated prompt");
    expect(firstUser).not.toContain("Developer feedback");

    expect(secondSystem).toContain("previously generated prompt");
    expect(secondSystem).toContain("gave feedback");
    expect(secondUser).toContain(
      "Developer feedback on the previous prompt (apply all of it):",
    );
    expect(secondUser).toContain("Tighten the scope.");
    expect(secondUser).toContain(first);
  });

  it("falls back to the saved session context when no description is given", async () => {
    await saveLoginContext(repo);
    runSingleShotMock.mockResolvedValue(modelReply(DOC));

    const run = await createPromptRun(
      makeSpec({ type: null, description: null }),
      FLAGS,
      repo,
    );

    expect(run.meta.description).toContain("Login retry epic");
    expect(run.meta.description).toContain("Keep v1 compatibility");
  });

  it("rejects when neither a description nor a session context exists", async () => {
    await expect(
      createPromptRun(makeSpec({ description: null }), FLAGS, repo),
    ).rejects.toThrow(/prompt requires a description/);
    expect(runSingleShotMock).not.toHaveBeenCalled();
  });

  it("infers the kind from the description unless --type overrides it", async () => {
    runSingleShotMock.mockResolvedValue(modelReply(DOC));

    const inferred = await createPromptRun(
      makeSpec({ type: null, description: "fix crash when saving" }),
      FLAGS,
      repo,
    );

    expect(inferred.meta.kind).toBe("bugfix");

    const overridden = await createPromptRun(
      makeSpec({ type: "feature", description: "fix crash when saving" }),
      FLAGS,
      repo,
    );

    expect(overridden.meta.kind).toBe("feature");
  });
});

describe("runPrompt (non-interactive parity)", () => {
  it("generates once and returns the markdown", async () => {
    runSingleShotMock.mockResolvedValue(modelReply(DOC));

    expect(await runPrompt(makeSpec(), FLAGS, repo)).toBe(DOC);
    expect(runSingleShotMock).toHaveBeenCalledTimes(1);
  });

  it("writes --out and returns the confirmation string", async () => {
    runSingleShotMock.mockResolvedValue(modelReply(DOC));

    const outPath = path.join(repo, "task-prompt.md");
    const result = await runPrompt(makeSpec({ out: outPath }), FLAGS, repo);

    expect(result).toBe(`Wrote agent prompt to ${outPath}`);
    expect(await readFile(outPath, "utf8")).toBe(`${DOC}\n`);
  });
});

describe("dryRunPrompt", () => {
  it("prints the deterministic scaffold without any model call", async () => {
    const scaffold = await dryRunPrompt(
      makeSpec({ type: null, description: "fix crash when saving" }),
      repo,
    );

    expect(scaffold).toContain("no LLM call, no credentials read");
    expect(scaffold).toContain(
      "Type:        bugfix (inferred from the description)",
    );
    expect(scaffold).toContain("Branch:      feature/login");
    expect(scaffold).toContain("## Symptom");
    expect(scaffold).toContain("## Verification");
    expect(runSingleShotMock).not.toHaveBeenCalled();
  });
});
