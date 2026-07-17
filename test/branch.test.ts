import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandSpec, GlobalFlags } from "../src/commands.js";
import {
  dryRunBranch,
  generateBranchSuggestions,
  runBranch,
} from "../src/domain/branch.js";
import { CliError } from "../src/domain/errors.js";
import type { RunEvent } from "../src/llm/events.js";
import { saveProjectRules } from "../src/domain/rules.js";
import { saveSession, type SessionContext } from "../src/session/store.js";
import { git, initRepo, makeTempDir, removeDir } from "./git-fixture.js";

const runSingleShotMock = vi.hoisted(() => vi.fn());

vi.mock("../src/llm/single-shot.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../src/llm/single-shot.js")>();

  return { ...original, runSingleShot: runSingleShotMock };
});

type BranchSpec = Extract<CommandSpec, { name: "branch" }>;

const FLAGS: GlobalFlags = {
  dryRun: false,
  print: false,
  modelId: null,
  provider: null,
  apiKey: null,
};

function makeSpec(overrides: Partial<BranchSpec> = {}): BranchSpec {
  return { name: "branch", input: "add retry logic", type: null, ...overrides };
}

function modelReply(payload: unknown): { text: string; modelId: string } {
  return { text: JSON.stringify(payload), modelId: "test-model" };
}

const CONTEXT: SessionContext = {
  feature: "Add retry logic to the uploader",
  ticket: "ABC-123",
  requirements: "Keep backwards compatibility with v1 uploads",
  baseRef: "main",
};

beforeEach(() => {
  runSingleShotMock.mockReset();
});

