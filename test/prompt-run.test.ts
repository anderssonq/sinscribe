import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandSpec, GlobalFlags } from "../src/commands.js";
import {
  createPromptRun,
  dryRunPrompt,
  inferPromptKind,
  runPrompt,
} from "../src/domain/prompt.js";
import {
  buildHandoffMarkdown,
  getHandoffPath,
  loadHandoff,
} from "../src/domain/handoff-export.js";
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
    handoff: false,
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

async function writeHandoff(repoRoot: string, branch: string): Promise<void> {
  await writeFile(
    getHandoffPath(repoRoot),
    buildHandoffMarkdown({
      projectName: "fixture",
      branch,
      ticket: null,
      body: "## Where things stand\n- Backoff is still unbounded.",
    }),
    "utf8",
  );
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

  it("ignores incidental failure words in the requirements body", () => {
    const feature = [
      "Add configurable retry with exponential backoff to the uploader",
      "",
      "Requirements:",
      "Retry only transient failures: network errors and HTTP 5xx responses.",
      "Log the attempt number and the HTTP status (or error) per attempt.",
    ].join("\n");

    expect(inferPromptKind(feature)).toBe("feature");
  });

  it("still catches a bug stated only below a neutral title line", () => {
    const buried = [
      "Harden the uploader",
      "",
      "Requirements:",
      "It currently crashes on empty files; fix the crash and add a regression test.",
    ].join("\n");

    expect(inferPromptKind(buried)).toBe("bugfix");
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
    expect(userPrompt).toContain(
      "Commits already on this branch (background, not the task):",
    );
    expect(userPrompt).toContain("(none yet)");
    expect(userPrompt).not.toContain("Files already changed");
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

describe("HANDOFF.md as context", () => {
  it("threads an existing handoff into the user prompt", async () => {
    await writeHandoff(repo, "feature/login");
    runSingleShotMock.mockResolvedValue(modelReply(DOC));

    const run = await createPromptRun(makeSpec(), FLAGS, repo);

    await run.generate(null);

    const [, userPrompt] = runSingleShotMock.mock.calls[0] as [string, string];

    expect(userPrompt).toContain(
      "Session handoff from HANDOFF.md (state carried over from earlier sessions on this branch):",
    );
    expect(userPrompt).toContain("- Backoff is still unbounded.");
  });

  it("labels a handoff written on another branch instead of dropping it", async () => {
    await writeHandoff(repo, "feature/other");
    runSingleShotMock.mockResolvedValue(modelReply(DOC));

    const run = await createPromptRun(makeSpec(), FLAGS, repo);

    await run.generate(null);

    const [, userPrompt] = runSingleShotMock.mock.calls[0] as [string, string];

    expect(userPrompt).toContain(
      "written on branch feature/other, not this one",
    );
    expect(userPrompt).toContain("- Backoff is still unbounded.");
  });

  it("says nothing about a handoff when the file does not exist", async () => {
    runSingleShotMock.mockResolvedValue(modelReply(DOC));

    const run = await createPromptRun(makeSpec(), FLAGS, repo);

    await run.generate(null);

    const [, userPrompt] = runSingleShotMock.mock.calls[0] as [string, string];

    expect(userPrompt).not.toContain("Session handoff");
  });

  it("hands the gathered context to the handoff run", async () => {
    await saveLoginContext(repo);
    await writeHandoff(repo, "feature/login");
    runSingleShotMock.mockResolvedValue(modelReply(DOC));

    const run = await createPromptRun(makeSpec(), FLAGS, repo);

    await run.generate(null);

    const handoffInput = run.buildHandoffInput(DOC);

    expect(handoffInput?.repoRoot).toBe(run.meta.repoRoot);
    expect(handoffInput?.branch).toBe("feature/login");
    expect(handoffInput?.ticket).toBe("ABC-123");
    expect(handoffInput?.agentPrompt).toBe(DOC);
    expect(handoffInput?.sessionContext?.feature).toBe("Login retry epic");
    expect(handoffInput?.previousHandoff?.branch).toBe("feature/login");
  });
});

describe("runPrompt (non-interactive parity)", () => {
  it("generates once and returns the markdown", async () => {
    runSingleShotMock.mockResolvedValue(modelReply(DOC));

    expect(await runPrompt(makeSpec(), FLAGS, repo)).toBe(DOC);
    expect(runSingleShotMock).toHaveBeenCalledTimes(1);
  });

  it("leaves HANDOFF.md alone without --handoff", async () => {
    runSingleShotMock.mockResolvedValue(modelReply(DOC));

    await runPrompt(makeSpec(), FLAGS, repo);

    expect(await loadHandoff(repo)).toBeNull();
    expect(runSingleShotMock).toHaveBeenCalledTimes(1);
  });

  it("--handoff writes the file with a second model call", async () => {
    runSingleShotMock
      .mockResolvedValueOnce(modelReply(DOC))
      .mockResolvedValueOnce(
        modelReply("## Where things stand\n- Retries are designed, not built."),
      );

    const result = await runPrompt(makeSpec({ handoff: true }), FLAGS, repo);

    expect(runSingleShotMock).toHaveBeenCalledTimes(2);
    expect(result).toContain(DOC);
    // Not the literal temp path: getRepoRoot resolves /var to /private/var.
    expect(result).toMatch(/^Saved .*HANDOFF\.md$/mu);

    const written = await loadHandoff(repo);

    expect(written?.branch).toBe("feature/login");
    expect(written?.body).toContain("- Retries are designed, not built.");
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

  it("reports whether a handoff would be read back in", async () => {
    expect(await dryRunPrompt(makeSpec(), repo)).toContain(
      "Handoff:     (no HANDOFF.md yet — offered after approval)",
    );

    await writeHandoff(repo, "feature/login");

    expect(await dryRunPrompt(makeSpec(), repo)).toContain(
      "Handoff:     HANDOFF.md (",
    );
    expect(await dryRunPrompt(makeSpec(), repo)).toContain(
      "branch feature/login) — update offered after approval",
    );

    await writeHandoff(repo, "feature/other");

    expect(await dryRunPrompt(makeSpec(), repo)).toContain(
      "labeled as another branch's",
    );
    expect(runSingleShotMock).not.toHaveBeenCalled();
  });

  it("says the handoff would be written when --handoff is passed", async () => {
    expect(await dryRunPrompt(makeSpec({ handoff: true }), repo)).toContain(
      "(no HANDOFF.md yet — one would be written)",
    );

    await writeHandoff(repo, "feature/login");

    expect(await dryRunPrompt(makeSpec({ handoff: true }), repo)).toContain(
      "— would be updated",
    );
    expect(runSingleShotMock).not.toHaveBeenCalled();
  });
});
