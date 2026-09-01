import { describe, expect, it } from "vitest";
import {
  buildShellEnv,
  createThreadId,
  parseStreamEvent,
} from "../src/llm/agent.js";
import {
  ANTHROPIC_API_KEY_ENV_KEY,
  OPENAI_API_KEY_ENV_KEY,
  OPENROUTER_API_KEY_ENV_KEY,
  ANTHROPIC_BASE_URL_ENV_KEY,
  SINSCRIBE_PROVIDER_ENV_KEY,
} from "../src/constants.js";

describe("buildShellEnv", () => {
  it("removes secret API keys from the shell env", () => {
    const env = buildShellEnv({
      PATH: "/usr/bin:/bin",
      HOME: "/home/dev",
      [ANTHROPIC_API_KEY_ENV_KEY]: "sk-ant-secret",
      [OPENAI_API_KEY_ENV_KEY]: "sk-openai-secret",
      [OPENROUTER_API_KEY_ENV_KEY]: "sk-or-secret",
    });

    expect(env[ANTHROPIC_API_KEY_ENV_KEY]).toBeUndefined();
    expect(env[OPENAI_API_KEY_ENV_KEY]).toBeUndefined();
    expect(env[OPENROUTER_API_KEY_ENV_KEY]).toBeUndefined();
  });

  it("keeps PATH/HOME, base URLs, and non-secret config vars", () => {
    const env = buildShellEnv({
      PATH: "/usr/bin:/bin",
      HOME: "/home/dev",
      [ANTHROPIC_BASE_URL_ENV_KEY]: "https://example.test",
      [SINSCRIBE_PROVIDER_ENV_KEY]: "anthropic",
      [ANTHROPIC_API_KEY_ENV_KEY]: "sk-ant-secret",
    });

    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.HOME).toBe("/home/dev");
    expect(env[ANTHROPIC_BASE_URL_ENV_KEY]).toBe("https://example.test");
    expect(env[SINSCRIBE_PROVIDER_ENV_KEY]).toBe("anthropic");
    expect(env[ANTHROPIC_API_KEY_ENV_KEY]).toBeUndefined();
  });

  it("drops undefined values so the result is a plain string map", () => {
    const env = buildShellEnv({ DEFINED: "x", UNDEFINED: undefined });

    expect(env.DEFINED).toBe("x");
    expect("UNDEFINED" in env).toBe(false);
  });
});

