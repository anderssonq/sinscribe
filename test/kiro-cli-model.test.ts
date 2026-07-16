import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CliError } from "../src/domain/errors.js";
import { getKiroAgentDir, KIRO_AGENT_NAME } from "../src/llm/kiro-cli/agent.js";
import { ChatKiroCli, flattenMessages } from "../src/llm/kiro-cli/model.js";

const FAKE_KIRO = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "fake-kiro-cli.mjs",
);

function makeModel(model = "auto"): ChatKiroCli {
  return new ChatKiroCli({ model, command: FAKE_KIRO });
}

async function collect(chatModel: ChatKiroCli, prompt = "hi"): Promise<string> {
  const parts: string[] = [];

  for await (const chunk of await chatModel.stream([
    new HumanMessage(prompt),
  ])) {
    parts.push(typeof chunk.content === "string" ? chunk.content : "");
  }

  return parts.join("");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("ChatKiroCli", () => {
  it("runs the tools-less agent and returns clean text", async () => {
    const output = await collect(makeModel());

    // --agent (not --trust-tools=) is what actually removes the tools:
    // the flag only governs auto-approval and was proven not to protect.
    expect(output).toContain(
      `ARGV:["chat","--no-interactive","--agent","${KIRO_AGENT_NAME}"]`,
    );
    expect(output).not.toContain("--trust-tools");
    // The styling and the "> " marker must never reach the caller.
    expect(output).not.toContain("\x1b[");
    expect(output.startsWith("ARGV:")).toBe(true);
  });

  it("spawns in the agent directory so Kiro discovers the agent", async () => {
    const output = await collect(makeModel());

    expect(output).toContain(`CWD:${getKiroAgentDir()}`);
  });

  it("writes an agent config that grants no tools at all", async () => {
    await collect(makeModel());

    const config = JSON.parse(
      await readFile(
        path.join(
          getKiroAgentDir(),
          ".amazonq",
          "cli-agents",
          `${KIRO_AGENT_NAME}.json`,
        ),
        "utf8",
      ),
    ) as Record<string, unknown>;

    // The empty allowlist is the single thing keeping this provider inside
    // the single-shot contract.
    expect(config.tools).toEqual([]);
    expect(config.allowedTools).toEqual([]);
    // Inheriting the user's MCP servers would hand the tools back.
    expect(config.includeMcpJson).toBe(false);
    // An unknown key (e.g. $schema) makes Kiro skip the file silently.
    expect(config.$schema).toBeUndefined();
  });

  it("cleans correctly even when output arrives one byte at a time", async () => {
    vi.stubEnv("FAKE_KIRO_SPLIT", "1");

    const output = await collect(makeModel());

    expect(output).not.toContain("\x1b[");
    expect(output.startsWith("ARGV:")).toBe(true);
  });

  it("pins a model only when one is chosen", async () => {
    expect(await collect(makeModel("glm-5"))).toContain(`"--model","glm-5"`);
    expect(await collect(makeModel())).not.toContain("--model");
  });

  it("sends the prompt over stdin, not argv", async () => {
    // A 50k-char diff would blow the argv limit if it were an argument.
    const big = "x".repeat(50_000);
    const output = await collect(makeModel(), big);

    expect(output).toContain(`STDIN:${big}`);
    expect(output).not.toContain(`"${big}"`);
  });

  it("refuses to continue if the tools-less agent was not loaded", async () => {
    // Kiro falls back to a tool-enabled agent here; running anyway would
    // silently break the no-tools guarantee.
    vi.stubEnv("FAKE_KIRO_NO_AGENT", "1");

    const attempt = collect(makeModel());

    await expect(attempt).rejects.toBeInstanceOf(CliError);
    await expect(attempt).rejects.toThrow(/would have run with tools enabled/u);
  });

  it("surfaces a failing CLI with its stderr", async () => {
    vi.stubEnv("FAKE_KIRO_FAIL", "1");

    await expect(collect(makeModel())).rejects.toThrow(/not logged in/u);
  });

  it("explains how to install a CLI that is not on PATH", async () => {
    const missing = new ChatKiroCli({
      model: "auto",
      command: "/nonexistent/kiro-cli",
    });

    const attempt = collect(missing);

    await expect(attempt).rejects.toBeInstanceOf(CliError);
    await expect(attempt).rejects.toThrow(/not installed|not on PATH/u);
  });

  it("stops the child when the caller aborts (watchdog path)", async () => {
    const controller = new AbortController();

    controller.abort();

    await expect(
      (async () => {
        for await (const chunk of await makeModel().stream(
          [new HumanMessage("hi")],
          { signal: controller.signal },
        )) {
          void chunk;
        }
      })(),
    ).rejects.toThrow();
  });

  it("bindTools throws rather than pretending to support tools", () => {
    expect(() => makeModel().bindTools()).toThrow(CliError);
  });
});

describe("flattenMessages", () => {
  it("puts system text ahead of the user prompt in one string", () => {
    expect(
      flattenMessages([
        new SystemMessage("Be terse."),
        new HumanMessage("Write a commit message."),
      ]),
    ).toBe("Be terse.\n\nWrite a commit message.");
  });

  it("drops empty parts", () => {
    expect(flattenMessages([new HumanMessage("only this")])).toBe("only this");
  });
});
