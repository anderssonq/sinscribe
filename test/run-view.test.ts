import { describe, expect, it } from "vitest";
import type { RunEvent } from "../src/llm/events.js";
import {
  appendEvent,
  tailWindowLog,
  type LogItem,
} from "../src/ui/run-view.js";

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

describe("tailWindowLog", () => {
  function textItem(id: number, content: string): LogItem {
    return { id, type: "text", content };
  }

  it("passes everything through when the budget is large enough", () => {
    const log = [textItem(1, "one"), textItem(2, "two")];
    const result = tailWindowLog(log, 80, 50);

    expect(result.items).toEqual(log);
    expect(result.hiddenRows).toBe(0);
  });

  it("drops the oldest items first and counts their rows", () => {
    const log = [
      textItem(1, "a\nb\nc"),
      { id: 2, type: "tool", content: "grep(x)", status: "done" } as LogItem,
      textItem(3, "d\ne"),
    ];
    const result = tailWindowLog(log, 80, 3);

    // Newest 2 rows (text) + 1 row (tool) fit; the 3-row oldest item hides.
    expect(result.items.map((item) => item.id)).toEqual([2, 3]);
    expect(result.hiddenRows).toBe(3);
  });

  it("tail-trims a text item that straddles the budget", () => {
    const log = [textItem(1, "l1\nl2\nl3\nl4\nl5")];
    const result = tailWindowLog(log, 80, 2);

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.content).toBe("l4\nl5");
    expect(result.hiddenRows).toBe(3);
  });

  it("counts wrapped rows for long lines, not logical lines", () => {
    // One 200-char logical line wraps to 3+ rows at width 78 (80 columns).
    const log = [textItem(1, "x".repeat(200)), textItem(2, "tail")];
    const result = tailWindowLog(log, 80, 2);

    // "tail" (1 row) fits; the wrapped long item exceeds the remaining 1
    // row, so only its last wrapped row survives.
    expect(result.items).toHaveLength(2);
    expect(result.items[1]?.content).toBe("tail");
    expect(result.items[0]?.content.length).toBeLessThanOrEqual(78);
    expect(result.hiddenRows).toBeGreaterThan(0);
  });
});
