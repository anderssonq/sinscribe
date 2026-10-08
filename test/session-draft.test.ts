import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GlobalFlags } from "../src/commands.js";
import {
  buildDocsDigest,
  createSessionDraftRun,
  parseSessionDraftReply,
  toSessionContext,
  type SessionDraft,
} from "../src/domain/session-draft.js";
import { createSessionDraftSystemPrompt } from "../src/domain/prompts.js";
import { git, initRepo, makeTempDir, removeDir } from "./git-fixture.js";

const mocks = vi.hoisted(() => ({
  runExplore: vi.fn(),
  runSingleShot: vi.fn(),
}));

vi.mock("../src/llm/explore.js", () => ({ runExplore: mocks.runExplore }));
vi.mock("../src/llm/single-shot.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../src/llm/single-shot.js")>();

  return { ...original, runSingleShot: mocks.runSingleShot };
});

const FLAGS: GlobalFlags = {
  dryRun: false,
  print: false,
  modelId: null,
  provider: "claude-cli",
  apiKey: null,
};

const REPORT = [
  "# Uploader incident report",
  "",
  "Uploads drop on flaky networks; no retry exists today.",
].join("\n");

function reply(fields: Record<string, unknown>): string {
  return JSON.stringify({
    feature: "Retry uploads on flaky networks so files are not dropped.",
    requirements: "- Retry a failed upload up to 3 times",
    ticket: null,
    sources: [
      { path: "docs/uploader-report.md", why: "describes the incident" },
    ],
    openQuestions: ["Should large files be retried?"],
    ...fields,
  });
}

function explored(
  text: string,
  filesRead: string[] = ["docs/uploader-report.md"],
) {
  return {
    text,
    modelId: "m",
    mode: filesRead.length > 0 ? "claude-cli-readonly" : "single-shot",
    filesRead,
    fallbackReason:
      filesRead.length > 0 ? null : "reading the code was turned off",
  };
}

function shot(text: string) {
  return { text, modelId: "m" };
}

let repo: string;
let cwd: string;

beforeEach(async () => {
  cwd = process.cwd();
  repo = await makeTempDir("sinscribe-session-draft-");
  await initRepo(repo);
  await mkdir(path.join(repo, "docs"), { recursive: true });
  await writeFile(path.join(repo, "docs", "uploader-report.md"), REPORT);
  await writeFile(path.join(repo, "docs", "unrelated.md"), "# Theme colors\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-m", "docs: add reports");
  await git(repo, "checkout", "-b", "feat/ABC-123-uploader-retry");
  process.chdir(repo);
  mocks.runExplore.mockReset();
  mocks.runSingleShot.mockReset();
});

afterEach(async () => {
  process.chdir(cwd);
  await removeDir(repo);
});