describe("generateBranchSuggestions", () => {
  it("returns structured suggestions from the model reply", async () => {
    runSingleShotMock.mockResolvedValue(
      modelReply({
        type: "feat",
        slugs: ["add-retry-logic", "uploader-retries", "retry-uploads"],
      }),
    );

    const result = await generateBranchSuggestions(makeSpec(), FLAGS);

    expect(result.source).toBe("llm");
    expect(result.type).toBe("feat");
    expect(result.ticket).toBeNull();
    expect(result.names).toEqual([
      "feat/add-retry-logic",
      "feat/uploader-retries",
      "feat/retry-uploads",
    ]);
  });

  it("deduplicates and caps the names at three", async () => {
    runSingleShotMock.mockResolvedValue(
      modelReply({
        type: "fix",
        slugs: ["a", "a", "b", "c", "d"],
      }),
    );

    const result = await generateBranchSuggestions(
      makeSpec({ input: "fix the crash" }),
      FLAGS,
    );

    expect(result.names).toEqual(["fix/a", "fix/b", "fix/c"]);
  });

  it("prefers the --type flag over the model's type", async () => {
    runSingleShotMock.mockResolvedValue(
      modelReply({ type: "feat", slugs: ["tidy-up"] }),
    );

    const result = await generateBranchSuggestions(
      makeSpec({ type: "chore" }),
      FLAGS,
    );

    expect(result.names).toEqual(["chore/tidy-up"]);
  });

  it("falls back to the deterministic name when no slug survives", async () => {
    runSingleShotMock.mockResolvedValue(
      modelReply({ type: "feat", slugs: [] }),
    );

    const result = await generateBranchSuggestions(makeSpec(), FLAGS);

    expect(result.source).toBe("deterministic");
    expect(result.names).toHaveLength(1);
  });

  it("answers a pure ticket input deterministically without the model", async () => {
    const result = await generateBranchSuggestions(
      makeSpec({ input: "ABC-123" }),
      FLAGS,
    );

    expect(result.source).toBe("deterministic");
    expect(result.ticket).toBe("ABC-123");
    expect(runSingleShotMock).not.toHaveBeenCalled();
  });

  it("throws without a ticket, a description, or a session context", async () => {
    await expect(
      generateBranchSuggestions(makeSpec({ input: "  " }), FLAGS),
    ).rejects.toThrow(CliError);
  });

  it("fills ticket and description from the session context", async () => {
    runSingleShotMock.mockResolvedValue(
      modelReply({ type: "feat", slugs: ["retry-uploader"] }),
    );

    const result = await generateBranchSuggestions(
      makeSpec({ input: "" }),
      {
        ...FLAGS,
      },
      { sessionContext: CONTEXT },
    );

    expect(result.ticket).toBe("ABC-123");
    expect(result.names).toEqual(["feat/ABC-123-retry-uploader"]);

    const [, userPrompt] = runSingleShotMock.mock.calls[0] as [string, string];

    expect(userPrompt).toContain("Ticket: ABC-123");
    expect(userPrompt).toContain(`Task: ${CONTEXT.feature}`);
    expect(userPrompt).toContain("Business context (provided by the author):");
    expect(userPrompt).toContain(`Feature: ${CONTEXT.feature}`);
    expect(userPrompt).toContain(`Requirements: ${CONTEXT.requirements}`);
  });

  it("retries once on invalid JSON, emitting a status event", async () => {
    runSingleShotMock
      .mockResolvedValueOnce({ text: "not json", modelId: "test-model" })
      .mockResolvedValueOnce(
        modelReply({ type: "feat", slugs: ["second-try"] }),
      );

    const events: RunEvent[] = [];
    const result = await generateBranchSuggestions(makeSpec(), FLAGS, {
      callbacks: {
        onEvent: (event) => {
          events.push(event);
        },
      },
    });

    expect(result.names).toEqual(["feat/second-try"]);
    expect(runSingleShotMock).toHaveBeenCalledTimes(2);
    expect(events.some((event) => event.type === "status")).toBe(true);

    const [, retryPrompt] = runSingleShotMock.mock.calls[1] as [string, string];

    expect(retryPrompt).toContain("was not valid JSON");
  });

  it("falls back to the deterministic name when both replies are invalid", async () => {
    runSingleShotMock.mockResolvedValue({
      text: "still not json",
      modelId: "test-model",
    });

    const result = await generateBranchSuggestions(makeSpec(), FLAGS);

    expect(result.source).toBe("deterministic");
    expect(runSingleShotMock).toHaveBeenCalledTimes(2);
  });

  it("returns whole names in the requested format when preferences are given", async () => {
    runSingleShotMock.mockResolvedValue(
      modelReply({
        names: [
          "feature/ABC-123-users-landing-page",
          "feature/ABC-123-landing-page",
          "feature/ABC-123-users-page",
        ],
      }),
    );

    const result = await generateBranchSuggestions(
      makeSpec({ input: "" }),
      FLAGS,
      {
        sessionContext: CONTEXT,
        preferences: "feature/[ticket]-[short-description]",
      },
    );

    expect(result.source).toBe("llm");
    expect(result.names).toEqual([
      "feature/ABC-123-users-landing-page",
      "feature/ABC-123-landing-page",
      "feature/ABC-123-users-page",
    ]);

    const [systemPrompt, userPrompt] = runSingleShotMock.mock.calls[0] as [
      string,
      string,
    ];

    expect(systemPrompt).toContain('"names"');
    expect(systemPrompt).not.toContain('"slugs"');
    expect(userPrompt).toContain(
      "Formatting preferences (provided by the author):",
    );
    expect(userPrompt).toContain("feature/[ticket]-[short-description]");
    expect(userPrompt).toContain("Ticket: ABC-123");
    expect(userPrompt).toContain(`Task: ${CONTEXT.feature}`);
  });

  it("sanitizes, deduplicates, and caps names from a preferences run", async () => {
    runSingleShotMock.mockResolvedValue(
      modelReply({
        names: [
          "feature/ABC-123 users page!",
          "feature/ABC-123-users-page",
          "/hotfix/ABC-123-thing/",
          "release/ABC-123-x",
        ],
      }),
    );

    const result = await generateBranchSuggestions(
      makeSpec({ input: "" }),
      FLAGS,
      { sessionContext: CONTEXT, preferences: "anything" },
    );

    expect(result.names).toEqual([
      "feature/ABC-123-users-page",
      "hotfix/ABC-123-thing",
      "release/ABC-123-x",
    ]);
  });

  it("falls back to the default deterministic name when no preference name survives", async () => {
    runSingleShotMock.mockResolvedValue(
      modelReply({ names: ["", "///", "  "] }),
    );

    const result = await generateBranchSuggestions(
      makeSpec({ input: "" }),
      FLAGS,
      { sessionContext: CONTEXT, preferences: "feature/[ticket]" },
    );

    expect(result.source).toBe("deterministic");
    expect(result.names).toHaveLength(1);
    expect(result.names[0]).toMatch(/^feat\/ABC-123-/u);
  });
});

