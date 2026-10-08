import { describe, expect, it } from "vitest";
import { ClaudeStreamParser } from "../src/llm/claude-cli/stream.js";

const line = (event: unknown) => `${JSON.stringify(event)}\n`;
const delta = (text: string) =>
  line({
    type: "stream_event",
    parent_tool_use_id: null,
    event: { type: "content_block_delta", delta: { type: "text_delta", text } },
  });
const assistant = (text: string) =>
  line({
    type: "assistant",
    parent_tool_use_id: null,
    message: { content: [{ type: "thinking" }, { type: "text", text }] },
  });

describe("ClaudeStreamParser", () => {
  it("emits text deltas and ignores the repeated assistant message", () => {
    const parser = new ClaudeStreamParser();
    const out = [
      ...parser.push(line({ type: "system", subtype: "init" })),
      ...parser.push(
        delta("hello") + delta(" world") + assistant("hello world"),
      ),
      ...parser.flush(),
    ];

    expect(out.join("")).toBe("hello world");
  });

  it("joins a JSON line split across chunks", () => {
    const parser = new ClaudeStreamParser();
    const raw = delta("ok");
    const out = [
      ...parser.push(raw.slice(0, 7)),
      ...parser.push(raw.slice(7)),
      ...parser.flush(),
    ];

    expect(out).toEqual(["ok"]);
  });

  it("falls back to assistant text when no delta arrives", () => {
    const parser = new ClaudeStreamParser();

    expect(parser.push(assistant("whole answer"))).toEqual([]);
    expect(parser.flush()).toEqual(["whole answer"]);
  });

  it("ignores thinking deltas, subagent traffic and non-JSON lines", () => {
    const parser = new ClaudeStreamParser();
    const out = parser.push(
      "not json\n" +
        line({
          type: "stream_event",
          event: { delta: { type: "thinking_delta", thinking: "hmm" } },
        }) +
        line({
          type: "stream_event",
          parent_tool_use_id: "toolu_1",
          event: { delta: { type: "text_delta", text: "sub" } },
        }),
    );

    expect([...out, ...parser.flush()]).toEqual([]);
  });

  it("records success and error results", () => {
    const ok = new ClaudeStreamParser();

    ok.push(
      line({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "x",
      }),
    );
    expect(ok.result).toEqual({
      isError: false,
      message: "x",
      subtype: "success",
    });

    const failed = new ClaudeStreamParser();

    failed.push(
      line({
        type: "result",
        subtype: "error_during_execution",
        errors: ["a", "b"],
      }),
    );
    expect(failed.result).toEqual({
      isError: true,
      message: "a; b",
      subtype: "error_during_execution",
    });
  });
});