describe("parseStreamEvent", () => {
  /** A LangGraph "messages" chunk: [mode, [messageChunk, metadata]]. */
  function messagesChunk(message: unknown): unknown {
    return ["messages", [message, { langgraph_node: "agent" }]];
  }

  it("ignores a chunk that is not a tuple", () => {
    expect(parseStreamEvent(null)).toBeNull();
    expect(parseStreamEvent("messages")).toBeNull();
    expect(parseStreamEvent({ mode: "messages" })).toBeNull();
  });

  it("ignores a tuple too short to carry a mode and a payload", () => {
    expect(parseStreamEvent(["messages"])).toBeNull();
    expect(parseStreamEvent([])).toBeNull();
  });

  it("ignores a mode it does not handle", () => {
    expect(parseStreamEvent(["values", { foo: 1 }])).toBeNull();
    expect(parseStreamEvent(["updates", { foo: 1 }])).toBeNull();
  });

  it("reads assistant text from a two-element [mode, payload] tuple", () => {
    expect(
      parseStreamEvent(messagesChunk({ role: "assistant", content: "hello" })),
    ).toEqual({ type: "text", text: "hello" });
  });

  it("reads assistant text from a namespaced [namespace, mode, payload] tuple", () => {
    const chunk = [
      ["tools:step"],
      "messages",
      [{ role: "ai", content: "nested" }, {}],
    ];

    expect(parseStreamEvent(chunk)).toEqual({ type: "text", text: "nested" });
  });

  it("recognises an assistant message by its _getType method", () => {
    const message = {
      _getType: () => "ai",
      content: "from getType",
    };

    expect(parseStreamEvent(messagesChunk(message))).toEqual({
      type: "text",
      text: "from getType",
    });
  });

  it("recognises a serialized message class by the tail of its id array", () => {
    const message = {
      id: ["langchain_core", "messages", "AIMessageChunk"],
      content: "from id",
    };

    expect(parseStreamEvent(messagesChunk(message))).toEqual({
      type: "text",
      text: "from id",
    });
  });

  it("treats a throwing _getType as not an assistant message", () => {
    const message = {
      _getType: () => {
        throw new Error("boom");
      },
      content: "should not surface",
    };

    expect(parseStreamEvent(messagesChunk(message))).toBeNull();
  });

  it("drops a human message so the user's own turn is never echoed back", () => {
    expect(
      parseStreamEvent(messagesChunk({ role: "human", content: "my prompt" })),
    ).toBeNull();
  });

  it("concatenates text blocks and skips tool and reasoning blocks", () => {
    const message = {
      role: "assistant",
      content: [
        { type: "text", text: "visible " },
        { type: "reasoning", text: "hidden thinking" },
        { type: "tool_use", text: "hidden tool" },
        { type: "text", text: "tail" },
      ],
    };

    expect(parseStreamEvent(messagesChunk(message))).toEqual({
      type: "text",
      text: "visible tail",
    });
  });

  it("emits nothing for an assistant message with empty content", () => {
    expect(
      parseStreamEvent(messagesChunk({ role: "assistant", content: "" })),
    ).toBeNull();
    expect(
      parseStreamEvent(messagesChunk({ role: "assistant", content: [] })),
    ).toBeNull();
  });

  it("emits a tool_start carrying a readable call signature", () => {
    const event = parseStreamEvent([
      "tools",
      {
        event: "on_tool_start",
        name: "shell",
        toolCallId: "call-1",
        input: { command: "git status" },
      },
    ]);

    expect(event).toEqual({
      type: "tool_start",
      id: "call-1",
      name: "shell",
      call: 'shell(command="git status")',
    });
  });

  it("parses a tool input delivered as a JSON string", () => {
    const event = parseStreamEvent([
      "tools",
      {
        event: "tool-started",
        tool_name: "read_file",
        tool_call_id: "call-2",
        input: JSON.stringify({ path: "/README.md" }),
      },
    ]);

    expect(event).toEqual({
      type: "tool_start",
      id: "call-2",
      name: "read_file",
      call: 'read_file(path="/README.md")',
    });
  });

  it("falls back to a synthetic id when the payload carries no call id", () => {
    const event = parseStreamEvent([
      "tools",
      { event: "on_tool_start", name: "ls", input: { path: "/" } },
    ]);

    expect(event).toMatchObject({ type: "tool_start", name: "ls" });
    expect((event as { id: string }).id).toContain("ls:");
  });

  it('names an unnamed tool "tool" rather than dropping the event', () => {
    const event = parseStreamEvent([
      "tools",
      { event: "on_tool_start", toolCallId: "call-3", input: {} },
    ]);

    expect(event).toEqual({
      type: "tool_start",
      id: "call-3",
      name: "tool",
      call: "tool()",
    });
  });

  it("marks a finished tool as finished", () => {
    for (const name of ["on_tool_end", "tool-finished"]) {
      expect(
        parseStreamEvent([
          "tools",
          { event: name, name: "shell", toolCallId: "c" },
        ]),
      ).toEqual({
        type: "tool_end",
        id: "c",
        name: "shell",
        status: "finished",
      });
    }
  });

  it("marks a failed tool as an error so the UI can show it red", () => {
    for (const name of ["on_tool_error", "tool-error"]) {
      expect(
        parseStreamEvent([
          "tools",
          { event: name, name: "shell", toolCallId: "c" },
        ]),
      ).toEqual({ type: "tool_end", id: "c", name: "shell", status: "error" });
    }
  });

  it("ignores a tools payload that is not an object or carries no event", () => {
    expect(parseStreamEvent(["tools", "on_tool_start"])).toBeNull();
    expect(parseStreamEvent(["tools", { name: "shell" }])).toBeNull();
    expect(parseStreamEvent(["tools", { event: "on_tool_stream" }])).toBeNull();
  });

  it("caps a large tool argument so one call cannot flood the log", () => {
    const event = parseStreamEvent([
      "tools",
      {
        event: "on_tool_start",
        name: "write",
        toolCallId: "c",
        input: { body: "x".repeat(5_000) },
      },
    ]);

    // 200-char arg cap, plus the "write(" prefix and ")" suffix.
    expect((event as { call: string }).call.length).toBeLessThanOrEqual(210);
  });
});

describe("createThreadId", () => {
  it("prefixes the id so agent threads are identifiable", () => {
    expect(createThreadId("/tmp/repo")).toMatch(/^sinscribe-[0-9a-f]{16}-/u);
  });

  it("derives the same directory digest for equivalent paths", () => {
    const digest = (id: string): string => id.split("-")[1];

    expect(digest(createThreadId("/tmp/repo"))).toBe(
      digest(createThreadId("/tmp/repo/")),
    );
  });

  it("derives a different digest for a different directory", () => {
    const digest = (id: string): string => id.split("-")[1];

    expect(digest(createThreadId("/tmp/repo-a"))).not.toBe(
      digest(createThreadId("/tmp/repo-b")),
    );
  });

  it("returns a fresh id per call so runs never share a checkpoint", () => {
    expect(createThreadId("/tmp/repo")).not.toBe(createThreadId("/tmp/repo"));
  });
});
