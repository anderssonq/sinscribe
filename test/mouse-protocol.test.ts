import { describe, expect, it } from "vitest";
import { hitTest, parseSgrMouse } from "../src/ui/mouse-protocol.js";

const ESC = String.fromCharCode(27);

/** Builds an SGR sequence: press/wheel end with "M", release with "m". */
function sgr(code: number, x: number, y: number, final: "M" | "m"): string {
  return `${ESC}[<${code};${x};${y}${final}`;
}

describe("parseSgrMouse", () => {
  it("parses a left-button press", () => {
    const { events, rest } = parseSgrMouse(sgr(0, 12, 5, "M"));

    expect(events).toEqual([{ kind: "press", button: 0, x: 12, y: 5 }]);
    expect(rest).toBe("");
  });

  it("parses a release", () => {
    const { events } = parseSgrMouse(sgr(0, 3, 7, "m"));

    expect(events).toEqual([{ kind: "release", button: 0, x: 3, y: 7 }]);
  });

  it("parses wheel up and wheel down", () => {
    const { events } = parseSgrMouse(sgr(64, 1, 1, "M") + sgr(65, 2, 2, "M"));

    expect(events).toEqual([
      { kind: "wheel", direction: "up", x: 1, y: 1 },
      { kind: "wheel", direction: "down", x: 2, y: 2 },
    ]);
  });

  it("parses multiple events in one chunk", () => {
    const { events } = parseSgrMouse(sgr(0, 1, 1, "M") + sgr(0, 1, 1, "m"));

    expect(events).toHaveLength(2);
    expect(events[0].kind).toBe("press");
    expect(events[1].kind).toBe("release");
  });

  it("carries a partial sequence across chunks via rest", () => {
    const full = sgr(0, 10, 3, "M");
    const first = parseSgrMouse(full.slice(0, 6));

    expect(first.events).toEqual([]);
    expect(first.rest).toBe(full.slice(0, 6));

    const second = parseSgrMouse(first.rest + full.slice(6));

    expect(second.events).toEqual([{ kind: "press", button: 0, x: 10, y: 3 }]);
    expect(second.rest).toBe("");
  });

  it("ignores keyboard bytes interleaved with mouse sequences", () => {
    const { events, rest } = parseSgrMouse(`a${sgr(0, 2, 2, "M")}b`);

    expect(events).toEqual([{ kind: "press", button: 0, x: 2, y: 2 }]);
    expect(rest).toBe("");
  });

  it("does not treat a non-mouse escape sequence as a partial", () => {
    // Arrow-up key: ESC [ A — complete and not SGR, so nothing is buffered.
    const { events, rest } = parseSgrMouse(`${ESC}[A`);

    expect(events).toEqual([]);
    expect(rest).toBe("");
  });

  it("reports non-left buttons distinctly", () => {
    const { events } = parseSgrMouse(sgr(2, 4, 4, "M"));

    expect(events).toEqual([{ kind: "press", button: 2, x: 4, y: 4 }]);
  });
});

describe("hitTest", () => {
  const rect = { left: 2, top: 1, width: 5, height: 2 };

  it("hits inside the rect (1-based SGR to 0-based rect)", () => {
    // Terminal column 3 = layout column 2 = rect.left.
    expect(hitTest(rect, 3, 2)).toBe(true);
  });

  it("hits the bottom-right corner", () => {
    // Layout col 6 (= left + width - 1), row 2 (= top + height - 1).
    expect(hitTest(rect, 7, 3)).toBe(true);
  });

  it("misses just outside each edge", () => {
    expect(hitTest(rect, 2, 2)).toBe(false); // left of rect
    expect(hitTest(rect, 8, 2)).toBe(false); // right of rect
    expect(hitTest(rect, 3, 1)).toBe(false); // above rect
    expect(hitTest(rect, 3, 4)).toBe(false); // below rect
  });
});