describe("createSessionDraftRun", () => {
  it("summarises the evidence before any model call", async () => {
    const run = await createSessionDraftRun(FLAGS, repo, { previous: null });

    expect(run.meta).toMatchObject({
      branch: "feat/ABC-123-uploader-retry",
      ticket: "ABC-123",
      docs: 2,
      handoff: false,
      exploreKind: "claude-cli",
    });
    expect(mocks.runExplore).not.toHaveBeenCalled();
  });

  it("requires a direction on the first round", async () => {
    const run = await createSessionDraftRun(FLAGS, repo, { previous: null });

    await expect(
      run.generate({ feedback: null, explore: true, direction: "   " }),
    ).rejects.toThrow(/direction/u);
    await expect(
      run.generate({ feedback: null, explore: true }),
    ).rejects.toThrow(/direction/u);
  });

  it("explores read-only and returns a validated draft", async () => {
    mocks.runExplore.mockResolvedValue(explored(reply({})));

    const run = await createSessionDraftRun(FLAGS, repo, { previous: null });
    const draft = await run.generate({
      feedback: null,
      explore: true,
      direction: "retry uploads on flaky networks",
    });
    const [, userPrompt, options] = mocks.runExplore.mock.calls[0] as [
      string,
      string,
      { explore: boolean; repoRoot: string },
    ];

    expect(options.explore).toBe(true);
    expect(userPrompt).toContain("retry uploads on flaky networks");
    expect(userPrompt).toContain("docs/uploader-report.md");
    expect(draft).toMatchObject({
      ticket: "ABC-123",
      requirements: "- Retry a failed upload up to 3 times",
      sources: [
        { path: "docs/uploader-report.md", why: "describes the incident" },
      ],
      openQuestions: ["Should large files be retried?"],
      mode: "claude-cli-readonly",
      filesRead: ["docs/uploader-report.md"],
      baseRef: "main",
    });
  });

  it("keeps a short direction in the feature when the model drops it", async () => {
    mocks.runExplore.mockResolvedValue(
      explored(reply({ feature: "Make the uploader resilient." })),
    );

    const run = await createSessionDraftRun(FLAGS, repo, { previous: null });
    const draft = await run.generate({
      feedback: null,
      explore: true,
      direction: "retry uploads on flaky networks",
    });

    expect(draft.feature.startsWith("retry uploads on flaky networks")).toBe(
      true,
    );
  });

  it("drops sources that are not tracked files and tickets not in the evidence", async () => {
    await git(repo, "checkout", "-b", "feat/uploader-retry");
    mocks.runExplore.mockResolvedValue(
      explored(
        reply({
          ticket: "XYZ-999",
          sources: [
            { path: "docs/uploader-report.md", why: "incident" },
            { path: "./docs/uploader-report.md", why: "duplicate" },
            { path: "src/invented.ts", why: "does not exist" },
            { path: ".env", why: "secret" },
          ],
        }),
      ),
    );

    const run = await createSessionDraftRun(FLAGS, repo, { previous: null });
    const draft = await run.generate({
      feedback: null,
      explore: true,
      direction: "retry uploads",
    });

    expect(draft.ticket).toBeNull();
    expect(draft.sources).toEqual([
      { path: "docs/uploader-report.md", why: "incident" },
    ]);
  });

  it("accepts a model ticket that the author wrote in the direction", async () => {
    await git(repo, "checkout", "-b", "feat/uploader-retry");
    mocks.runExplore.mockResolvedValue(explored(reply({ ticket: "abc-777" })));

    const run = await createSessionDraftRun(FLAGS, repo, { previous: null });
    const draft = await run.generate({
      feedback: null,
      explore: true,
      direction: "ABC-777: retry uploads",
    });

    expect(draft.ticket).toBe("ABC-777");
  });

  it("refines with feedback single-shot, carrying the previous draft", async () => {
    mocks.runExplore.mockResolvedValue(explored(reply({})));
    mocks.runSingleShot.mockResolvedValue(
      shot(
        reply({
          requirements: "- Retry 3 times\n- Skip files over 2 GB",
          openQuestions: [],
        }),
      ),
    );

    const run = await createSessionDraftRun(FLAGS, repo, { previous: null });

    await run.generate({
      feedback: null,
      explore: true,
      direction: "retry uploads",
    });

    const draft = await run.generate({
      feedback: "Files over 2 GB are out of scope",
      explore: false,
    });
    const [systemPrompt, userPrompt] = mocks.runSingleShot.mock.calls[0] as [
      string,
      string,
    ];

    expect(mocks.runExplore).toHaveBeenCalledTimes(1);
    expect(userPrompt).toContain("Previous draft");
    expect(userPrompt).toContain("Files over 2 GB are out of scope");
    expect(systemPrompt).toContain("gave feedback");
    expect(draft.openQuestions).toEqual([]);
    expect(draft.mode).toBe("single-shot");
    // Files opened in the first round still count.
    expect(draft.filesRead).toEqual(["docs/uploader-report.md"]);
  });

  it("looks again in the repository when asked, and a new goal replaces the direction", async () => {
    mocks.runExplore
      .mockResolvedValueOnce(explored(reply({})))
      .mockResolvedValueOnce(
        explored(reply({ feature: "Only the retry policy." }), [
          "src/upload.ts",
        ]),
      );

    const run = await createSessionDraftRun(FLAGS, repo, { previous: null });

    await run.generate({
      feedback: null,
      explore: true,
      direction: "retry uploads",
    });

    const draft = await run.generate({
      feedback: "Only the retry policy for now",
      explore: true,
      direction: "only the retry policy",
    });

    expect(mocks.runExplore).toHaveBeenCalledTimes(2);
    expect(draft.feature.toLowerCase()).toContain("only the retry policy");
    expect(draft.filesRead).toEqual([
      "docs/uploader-report.md",
      "src/upload.ts",
    ]);
  });

  it("forces single-shot with the docs digest when reading the code is off", async () => {
    mocks.runExplore.mockResolvedValue(explored(reply({}), []));

    const run = await createSessionDraftRun(FLAGS, repo, { previous: null });

    await run.generate({
      feedback: null,
      explore: false,
      direction: "uploader incident",
    });

    const options = mocks.runExplore.mock.calls[0]?.[2] as {
      explore: boolean;
      fallbackContext: () => Promise<string>;
    };

    expect(options.explore).toBe(false);
    await expect(options.fallbackContext()).resolves.toContain(
      "Uploads drop on flaky networks",
    );
  });

  it("repairs invalid JSON once, then gives up with a clear error", async () => {
    mocks.runExplore.mockResolvedValue(
      explored("Here is what I found: nothing parseable"),
    );
    mocks.runSingleShot.mockResolvedValueOnce(shot(reply({})));

    const run = await createSessionDraftRun(FLAGS, repo, { previous: null });
    const draft = await run.generate({
      feedback: null,
      explore: true,
      direction: "retry uploads",
    });

    expect(draft.requirements).toBe("- Retry a failed upload up to 3 times");

    mocks.runExplore.mockResolvedValue(explored("still not json"));
    mocks.runSingleShot.mockResolvedValueOnce(shot("nope"));

    const second = await createSessionDraftRun(FLAGS, repo, { previous: null });

    await expect(
      second.generate({
        feedback: null,
        explore: true,
        direction: "retry uploads",
      }),
    ).rejects.toThrow(/usable session context/u);
  });

  it("hands the repair the files the explorer opened", async () => {
    mocks.runExplore.mockResolvedValue(
      explored("I read the report and the code.", ["docs/uploader-report.md"]),
    );
    mocks.runSingleShot.mockResolvedValueOnce(shot(reply({})));

    const run = await createSessionDraftRun(FLAGS, repo, { previous: null });

    await run.generate({
      feedback: null,
      explore: true,
      direction: "retry uploads",
    });

    const [, repairPrompt] = mocks.runSingleShot.mock.calls[0] as [
      string,
      string,
    ];

    expect(repairPrompt).toContain("Files you opened while exploring");
    expect(repairPrompt).toContain("Uploads drop on flaky networks");
  });

  it("revises a saved context and keeps its target branch", async () => {
    mocks.runExplore.mockResolvedValue(explored(reply({})));

    const run = await createSessionDraftRun(FLAGS, repo, {
      previous: {
        feature: "Old goal",
        ticket: "ABC-123",
        requirements: "- Old rule",
        baseRef: "develop",
      },
    });
    const draft = await run.generate({
      feedback: null,
      explore: true,
      direction: "retry uploads",
    });
    const [systemPrompt, userPrompt] = mocks.runExplore.mock.calls[0] as [
      string,
      string,
    ];

    expect(run.meta.baseRef).toBe("develop");
    expect(draft.baseRef).toBe("develop");
    expect(userPrompt).toContain("Old goal");
    expect(systemPrompt).toContain("previous draft");
  });
});

