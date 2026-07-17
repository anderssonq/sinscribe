import { describe, expect, it } from "vitest";
import {
  cursorRowCol,
  normalizeInsert,
  visibleTail,
  visibleWindow,
  wrapLines,
} from "../src/ui/text-buffer.js";

describe("normalizeInsert", () => {
  it("normalizes CRLF and CR to \\n in multiline mode", () => {
    expect(normalizeInsert("one\r\ntwo\rthree", true)).toBe("one\ntwo\nthree");
  });

  it("drops newlines in single-line mode", () => {
    expect(normalizeInsert("one\r\ntwo\rthree", false)).toBe("onetwothree");
  });

  it("expands tabs and drops other control characters", () => {
    const bel = String.fromCharCode(7);
    const esc = String.fromCharCode(27);

    expect(normalizeInsert(`a\tb${bel}c${esc}[31md`, true)).toBe("a  bc[31md");
  });
});

describe("cursorRowCol", () => {
  it("is the origin for empty text", () => {
    expect(cursorRowCol("", 0)).toEqual({ row: 0, col: 0 });
  });

  it("counts columns within a row", () => {
    expect(cursorRowCol("ab\ncd", 2)).toEqual({ row: 0, col: 2 });
  });

  it("starts the next row after a newline", () => {
    expect(cursorRowCol("ab\ncd", 3)).toEqual({ row: 1, col: 0 });
    expect(cursorRowCol("a\n", 2)).toEqual({ row: 1, col: 0 });
  });

  it("counts columns in code points", () => {
    expect(cursorRowCol("🚀x", 2)).toEqual({ row: 0, col: 2 });
  });
});

describe("visibleWindow", () => {
  it("anchors to the bottom on first render, like visibleTail", () => {
    expect(visibleWindow("a\nb\nc\nd", 7, 2, Infinity)).toEqual({
      lines: ["c", "d"],
      start: 2,
      hiddenAbove: 2,
      hiddenBelow: 0,
      cursorRow: 1,
      cursorCol: 1,
    });
  });

  it("shows everything when the text fits", () => {
    expect(visibleWindow("a\nb", 3, 6, Infinity)).toEqual({
      lines: ["a", "b"],
      start: 0,
      hiddenAbove: 0,
      hiddenBelow: 0,
      cursorRow: 1,
      cursorCol: 1,
    });
  });

  it("treats empty text as one empty line", () => {
    expect(visibleWindow("", 0, 3, Infinity)).toEqual({
      lines: [""],
      start: 0,
      hiddenAbove: 0,
      hiddenBelow: 0,
      cursorRow: 0,
      cursorCol: 0,
    });
  });

  it("shows the trailing empty line after a newline (cursor row)", () => {
    expect(visibleWindow("a\n", 2, 3, Infinity)).toEqual({
      lines: ["a", ""],
      start: 0,
      hiddenAbove: 0,
      hiddenBelow: 0,
      cursorRow: 1,
      cursorCol: 0,
    });
  });

  it("scrolls up when the cursor moves above the window", () => {
    expect(visibleWindow("a\nb\nc\nd", 0, 2, 2)).toEqual({
      lines: ["a", "b"],
      start: 0,
      hiddenAbove: 0,
      hiddenBelow: 2,
      cursorRow: 0,
      cursorCol: 0,
    });
  });

  it("scrolls down when the cursor moves below the window", () => {
    expect(visibleWindow("a\nb\nc\nd", 7, 2, 0)).toEqual({
      lines: ["c", "d"],
      start: 2,
      hiddenAbove: 2,
      hiddenBelow: 0,
      cursorRow: 1,
      cursorCol: 1,
    });
  });

  it("keeps the window still while the cursor moves inside it", () => {
    expect(visibleWindow("a\nb\nc\nd", 3, 2, 1)).toEqual({
      lines: ["b", "c"],
      start: 1,
      hiddenAbove: 1,
      hiddenBelow: 1,
      cursorRow: 0,
      cursorCol: 1,
    });
  });
});

describe("visibleTail", () => {
  it("returns all lines when under the viewport", () => {
    expect(visibleTail("a\nb", 6)).toEqual({ lines: ["a", "b"], hidden: 0 });
  });

  it("returns the last N lines and counts the hidden ones", () => {
    expect(visibleTail("a\nb\nc\nd", 2)).toEqual({
      lines: ["c", "d"],
      hidden: 2,
    });
  });

  it("treats an empty string as one empty line", () => {
    expect(visibleTail("", 3)).toEqual({ lines: [""], hidden: 0 });
  });

  it("shows the trailing empty line after a newline (cursor row)", () => {
    expect(visibleTail("a\n", 3)).toEqual({ lines: ["a", ""], hidden: 0 });
  });
});

describe("wrapLines", () => {
  it("passes through lines already within the width", () => {
    expect(wrapLines("short\nalso fine", 20)).toEqual(["short", "also fine"]);
  });

  it("preserves blank lines as separators", () => {
    expect(wrapLines("a\n\nb", 20)).toEqual(["a", "", "b"]);
  });

  it("wraps on word boundaries", () => {
    expect(wrapLines("one two three four", 8)).toEqual([
      "one two",
      "three",
      "four",
    ]);
  });

  it("hangs continuation rows under the original indent", () => {
    // A reflowed line collapses its internal runs of spaces to one.
    expect(wrapLines("  flag   describes the flag here", 16)).toEqual([
      "  flag describes",
      "  the flag here",
    ]);
  });

  it("hard-breaks a single word too long to ever fit", () => {
    expect(wrapLines("supercalifragilistic", 8)).toEqual([
      "supercal",
      "ifragili",
      "stic",
    ]);
  });

  it("keeps every emitted row within the width", () => {
    const help = [
      "  pr        --template <name>   Template to use (default: andersoftware)",
      "            --base <ref>        Target branch to diff against, else auto-detect",
    ].join("\n");

    for (const width of [24, 40, 60, 80]) {
      for (const row of wrapLines(help, width)) {
        expect(row.length).toBeLessThanOrEqual(width);
      }
    }
  });

  it("returns the raw split when width is non-positive", () => {
    expect(wrapLines("a b c\nd e f", 0)).toEqual(["a b c", "d e f"]);
  });
});
