import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandSpec, GlobalFlags } from "../src/commands.js";
import { createPrRun, runPr } from "../src/domain/pr.js";
import { loadSession } from "../src/session/store.js";
import { git, initRepo, makeTempDir, removeDir } from "./git-fixture.js";

const runSingleShotMock = vi.hoisted(() => vi.fn());

vi.mock("../src/llm/single-shot.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../src/llm/single-shot.js")>();

  return { ...original, runSingleShot: runSingleShotMock };
});

type PrSpec = Extract<CommandSpec, { name: "pr" }>;

const FLAGS: GlobalFlags = {
  dryRun: false,
  print: false,
  modelId: null,
  provider: null,
  apiKey: null,
};

const TEMPLATE_MD = `---
name: sample
kind: pr
placeholders:
  branch: { type: string, required: true, from: git }
  summary: { type: markdown, required: true, from: llm }
---
# {{branch}}

{{summary}}
`;

function makeSpec(overrides: Partial<PrSpec> = {}): PrSpec {
  return {
    name: "pr",
    template: "sample",
    base: null,
    ticket: null,
    staged: false,
    out: null,
    ...overrides,
  };
}

function modelReply(summary: string): { text: string; modelId: string } {
  return { text: JSON.stringify({ summary }), modelId: "test-model" };
}

let repo: string;

beforeEach(async () => {
  runSingleShotMock.mockReset();
  repo = await makeTempDir("sinscribe-pr-run-");
  await initRepo(repo);
  await git(repo, "checkout", "-b", "feature/login");
  await writeFile(path.join(repo, "file.txt"), "hello\nlogin\n");

  const templatesDir = path.join(repo, ".sinscribe", "templates");

  await mkdir(templatesDir, { recursive: true });
  await writeFile(path.join(templatesDir, "sample.md"), TEMPLATE_MD);
});

afterEach(async () => {
  await removeDir(repo);
});

describe("createPrRun", () => {
  it("saves the session on approve, not on generate", async () => {
    runSingleShotMock.mockResolvedValue(modelReply("Adds login."));

    const run = await createPrRun(makeSpec(), FLAGS, repo);
    const rendered = await run.generate(null);

    expect(rendered).toContain("# feature/login");
    expect(rendered).toContain("Adds login.");
    expect(await loadSession(repo, "feature/login")).toBeNull();

    const { sessionSaved, outPath } = await run.approve();

    expect(sessionSaved).toBe(true);
    expect(outPath).toBeNull();

    const session = await loadSession(repo, "feature/login");

    expect(session?.pr?.description).toBe(rendered);
    expect(session?.pr?.template).toBe("sample");
  });

  it("threads feedback and the previous candidate into the refine prompt", async () => {
    runSingleShotMock
      .mockResolvedValueOnce(modelReply("First draft."))
      .mockResolvedValueOnce(modelReply("Shorter draft."));

    const run = await createPrRun(makeSpec(), FLAGS, repo);
    const first = await run.generate(null);
    const second = await run.generate("Make it shorter.");

    expect(second).toContain("Shorter draft.");
    expect(runSingleShotMock).toHaveBeenCalledTimes(2);

    const [firstSystem, firstUser] = runSingleShotMock.mock.calls[0] as [
      string,
      string,
    ];
    const [secondSystem, secondUser] = runSingleShotMock.mock.calls[1] as [
      string,
      string,
    ];

    expect(firstSystem).not.toContain("previously generated PR description");
    expect(firstUser).not.toContain("Author feedback");

    expect(secondSystem).toContain("previously generated PR description");
    expect(secondSystem).toContain("gave feedback");
    expect(secondUser).toContain(
      "Author feedback on the previous description (apply all of it):",
    );
    expect(secondUser).toContain("Make it shorter.");
    expect(secondUser).toContain(first);
  });

  it("re-asks exactly once when the model returns invalid JSON", async () => {
    runSingleShotMock
      .mockResolvedValueOnce({ text: "not json at all", modelId: "test" })
      .mockResolvedValueOnce(modelReply("Recovered."));

    const run = await createPrRun(makeSpec(), FLAGS, repo);
    const rendered = await run.generate(null);

    expect(rendered).toContain("Recovered.");
    expect(runSingleShotMock).toHaveBeenCalledTimes(2);

    const [, retryUser] = runSingleShotMock.mock.calls[1] as [string, string];

    expect(retryUser).toContain("Your previous response was not valid JSON.");
  });

  it("fails with a friendly error when the re-ask is also unparseable", async () => {
    runSingleShotMock.mockResolvedValue({
      text: "still not json",
      modelId: "t",
    });

    const run = await createPrRun(makeSpec(), FLAGS, repo);

    await expect(run.generate(null)).rejects.toThrow(
      /did not return valid JSON/,
    );
    expect(runSingleShotMock).toHaveBeenCalledTimes(2);
  });
});

describe("runPr (non-interactive parity)", () => {
  it("generates once, saves the session, and returns the rendered text", async () => {
    runSingleShotMock.mockResolvedValue(modelReply("One-shot."));

    const result = await runPr(makeSpec(), FLAGS, repo);

    expect(result).toContain("One-shot.");
    expect(runSingleShotMock).toHaveBeenCalledTimes(1);
    expect((await loadSession(repo, "feature/login"))?.pr?.description).toBe(
      result,
    );
  });

  it("writes --out and returns the confirmation string", async () => {
    runSingleShotMock.mockResolvedValue(modelReply("File bound."));

    const outPath = path.join(repo, "pr.md");
    const result = await runPr(makeSpec({ out: outPath }), FLAGS, repo);

    expect(result).toBe(`Wrote PR description to ${outPath}`);
  });
});
