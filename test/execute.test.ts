import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandSpec, GlobalFlags } from "../src/commands.js";
import {
  executeCommand,
  executeDryRun,
  isAgenticCommand,
  isOfflineCommand,
} from "../src/domain/execute.js";
import { git, initRepo, makeTempDir, removeDir } from "./git-fixture.js";

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

/** Every command name the parser can produce, so the classifiers stay exhaustive. */
const ALL_COMMANDS: CommandSpec[] = [
  { name: "chat", message: null },
  {
    name: "pr",
    template: "andersoftware",
    base: null,
    ticket: null,
    staged: false,
    out: null,
  },
  {
    name: "prompt",
    type: null,
    description: "add retry logic",
    out: null,
    handoff: false,
  },
  { name: "commit", all: false, scope: null, gitmoji: true },
  { name: "branch", input: "ABC-123 add retry", type: null },
  { name: "context", out: null, format: "md" },
  { name: "docs", out: null },
  { name: "agents", target: "both", update: false },
  { name: "agent-setup" },
  { name: "template", action: "list", templateName: null, from: null },
];

function commandNamed(name: CommandSpec["name"]): CommandSpec {
  const found = ALL_COMMANDS.find((command) => command.name === name);

  if (!found) {
    throw new Error(`no fixture for command ${name}`);
  }

  return found;
}

let repo: string;

beforeEach(async () => {
  runAgentMock.mockReset();
  runAgentMock.mockResolvedValue({ text: "agent output", modelId: "test" });
  repo = await makeTempDir("sinscribe-execute-");
  await initRepo(repo);
  await writeFile(path.join(repo, "file.txt"), "changed\n");
  await git(repo, "add", ".");
});

afterEach(async () => {
  await removeDir(repo);
});

describe("isAgenticCommand", () => {
  it("selects exactly the commands that explore the repository", () => {
    const agentic = ALL_COMMANDS.filter(isAgenticCommand).map(
      (command) => command.name,
    );

    expect(agentic).toEqual([
      "chat",
      "context",
      "docs",
      "agents",
      "agent-setup",
    ]);
  });

  it("excludes the single-shot commands, which have no tool activity to stream", () => {
    for (const name of ["pr", "prompt", "commit", "branch"] as const) {
      expect(isAgenticCommand(commandNamed(name))).toBe(false);
    }
  });

  it("excludes template, which never calls a model at all", () => {
    expect(isAgenticCommand(commandNamed("template"))).toBe(false);
  });
});

describe("isOfflineCommand", () => {
  it("selects template and nothing else", () => {
    const offline = ALL_COMMANDS.filter(isOfflineCommand).map(
      (command) => command.name,
    );

    expect(offline).toEqual(["template"]);
  });
});

describe("executeDryRun", () => {
  it.each([
    ["pr", "sinscribe pr (dry run"],
    ["prompt", "sinscribe prompt (dry run"],
    ["commit", "sinscribe commit (dry run"],
    ["branch", "sinscribe branch (dry run"],
    ["context", "sinscribe context (dry run"],
    ["docs", "sinscribe docs (dry run"],
    ["agents", "sinscribe agents (dry run"],
    ["agent-setup", "sinscribe agent-setup (dry run"],
    ["chat", "sinscribe chat (dry run"],
  ] as const)("routes %s to its own dry run", async (name, header) => {
    const output = await executeDryRun(commandNamed(name), repo);

    expect(output).toContain(header);
  });

  it("routes template to the template command rather than a dry-run banner", async () => {
    const output = await executeDryRun(commandNamed("template"), repo);

    expect(output).toContain("andersoftware");
  });

  it("describes an interactive chat session when no message was given", async () => {
    const output = await executeDryRun({ name: "chat", message: null }, repo);

    expect(output).toContain("Message: (interactive session)");
  });

  it("echoes the chat message it would send", async () => {
    const output = await executeDryRun(
      { name: "chat", message: "what changed?" },
      repo,
    );

    expect(output).toContain("Message: what changed?");
  });

  it("never reaches the agent runner for any command", async () => {
    for (const command of ALL_COMMANDS) {
      await executeDryRun(command, repo);
    }

    expect(runAgentMock).not.toHaveBeenCalled();
  });
});

describe("executeCommand", () => {
  it("runs template without a model", async () => {
    const output = await executeCommand(commandNamed("template"), FLAGS, repo);

    expect(output).toContain("andersoftware");
    expect(runAgentMock).not.toHaveBeenCalled();
  });

  it("routes chat to the agent runner and returns its text", async () => {
    const output = await executeCommand(
      { name: "chat", message: "what changed?" },
      FLAGS,
      repo,
    );

    expect(output).toBe("agent output");
    expect(runAgentMock).toHaveBeenCalledTimes(1);
  });

  it("gives the agent a self-introduction when chat starts with no message", async () => {
    await executeCommand({ name: "chat", message: null }, FLAGS, repo);

    const [, userMessage] = runAgentMock.mock.calls[0] as [string, string];

    expect(userMessage).toContain("Introduce yourself");
  });

  it("passes the chat thread id through so turns share history", async () => {
    await executeCommand(
      { name: "chat", message: "hi" },
      FLAGS,
      repo,
      {},
      "thread-42",
    );

    const options = runAgentMock.mock.calls[0]?.[3] as { threadId?: string };

    expect(options.threadId).toBe("thread-42");
  });

  it("forwards per-run provider and model overrides to the agent", async () => {
    await executeCommand(
      { name: "chat", message: "hi" },
      { ...FLAGS, provider: "anthropic", modelId: "claude-sonnet-5" },
      repo,
      {},
    );

    const options = runAgentMock.mock.calls[0]?.[3] as {
      provider?: string | null;
      modelId?: string | null;
    };

    expect(options.provider).toBe("anthropic");
    expect(options.modelId).toBe("claude-sonnet-5");
  });

  it("routes each agentic command to the agent runner", async () => {
    for (const name of ["context", "docs", "agents"] as const) {
      runAgentMock.mockClear();
      await executeCommand(commandNamed(name), FLAGS, repo);
      expect(runAgentMock).toHaveBeenCalledTimes(1);
    }
  });
});
