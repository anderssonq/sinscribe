import { describe, expect, it, vi } from "vitest";
import {
  emitDebug,
  getContentText,
  isRecord,
  type RunEvent,
} from "../src/llm/events.js";

describe("getContentText", () => {
  it("returns a plain string reply unchanged", () => {
    expect(getContentText("hello world")).toBe("hello world");
  });

  it("preserves an empty string rather than turning it into a placeholder", () => {
    expect(getContentText("")).toBe("");
  });

  it("concatenates the text of every block in a content array", () => {
    expect(
      getContentText([
        { type: "text", text: "one " },
        { type: "text", text: "two" },
      ]),
    ).toBe("one two");
  });

  it("joins blocks without inserting separators of its own", () => {
    expect(
      getContentText([
        { type: "text", text: "un" },
        { type: "text", text: "split" },
      ]),
    ).toBe("unsplit");
  });

  it("drops reasoning blocks so private thinking never reaches the user", () => {
    expect(
      getContentText([
        { type: "reasoning", text: "let me think" },
        { type: "text", text: "the answer" },
      ]),
    ).toBe("the answer");
  });

  it("drops every tool-shaped block", () => {
    expect(
      getContentText([
        { type: "tool_use", text: "call" },
        { type: "tool_result", text: "result" },
        { type: "server_tool_use", text: "remote" },
        { type: "text", text: "kept" },
      ]),
    ).toBe("kept");
  });

  it("accepts a bare string inside a content array", () => {
    expect(getContentText(["raw ", { type: "text", text: "block" }])).toBe(
      "raw block",
    );
  });

  it("ignores a block with no text field", () => {
    expect(
      getContentText([
        { type: "image", source: "data:..." },
        { type: "text", text: "only this" },
      ]),
    ).toBe("only this");
  });

  it("ignores a block whose text is not a string", () => {
    expect(getContentText([{ type: "text", text: 42 }])).toBe("");
  });

  it("ignores non-object entries in a content array", () => {
    expect(
      getContentText([null, undefined, 7, { type: "text", text: "x" }]),
    ).toBe("x");
  });

  it("reads a single block passed outside an array", () => {
    expect(getContentText({ type: "text", text: "solo" })).toBe("solo");
  });

  it("returns an empty string for content it cannot read", () => {
    expect(getContentText(null)).toBe("");
    expect(getContentText(undefined)).toBe("");
    expect(getContentText(42)).toBe("");
    expect(getContentText([])).toBe("");
  });

  it("treats a block with no type as text when it carries a text field", () => {
    expect(getContentText([{ text: "untyped" }])).toBe("untyped");
  });
});

describe("emitDebug", () => {
  it("emits a debug event when debug mode is on", () => {
    const events: RunEvent[] = [];

    emitDebug({ debug: true, onEvent: (event) => events.push(event) }, "hello");

    expect(events).toEqual([{ type: "debug", message: "hello" }]);
  });

  it("emits nothing when debug mode is off", () => {
    const onEvent = vi.fn();

    emitDebug({ debug: false, onEvent }, "hello");

    expect(onEvent).not.toHaveBeenCalled();
  });

  it("emits nothing when debug mode is unset", () => {
    const onEvent = vi.fn();

    emitDebug({ onEvent }, "hello");

    expect(onEvent).not.toHaveBeenCalled();
  });

  it("does not throw when debug is on but no listener is attached", () => {
    expect(() => emitDebug({ debug: true }, "hello")).not.toThrow();
  });
});

describe("isRecord", () => {
  it("accepts objects", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
  });

  it("rejects null and primitives", () => {
    expect(isRecord(null)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
    expect(isRecord("string")).toBe(false);
    expect(isRecord(42)).toBe(false);
  });
});
