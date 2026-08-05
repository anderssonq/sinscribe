import { describe, expect, it } from "vitest";
import { getHelpText, parseCommand } from "../src/commands.js";

describe("parseCommand", () => {
  it("parses bare invocation as interactive chat", () => {
    const command = parseCommand([]);

    expect(command).toMatchObject({
      kind: "run",
      command: { name: "chat", message: null },
    });
  });

  it("parses a chat message with global flags", () => {
    const command = parseCommand(["-p", "hello", "there"]);

    expect(command).toMatchObject({
      kind: "run",
      command: { name: "chat", message: "hello there" },
      flags: { print: true },
    });
  });

  it("rejects -p without message or subcommand", () => {
    expect(parseCommand(["-p"])).toMatchObject({ kind: "error" });
  });

  it("parses pr with options", () => {
    const command = parseCommand([
      "pr",
      "--template",
      "github",
      "--base",
      "origin/main",
      "--dry-run",
    ]);

    expect(command).toMatchObject({
      kind: "run",
      command: {
        name: "pr",
        template: "github",
        base: "origin/main",
        ticket: null,
      },
      flags: { dryRun: true },
    });
  });

  it("defaults pr to the andersoftware template", () => {
    expect(parseCommand(["pr"])).toMatchObject({
      kind: "run",
      command: { name: "pr", template: "andersoftware", staged: false },
    });
  });

  it("parses the pr --staged flag", () => {
    expect(parseCommand(["pr", "--staged"])).toMatchObject({
      kind: "run",
      command: { name: "pr", staged: true },
    });
  });

  it("rejects unknown pr options", () => {
    expect(parseCommand(["pr", "--bogus"])).toMatchObject({ kind: "error" });
  });

  it("parses prompt with everything optional", () => {
    expect(parseCommand(["prompt"])).toMatchObject({
      kind: "run",
      command: {
        name: "prompt",
        type: null,
        description: null,
        out: null,
        handoff: false,
      },
    });
  });

  it("parses prompt --handoff without swallowing the description", () => {
    expect(
      parseCommand(["prompt", "--handoff", "add", "retry", "logic"]),
    ).toMatchObject({
      kind: "run",
      command: {
        name: "prompt",
        handoff: true,
        description: "add retry logic",
      },
    });
  });

  it("parses prompt type, description, and --out", () => {
    expect(
      parseCommand([
        "prompt",
        "--type",
        "bugfix",
        "crash",
        "on",
        "empty",
        "upload",
        "--out",
        "PROMPT.md",
      ]),
    ).toMatchObject({
      kind: "run",
      command: {
        name: "prompt",
        type: "bugfix",
        description: "crash on empty upload",
        out: "PROMPT.md",
        handoff: false,
      },
    });
  });

  it("rejects an invalid prompt --type", () => {
    expect(parseCommand(["prompt", "--type", "wrong"])).toMatchObject({
      kind: "error",
    });
  });

  it("rejects unknown prompt options", () => {
    expect(parseCommand(["prompt", "--bogus"])).toMatchObject({
      kind: "error",
    });
  });

  it("mentions prompt in the help text", () => {
    expect(getHelpText()).toContain("sinscribe prompt");
  });

  it("parses commit flags", () => {
    expect(parseCommand(["commit", "--all", "--no-gitmoji"])).toMatchObject({
      kind: "run",
      command: { name: "commit", all: true, gitmoji: false },
    });
  });

  it("parses branch input and type", () => {
    expect(
      parseCommand(["branch", "ABC-123", "add", "retries", "--type", "fix"]),
    ).toMatchObject({
      kind: "run",
      command: { name: "branch", input: "ABC-123 add retries", type: "fix" },
    });
  });

  it("parses docs with its default and --out", () => {
    expect(parseCommand(["docs"])).toMatchObject({
      kind: "run",
      command: { name: "docs", out: null },
    });
    expect(parseCommand(["docs", "--out", "DOCS.md"])).toMatchObject({
      kind: "run",
      command: { name: "docs", out: "DOCS.md" },
    });
  });

  it("rejects unknown docs options", () => {
    expect(parseCommand(["docs", "--format", "md"])).toMatchObject({
      kind: "error",
    });
  });

  it("mentions docs in the help text", () => {
    expect(getHelpText()).toContain("sinscribe docs");
  });

  it("rejects branch without input", () => {
    expect(parseCommand(["branch"])).toMatchObject({ kind: "error" });
  });

  it("parses template actions", () => {
    expect(parseCommand(["template", "list"])).toMatchObject({
      kind: "run",
      command: { name: "template", action: "list" },
    });
    expect(parseCommand(["template", "show", "jira"])).toMatchObject({
      kind: "run",
      command: { name: "template", action: "show", templateName: "jira" },
    });
    expect(parseCommand(["template", "show"])).toMatchObject({
      kind: "error",
    });
  });

  it("parses model overrides", () => {
    expect(
      parseCommand(["commit", "--model-id", "z-ai/glm-5.2"]),
    ).toMatchObject({
      kind: "run",
      flags: { modelId: "z-ai/glm-5.2" },
    });
    expect(parseCommand(["--model-id"])).toMatchObject({ kind: "error" });
  });

  it("parses help", () => {
    expect(parseCommand(["--help"])).toMatchObject({ kind: "help" });
    expect(parseCommand(["pr", "--help"])).toMatchObject({ kind: "help" });
  });

  it("parses version", () => {
    expect(parseCommand(["--version"])).toMatchObject({
      kind: "version",
      exitCode: 0,
    });
    expect(parseCommand(["-v"])).toMatchObject({
      kind: "version",
      exitCode: 0,
    });
  });

  it("version wins over a subcommand or other flags", () => {
    expect(parseCommand(["-v", "pr", "--base", "main"])).toMatchObject({
      kind: "version",
    });
    expect(parseCommand(["pr", "--version"])).toMatchObject({
      kind: "version",
    });
  });

  it("mentions version in the help text", () => {
    expect(getHelpText()).toContain("--version");
  });

  it("parses a provider override", () => {
    expect(parseCommand(["pr", "--provider", "Anthropic"])).toMatchObject({
      kind: "run",
      flags: { provider: "anthropic" },
    });
    expect(parseCommand(["pr", "--provider=openai"])).toMatchObject({
      kind: "run",
      flags: { provider: "openai" },
    });
  });

  it("rejects an invalid provider", () => {
    expect(parseCommand(["pr", "--provider", "bogus"])).toMatchObject({
      kind: "error",
    });
    expect(parseCommand(["pr", "--provider=bogus"])).toMatchObject({
      kind: "error",
    });
    expect(parseCommand(["--provider"])).toMatchObject({ kind: "error" });
  });

  it("parses an api-key override", () => {
    expect(parseCommand(["pr", "--api-key", "sk-test-123"])).toMatchObject({
      kind: "run",
      flags: { apiKey: "sk-test-123" },
    });
    expect(parseCommand(["pr", "--api-key=sk-test-456"])).toMatchObject({
      kind: "run",
      flags: { apiKey: "sk-test-456" },
    });
  });

  it("rejects a missing or empty api-key value", () => {
    expect(parseCommand(["--api-key"])).toMatchObject({ kind: "error" });
    expect(parseCommand(["pr", "--api-key="])).toMatchObject({
      kind: "error",
    });
  });

  it("combines provider, api-key, and model-id overrides", () => {
    expect(
      parseCommand([
        "commit",
        "--provider",
        "anthropic",
        "--api-key",
        "sk-x",
        "--model-id",
        "claude-sonnet-5",
      ]),
    ).toMatchObject({
      kind: "run",
      command: { name: "commit" },
      flags: {
        provider: "anthropic",
        apiKey: "sk-x",
        modelId: "claude-sonnet-5",
      },
    });
  });
});
