import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GlobalFlags } from "../src/commands.js";
import { createHandoffRun, type HandoffInput } from "../src/domain/handoff.js";
import { getHandoffPath } from "../src/domain/handoff-export.js";
import { makeTempDir, removeDir } from "./git-fixture.js";

const runSingleShotMock = vi.hoisted(() => vi.fn());

vi.mock("../src/llm/single-shot.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../src/llm/single-shot.js")>();

  return { ...original, runSingleShot: runSingleShotMock };
});

const FLAGS: GlobalFlags = {
  dryRun: false,
  print: false,
  modelId: null,
  provider: null,
  apiKey: null,
};

const DRAFT = [
  "## Where things stand",
  "- Retry logic is designed but not written.",
  "",
  "## Open questions",
  "- Should the backoff be capped?",
].join("\n");

let repo: string;

function makeInput(overrides: Partial<HandoffInput> = {}): HandoffInput {
  return {
    repoRoot: repo,
    branch: "feature/login",
    ticket: "ABC-123",
    baseRef: "main",
    sessionContext: {
      feature: "Login retry epic",
      ticket: "ABC-123",
      requirements: "Keep v1 compatibility",
      baseRef: null,
    },
    log: "abc123 add uploader",
    changedFiles: "M\tsrc/uploader.ts",
    agentPrompt: "# Implement retries\n\n## Objective\n\nRetry uploads.",
    previousHandoff: null,
    rules: null,
    ...overrides,
  };
}

function modelReply(text: string): { text: string; modelId: string } {
  return { text, modelId: "test-model" };
}

beforeEach(async () => {
  runSingleShotMock.mockReset();
  repo = await makeTempDir("sinscribe-handoff-run-");
});

afterEach(async () => {
  await removeDir(repo);
});

describe("createHandoffRun", () => {
  it("sends the gathered context and the approved prompt to the model", async () => {
    runSingleShotMock.mockResolvedValue(modelReply(DRAFT));

    const run = createHandoffRun(makeInput(), FLAGS);

    expect(await run.generate(null)).toBe(DRAFT);

    const [systemPrompt, userPrompt] = runSingleShotMock.mock.calls[0] as [
      string,
      string,
    ];

    expect(systemPrompt).toContain("## Where things stand");
    expect(systemPrompt).toContain("## Known issues / blockers");
    expect(userPrompt).toContain("Repository branch: feature/login");
    expect(userPrompt).toContain("Login retry epic");
    expect(userPrompt).toContain("M\tsrc/uploader.ts");
    expect(userPrompt).toContain("a plan, not a result");
    expect(userPrompt).toContain("# Implement retries");
  });

  it("unwraps a fence-wrapped reply", async () => {
    runSingleShotMock.mockResolvedValue(
      modelReply(`\`\`\`markdown\n${DRAFT}\n\`\`\``),
    );

    expect(await createHandoffRun(makeInput(), FLAGS).generate(null)).toBe(
      DRAFT,
    );
  });

  it("rejects an empty model reply", async () => {
    runSingleShotMock.mockResolvedValue(modelReply("   "));

    await expect(
      createHandoffRun(makeInput(), FLAGS).generate(null),
    ).rejects.toThrow(/produced no output/);
  });

  it("asks for an update when a handoff already exists on this branch", async () => {
    runSingleShotMock.mockResolvedValue(modelReply(DRAFT));

    await createHandoffRun(
      makeInput({
        previousHandoff: {
          branch: "feature/login",
          body: "## Where things stand\n- Old.",
        },
      }),
      FLAGS,
    ).generate(null);

    const [systemPrompt, userPrompt] = runSingleShotMock.mock.calls[0] as [
      string,
      string,
    ];

    expect(systemPrompt).toContain("UPDATE it");
    expect(userPrompt).toContain(
      "Previous handoff for this branch (update it; do not start over):",
    );
    expect(userPrompt).toContain("- Old.");
  });

  it("labels a handoff written on a different branch as background", async () => {
    runSingleShotMock.mockResolvedValue(modelReply(DRAFT));

    await createHandoffRun(
      makeInput({
        previousHandoff: {
          branch: "main",
          body: "## Where things stand\n- Old.",
        },
      }),
      FLAGS,
    ).generate(null);

    const [, userPrompt] = runSingleShotMock.mock.calls[0] as [string, string];

    expect(userPrompt).toContain("written on branch main, not this one");
  });

  it("threads feedback and the previous draft into a refine call", async () => {
    runSingleShotMock
      .mockResolvedValueOnce(modelReply(DRAFT))
      .mockResolvedValueOnce(modelReply("## Where things stand\n- Tighter."));

    const run = createHandoffRun(makeInput(), FLAGS);

    await run.generate(null);
    await run.generate("The retry work has not started.");

    const [firstSystem] = runSingleShotMock.mock.calls[0] as [string, string];
    const [secondSystem, secondUser] = runSingleShotMock.mock.calls[1] as [
      string,
      string,
    ];

    expect(firstSystem).not.toContain("UPDATE it");
    expect(secondSystem).toContain("UPDATE it");
    expect(secondSystem).toContain("gave feedback");
    expect(secondUser).toContain("Your previous draft of this handoff");
    expect(secondUser).toContain("The retry work has not started.");
    expect(secondUser).toContain("- Retry logic is designed but not written.");
  });

  it("writes HANDOFF.md with the stamped shell around the draft", async () => {
    runSingleShotMock.mockResolvedValue(modelReply(DRAFT));

    const run = createHandoffRun(makeInput(), FLAGS);

    await run.generate(null);

    const written = await run.save();

    expect(written).toBe(getHandoffPath(repo));

    const contents = await readFile(written, "utf8");

    expect(contents).toContain(
      "<!-- Branch: feature/login · Ticket: ABC-123 -->",
    );
    expect(contents).toContain("— Session Handoff");
    expect(contents).toContain("## Last updated");
    expect(contents).toContain("- Should the backoff be capped?");
  });

  it("refuses to save before a successful generate", async () => {
    await expect(createHandoffRun(makeInput(), FLAGS).save()).rejects.toThrow(
      /before a successful generate/,
    );
  });
});