describe("runBranch", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await makeTempDir("sinscribe-branch-run-");
    await initRepo(repo);
  });

  afterEach(async () => {
    await removeDir(repo);
  });

  it("loads the current branch's session context into the prompt", async () => {
    await git(repo, "checkout", "-b", "feature/retry");

    const now = new Date().toISOString();

    await saveSession(repo, {
      version: 1,
      branch: "feature/retry",
      context: CONTEXT,
      pr: null,
      createdAt: now,
      updatedAt: now,
    });

    runSingleShotMock.mockResolvedValue(
      modelReply({ type: "feat", slugs: ["one", "two"] }),
    );

    const output = await runBranch(makeSpec(), FLAGS, repo);

    expect(output).toBe("feat/ABC-123-one\nfeat/ABC-123-two");

    const [, userPrompt] = runSingleShotMock.mock.calls[0] as [string, string];

    expect(userPrompt).toContain("Business context (provided by the author):");
  });

  it("omits the business context block without a saved session", async () => {
    runSingleShotMock.mockResolvedValue(
      modelReply({ type: "feat", slugs: ["one"] }),
    );

    const output = await runBranch(makeSpec(), FLAGS, repo);

    expect(output).toBe("feat/one");

    const [, userPrompt] = runSingleShotMock.mock.calls[0] as [string, string];

    expect(userPrompt).not.toContain("Business context");
  });

  it("loads project rules into the system prompt", async () => {
    await saveProjectRules(repo, "always use type feat for uploader work");
    runSingleShotMock.mockResolvedValue(
      modelReply({ type: "feat", slugs: ["one"] }),
    );

    await runBranch(makeSpec(), FLAGS, repo);

    const [systemPrompt] = runSingleShotMock.mock.calls[0] as [string, string];

    expect(systemPrompt).toContain("always use type feat for uploader work");
  });
});

describe("dryRunBranch", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await makeTempDir("sinscribe-branch-dry-");
    await initRepo(repo);
  });

  afterEach(async () => {
    await removeDir(repo);
  });

  it("previews the raw input without a saved session", async () => {
    const output = await dryRunBranch(makeSpec({ input: "ABC-123" }), repo);

    expect(output).toContain("Ticket:      ABC-123");
    expect(output).toContain("Description: (none)");
    expect(output).not.toContain("(from session context)");
    expect(runSingleShotMock).not.toHaveBeenCalled();
  });

  it("resolves the session context the real run would use", async () => {
    await git(repo, "checkout", "-b", "feature/retry");

    const now = new Date().toISOString();

    await saveSession(repo, {
      version: 1,
      branch: "feature/retry",
      context: CONTEXT,
      pr: null,
      createdAt: now,
      updatedAt: now,
    });

    const output = await dryRunBranch(makeSpec({ input: "ABC-123" }), repo);

    expect(output).toContain("Ticket:      ABC-123");
    expect(output).toContain(
      `Description: ${CONTEXT.feature} (from session context)`,
    );
    // The suggestion is built from the resolved description, not "work".
    expect(output).not.toContain("feat/ABC-123-work");
    expect(runSingleShotMock).not.toHaveBeenCalled();
  });
});
