import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GlobalFlags } from "../src/commands.js";
import {
  AGENT_DIR,
  agentFilePath,
  dryRunAgentSetup,
  planAgentSetup,
  runAgentSetupPrint,
  writeAgentSetup,
} from "../src/domain/agent-setup.js";
import { initRepo, makeTempDir, removeDir } from "./git-fixture.js";

const runAgentMock = vi.hoisted(() => vi.fn());

vi.mock("../src/llm/agent.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/llm/agent.js")>();

  return { ...original, runAgent: runAgentMock };
});

const FLAGS: GlobalFlags = {
  dryRun: false,
  print: false,
  modelId: null,
  provider: null,
  apiKey: null,
};

const PLAN = {
  stack: ["NestJS"],
  roster: [
    { id: "api", label: "API", role: "Owns the NestJS API." },
    { id: "web", label: "Web", role: "Owns the React app." },
  ],
  questions: [{ id: "goal", question: "What is the goal?", why: "aim" }],
};

/** The system prompt handed to the most recent runAgent call. */
function lastSystemPrompt(): string {
  return runAgentMock.mock.calls.at(-1)?.[0] as string;
}

describe("agent-setup runs", () => {
  let dir = "";

  beforeEach(async () => {
    dir = await makeTempDir("sinscribe-agent-setup-run-");
    await initRepo(dir);
    runAgentMock.mockReset();
  });

  afterEach(async () => {
    await removeDir(dir);
  });

  it("dry-runs without calling the model", async () => {
    const output = await dryRunAgentSetup(dir);

    expect(runAgentMock).not.toHaveBeenCalled();
    expect(output).toContain("no LLM call, no credentials read");
    expect(output).toContain(AGENT_DIR);
    expect(output).toContain("0 definitions");
  });

  it("counts the definitions that already exist in the dry run", async () => {
    await mkdir(path.join(dir, AGENT_DIR), { recursive: true });
    await writeFile(agentFilePath(dir, "api"), "x");

    expect(await dryRunAgentSetup(dir)).toContain("1 definition");
  });

  it("parses the analysis pass into a plan", async () => {
    runAgentMock.mockResolvedValue({
      text: JSON.stringify(PLAN),
      modelId: "test",
    });

    const { plan, repoRoot } = await planAgentSetup(FLAGS, dir);

    expect(plan.roster.map((agent) => agent.id)).toEqual(["api", "web"]);
    // git resolves symlinks (/var -> /private/var on macOS), so compare the
    // repository's own directory name rather than the raw temp path.
    expect(path.basename(repoRoot)).toBe(path.basename(dir));
    // Read-only pass: it must not be told to write anything.
    expect(lastSystemPrompt()).toContain("analysis pass only");
  });

  it("tells the write pass to create every new definition", async () => {
    runAgentMock.mockResolvedValue({ text: "wrote 2 files", modelId: "test" });

    await writeAgentSetup(
      { roster: PLAN.roster, refresh: [], answers: [], stack: ["NestJS"] },
      FLAGS,
      dir,
    );

    const prompt = lastSystemPrompt();

    expect(prompt).toContain("Create these files with write_file");
    expect(prompt).toContain("/.claude/agents/api.md");
    expect(prompt).toContain("/.claude/agents/web.md");
    expect(prompt).not.toContain("Update these files in place");
  });

  it("routes an existing definition to edit_file, not write_file", async () => {
    runAgentMock.mockResolvedValue({ text: "done", modelId: "test" });

    await writeAgentSetup(
      { roster: PLAN.roster, refresh: ["api"], answers: [], stack: [] },
      FLAGS,
      dir,
    );

    const prompt = lastSystemPrompt();
    const create = prompt.slice(
      prompt.indexOf("Create these files"),
      prompt.indexOf("Update these files"),
    );
    const update = prompt.slice(prompt.indexOf("Update these files"));

    expect(create).toContain("/.claude/agents/web.md");
    expect(create).not.toContain("/.claude/agents/api.md");
    expect(update).toContain("/.claude/agents/api.md");
  });

  it("never names a kept definition in the whitelist", async () => {
    runAgentMock.mockResolvedValue({ text: "done", modelId: "test" });

    // "Keep them" is modelled by dropping those agents from the roster, so
    // the prompt cannot mention the path at all.
    await writeAgentSetup(
      {
        roster: PLAN.roster.filter((agent) => agent.id !== "api"),
        refresh: [],
        answers: [],
        stack: [],
      },
      FLAGS,
      dir,
    );

    expect(lastSystemPrompt()).not.toContain("/.claude/agents/api.md");
  });

  it("passes the author's answers through to the write prompt", async () => {
    runAgentMock.mockResolvedValue({ text: "done", modelId: "test" });

    await writeAgentSetup(
      {
        roster: PLAN.roster,
        refresh: [],
        answers: [
          {
            question: "What is the goal?",
            answer: "Ship the billing rewrite.",
          },
        ],
        stack: [],
      },
      FLAGS,
      dir,
    );

    expect(lastSystemPrompt()).toContain("Ship the billing rewrite.");
  });

  it("does not call the model when every agent was skipped", async () => {
    runAgentMock.mockResolvedValue({ text: "done", modelId: "test" });

    const output = await writeAgentSetup(
      { roster: [], refresh: [], answers: [], stack: [] },
      FLAGS,
      dir,
    );

    expect(runAgentMock).not.toHaveBeenCalled();
    expect(output).toContain("every proposed agent was skipped");
  });

  it("skips the interview on the print path and reports the questions", async () => {
    runAgentMock
      .mockResolvedValueOnce({ text: JSON.stringify(PLAN), modelId: "test" })
      .mockResolvedValueOnce({
        text: "wrote api.md and web.md",
        modelId: "test",
      });

    const output = await runAgentSetupPrint(FLAGS, dir);

    expect(runAgentMock).toHaveBeenCalledTimes(2);
    expect(output).toContain("wrote api.md and web.md");
    expect(output).toContain("Skipped 1 clarifying question(s)");
    expect(output).toContain("What is the goal?");
  });

  it("refreshes rather than re-creating an existing file on the print path", async () => {
    await mkdir(path.join(dir, AGENT_DIR), { recursive: true });
    await writeFile(agentFilePath(dir, "api"), "---\nname: api\n---\n");

    runAgentMock
      .mockResolvedValueOnce({ text: JSON.stringify(PLAN), modelId: "test" })
      .mockResolvedValueOnce({ text: "done", modelId: "test" });

    await runAgentSetupPrint(FLAGS, dir);

    const prompt = lastSystemPrompt();

    expect(prompt.slice(prompt.indexOf("Update these files"))).toContain(
      "/.claude/agents/api.md",
    );
  });
});