describe("parseSessionDraftReply", () => {
  it("rejects a reply without a feature", () => {
    expect(() => parseSessionDraftReply('{"requirements": "x"}')).toThrow();
  });

  it("tolerates a fenced reply, string sources and empty requirements", () => {
    const parsed = parseSessionDraftReply(
      '```json\n{"feature": "Goal", "requirements": "  ", "sources": ["README.md"], "openQuestions": ["", "Why?"]}\n```',
    );

    expect(parsed).toEqual({
      feature: "Goal",
      requirements: null,
      ticket: null,
      sources: [{ path: "README.md", why: "" }],
      openQuestions: ["Why?"],
    });
  });
});

describe("parseSessionDraftReply requirements", () => {
  it("turns a JSON array of requirements into a markdown list", () => {
    const parsed = parseSessionDraftReply(
      'json\n{"feature": "Goal", "requirements": ["Max 3 retries", "- Backoff from 1s", 7, " "]}',
    );

    expect(parsed.requirements).toBe("- Max 3 retries\n- Backoff from 1s");
  });
});

describe("toSessionContext", () => {
  const draft: SessionDraft = {
    feature: "Retry uploads",
    ticket: "ABC-123",
    requirements: "- Retry 3 times",
    baseRef: "main",
    sources: [{ path: "docs/uploader-report.md", why: "incident" }],
    openQuestions: ["Large files?"],
    mode: "single-shot",
    filesRead: [],
    fallbackReason: null,
  };

  it("appends references, and open questions only when asked", () => {
    expect(toSessionContext(draft, { keepOpenQuestions: false })).toEqual({
      feature: "Retry uploads",
      ticket: "ABC-123",
      requirements:
        "- Retry 3 times\n\nReferences:\n- docs/uploader-report.md — incident",
      baseRef: "main",
    });
    expect(
      toSessionContext(draft, { keepOpenQuestions: true }).requirements,
    ).toContain("Open questions:\n- Large files?");
  });

  it("does not stack a second References block when the model echoes one", () => {
    const saved = toSessionContext(draft, { keepOpenQuestions: true });
    const regenerated = toSessionContext(
      { ...draft, requirements: saved.requirements },
      { keepOpenQuestions: true },
    );

    expect(regenerated.requirements).toBe(saved.requirements);
  });

  it("stays null when there is nothing to record", () => {
    expect(
      toSessionContext(
        { ...draft, requirements: null, sources: [], openQuestions: [] },
        { keepOpenQuestions: true },
      ).requirements,
    ).toBeNull();
  });
});

describe("buildDocsDigest", () => {
  it("excerpts only documents that mention the hints", async () => {
    const digest = await buildDocsDigest(
      repo,
      ["docs/uploader-report.md", "docs/unrelated.md"],
      ["flaky uploads"],
    );

    expect(digest).toContain("docs/uploader-report.md");
    expect(digest).not.toContain("Theme colors");
  });
});

describe("createSessionDraftSystemPrompt", () => {
  it("keeps the author in charge and demands evidence and JSON", () => {
    const prompt = createSessionDraftSystemPrompt({}, null);

    expect(prompt).toContain("direction is the author's decision");
    expect(prompt).toContain("Never invent acceptance criteria");
    expect(prompt).toContain('"openQuestions"');
    expect(prompt).toContain("single JSON object");
  });
});
