import { describe, expect, it } from "vitest";
import type { RunEvent } from "../src/llm/events.js";
import { appendEvent, type LogItem } from "../src/ui/run-view.js";

function fold(events: RunEvent[]): LogItem[] {
  let id = 1;
  const nextId = () => id++;

  return events.reduce<LogItem[]>(
    (log, event) => appendEvent(log, event, nextId),
    [],
  );
}

describe("appendEvent", () => {
  it("coalesces consecutive text chunks into one item", () => {
    const log = fold([
      { type: "text", text: "Hello " },
      { type: "text", text: "world" },
    ]);

    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ type: "text", content: "Hello world" });
  });

  it("tracks a tool from running to done", () => {
    const log = fold([
      { type: "tool_start", id: "t1", name: "grep", call: "grep(foo)" },
      { type: "tool_end", id: "t1", name: "grep", status: "finished" },
    ]);

    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      type: "tool",
      content: "grep(foo)",
      status: "done",
    });
  });

  it("marks a failed tool as error", () => {
    const log = fold([
      { type: "tool_start", id: "t1", name: "sh", call: "sh(ls)" },
      { type: "tool_end", id: "t1", name: "sh", status: "error" },
    ]);

    expect(log[0]?.status).toBe("error");
  });

  it("appends debug lines as separate items", () => {
    const log = fold([
      { type: "debug", message: "one" },
      { type: "debug", message: "two" },
    ]);

    expect(log).toHaveLength(2);
    expect(log.map((item) => item.type)).toEqual(["debug", "debug"]);
  });

  it("coalesces consecutive status events in place", () => {
    const log = fold([
      { type: "status", message: "Retrying (attempt 2/3) in 1s — HTTP 429" },
      { type: "status", message: "Retrying (attempt 3/3) in 2s — HTTP 429" },
    ]);

    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      type: "status",
      content: "Retrying (attempt 3/3) in 2s — HTTP 429",
    });
  });

  it("keeps a status separate from surrounding text", () => {
    const log = fold([
      { type: "text", text: "partial" },
      { type: "status", message: "Retrying (attempt 2/3) in 1s — HTTP 500" },
      { type: "text", text: "final" },
    ]);

    expect(log.map((item) => item.type)).toEqual(["text", "status", "text"]);
  });
});
