import { realpath, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { CliError } from "../src/domain/errors.js";
import {
  buildClaudeEnv,
  ChatClaudeCli,
  getClaudeCliDir,
  splitMessages,
} from "../src/llm/claude-cli/model.js";

/** Redirect ~/.sinscribe so tests never read or write the real one. */
const FAKE_HOME = vi.hoisted(
  () => `/tmp/sinscribe-claude-cli-home-${process.pid}-${Date.now()}`,
);

vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();

  const homedir = (): string => FAKE_HOME;

  return { ...original, default: { ...original, homedir }, homedir };
});

const FAKE_CLAUDE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "fake-claude-cli.mjs",
);

function makeModel(model = "sonnet"): ChatClaudeCli {
  return new ChatClaudeCli({ model, command: FAKE_CLAUDE });
}

async function collect(
  chatModel: ChatClaudeCli,
  messages = [new HumanMessage("hi")],
): Promise<string> {
  const parts: string[] = [];

  for await (const chunk of await chatModel.stream(messages)) {
    parts.push(typeof chunk.content === "string" ? chunk.content : "");
  }

  return parts.join("");
}

function argvOf(output: string): string[] {
  const line = output.split("\n").find((l) => l.startsWith("ARGV:")) ?? "";

  return JSON.parse(line.slice("ARGV:".length)) as string[];
}

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await rm(FAKE_HOME, { recursive: true, force: true });
});

describe("ChatClaudeCli", () => {
  it("streams the answer once, from the deltas, not the repeated message", async () => {
    const output = await collect(makeModel());

    expect(output.startsWith("ARGV:")).toBe(true);
    expect(output.match(/ARGV:/gu)).toHaveLength(1);
  });

  it("runs headless, tools-less and isolated from the user's setup", async () => {
    const argv = argvOf(await collect(makeModel("haiku")));

    expect(argv.slice(0, 5)).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
    ]);
    // `--tools ""` is what keeps this provider single-shot.
    expect(argv[argv.indexOf("--tools") + 1]).toBe("");
    expect(argv[argv.indexOf("--model") + 1]).toBe("haiku");
    expect(argv).toContain("--strict-mcp-config");
    expect(argv).toContain("--disable-slash-commands");
    expect(argv).toContain("--no-session-persistence");
    expect(argv[argv.indexOf("--setting-sources") + 1]).toBe("");
  });

  it("passes system text as --system-prompt and the rest over stdin", async () => {
    const big = "x".repeat(50_000);
    const output = await collect(makeModel(), [
      new SystemMessage("Be terse."),
      new HumanMessage(big),
    ]);
    const argv = argvOf(output);

    expect(argv[argv.indexOf("--system-prompt") + 1]).toBe("Be terse.");
    expect(output).toContain(`STDIN:${big}`);
    expect(argv.join(" ")).not.toContain(big);
  });

  it("spawns in Sinscribe's own directory, not the user's repo", async () => {
    expect(getClaudeCliDir().startsWith(FAKE_HOME)).toBe(true);

    const output = await collect(makeModel());

    // realpath: on macOS /tmp is a symlink to /private/tmp.
    expect(output).toContain(`CWD:${await realpath(getClaudeCliDir())}`);
  });

  it("never hands Sinscribe's API keys to the CLI", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-should-not-leak");

    expect(await collect(makeModel())).toContain("KEY:<unset>");
  });

  it("parses correctly when stdout arrives one byte at a time", async () => {
    vi.stubEnv("FAKE_CLAUDE_SPLIT", "1");

    const output = await collect(makeModel());

    expect(output.startsWith("ARGV:")).toBe(true);
    expect(output.match(/ARGV:/gu)).toHaveLength(1);
  });

  it("surfaces the CLI's own error result (e.g. signed out)", async () => {
    vi.stubEnv("FAKE_CLAUDE_ERROR", "1");

    const attempt = collect(makeModel());

    await expect(attempt).rejects.toBeInstanceOf(CliError);
    await expect(attempt).rejects.toThrow(/Not logged in/u);
  });

  it("surfaces a crashing CLI with its stderr", async () => {
    vi.stubEnv("FAKE_CLAUDE_CRASH", "1");

    await expect(collect(makeModel())).rejects.toThrow(/boom/u);
  });

  it("explains how to install a CLI that is not on PATH", async () => {
    const missing = new ChatClaudeCli({
      model: "sonnet",
      command: "/nonexistent/claude",
    });

    await expect(collect(missing)).rejects.toThrow(
      /not installed|not on PATH/u,
    );
  });

  it("bindTools throws rather than pretending to support tools", () => {
    expect(() => makeModel().bindTools()).toThrow(CliError);
  });
});

describe("buildClaudeEnv", () => {
  it("drops every secret key and disables color", () => {
    const env = buildClaudeEnv({
      PATH: "/bin",
      ANTHROPIC_API_KEY: "a",
      OPENCODE_API_KEY: "b",
    });

    expect(env).toEqual({ PATH: "/bin", NO_COLOR: "1" });
  });
});

describe("splitMessages", () => {
  it("separates system text from the prompt and drops empties", () => {
    expect(
      splitMessages([
        new SystemMessage("A"),
        new HumanMessage(""),
        new HumanMessage("B"),
      ]),
    ).toEqual({ system: "A", prompt: "B" });
  });
});
