import { describe, expect, it } from "vitest";
import {
  cursorRowCol,
  normalizeInsert,
  visibleRowWindow,
  visibleSlice,
  visibleTail,
  wrapLines,
  wrapRows,
} from "../src/ui/text-buffer.js";

describe("normalizeInsert", () => {
  it("normalizes CRLF and CR to \\n in multiline mode", () => {
    expect(normalizeInsert("one\r\ntwo\rthree", true)).toBe("one\ntwo\nthree");
  });

  it("flattens newlines to a space in single-line mode", () => {
    expect(normalizeInsert("one\r\ntwo\rthree", false)).toBe("one two three");
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

describe("wrapRows", () => {
  it("passes through a line already within the width", () => {
    expect(wrapRows("short", 20)).toEqual([
      { text: "short", start: 0, end: 5 },
    ]);
  });

  it("breaks after the last space that fits, keeping the space", () => {
    expect(wrapRows("one two three", 8).map((row) => row.text)).toEqual([
      "one two ",
      "three",
    ]);
  });

  it("hard-breaks a word too long to ever fit", () => {
    expect(wrapRows("supercalifragilistic", 8).map((row) => row.text)).toEqual([
      "supercal",
      "ifragili",
      "stic",
    ]);
  });

  it("keeps every row within the width", () => {
    const text =
      "Given: the KPI Counter View is configured in Current Demand mode " +
      "and it has from 1 to 15 KPIs for S/M/L/XL font size";

    for (const width of [8, 24, 40, 76]) {
      for (const row of wrapRows(text, width)) {
        expect(Array.from(row.text).length).toBeLessThanOrEqual(width);
      }
    }
  });

  it("is lossless: rows rejoin the source, only newlines consumed", () => {
    const text = "one two three\n\n  indented paragraph that wraps\nlast";

    for (const width of [4, 9, 20]) {
      expect(
        wrapRows(text, width)
          .map((row) => row.text)
          .join(""),
      ).toBe(text.replaceAll("\n", ""));
    }
  });

  it("reports code-point offsets that slice back to each row", () => {
    const text = "one two three";

    for (const row of wrapRows(text, 8)) {
      expect(Array.from(text).slice(row.start, row.end).join("")).toBe(
        row.text,
      );
    }
  });

  it("keeps blank lines and a trailing newline as their own rows", () => {
    expect(wrapRows("a\n\nb", 20).map((row) => row.text)).toEqual([
      "a",
      "",
      "b",
    ]);
    expect(wrapRows("a\n", 20)).toEqual([
      { text: "a", start: 0, end: 1 },
      { text: "", start: 2, end: 2 },
    ]);
  });

  it("treats empty text as one empty row", () => {
    expect(wrapRows("", 20)).toEqual([{ text: "", start: 0, end: 0 }]);
  });

  it("counts emoji as one code point and never splits them", () => {
    expect(wrapRows("🚀🚀🚀🚀", 2).map((row) => row.text)).toEqual([
      "🚀🚀",
      "🚀🚀",
    ]);
  });

  it("returns the raw split when width is non-positive", () => {
    expect(wrapRows("a b c\nd e f", 0).map((row) => row.text)).toEqual([
      "a b c",
      "d e f",
    ]);
  });
});

describe("visibleRowWindow", () => {
  it("anchors to the bottom on first render, like visibleTail", () => {
    expect(visibleRowWindow("a\nb\nc\nd", 7, 20, 2, Infinity)).toEqual({
      rows: ["c", "d"],
      start: 2,
      hiddenAbove: 2,
      hiddenBelow: 0,
      cursorRow: 1,
      cursorCol: 1,
      totalRows: 4,
    });
  });

  it("shows everything when the text fits", () => {
    expect(visibleRowWindow("a\nb", 3, 20, 6, Infinity)).toEqual({
      rows: ["a", "b"],
      start: 0,
      hiddenAbove: 0,
      hiddenBelow: 0,
      cursorRow: 1,
      cursorCol: 1,
      totalRows: 2,
    });
  });

  it("treats empty text as one empty row", () => {
    expect(visibleRowWindow("", 0, 20, 3, Infinity)).toEqual({
      rows: [""],
      start: 0,
      hiddenAbove: 0,
      hiddenBelow: 0,
      cursorRow: 0,
      cursorCol: 0,
      totalRows: 1,
    });
  });

  it("shows the trailing empty row after a newline (cursor row)", () => {
    expect(visibleRowWindow("a\n", 2, 20, 3, Infinity)).toEqual({
      rows: ["a", ""],
      start: 0,
      hiddenAbove: 0,
      hiddenBelow: 0,
      cursorRow: 1,
      cursorCol: 0,
      totalRows: 2,
    });
  });

  it("scrolls up when the cursor moves above the window", () => {
    expect(visibleRowWindow("a\nb\nc\nd", 0, 20, 2, 2)).toEqual({
      rows: ["a", "b"],
      start: 0,
      hiddenAbove: 0,
      hiddenBelow: 2,
      cursorRow: 0,
      cursorCol: 0,
      totalRows: 4,
    });
  });

  it("keeps the window still while the cursor moves inside it", () => {
    expect(visibleRowWindow("a\nb\nc\nd", 3, 20, 2, 1)).toEqual({
      rows: ["b", "c"],
      start: 1,
      hiddenAbove: 1,
      hiddenBelow: 1,
      cursorRow: 0,
      cursorCol: 1,
      totalRows: 4,
    });
  });

  it("windows one long logical line by its wrapped rows", () => {
    // The paste case: no newline anywhere, so a line-counting window would
    // have handed the whole thing to the renderer.
    const view = visibleRowWindow("one two three four", 18, 8, 2, Infinity);

    expect(view.totalRows).toBe(3);
    expect(view.rows).toEqual(["three ", "four"]);
    expect(view.hiddenAbove).toBe(1);
    expect(view.cursorRow).toBe(1);
    expect(view.cursorCol).toBe(4);
  });

  it("puts a cursor on a wrap boundary at the start of the next row", () => {
    // Column 0 of row 1, never one column past row 0's edge — that would draw
    // the caret outside the box.
    const view = visibleRowWindow("one two three", 8, 8, 4, Infinity);

    expect(view.cursorRow).toBe(1);
    expect(view.cursorCol).toBe(0);
  });

  it("keeps a cursor just before the break space on its own row", () => {
    const view = visibleRowWindow("one two three", 7, 8, 4, Infinity);

    expect(view.cursorRow).toBe(0);
    expect(view.cursorCol).toBe(7);
  });

  it("clamps a stale start and still follows the cursor", () => {
    const view = visibleRowWindow("a\nb\nc\nd", 0, 20, 2, 99);

    expect(view.start).toBe(0);
    expect(view.cursorRow).toBe(0);
  });
});

describe("visibleSlice", () => {
  it("shows the whole value when it fits", () => {
    expect(visibleSlice("hello", 5, 20, Infinity)).toEqual({
      text: "hello",
      cursorCol: 5,
      hiddenLeft: 0,
      hiddenRight: 0,
    });
  });

  it("anchors to the end, leaving the last column for the append caret", () => {
    const view = visibleSlice("abcdefghij", 10, 4, Infinity);

    // Three characters plus the caret = the four columns asked for.
    expect(view.text).toBe("hij");
    expect(view.cursorCol).toBe(3);
    expect(view.hiddenLeft).toBe(7);
    expect(view.hiddenRight).toBe(0);
  });

  it("scrolls left when the cursor moves out of the window", () => {
    const view = visibleSlice("abcdefghij", 1, 4, 6);

    expect(view.text).toBe("bcde");
    expect(view.cursorCol).toBe(0);
    expect(view.hiddenLeft).toBe(1);
    expect(view.hiddenRight).toBe(5);
  });

  it("never renders more columns than the width, however long the value", () => {
    const long = "x".repeat(5000);

    for (const cursor of [0, 2500, 5000]) {
      const view = visibleSlice(long, cursor, 30, Infinity);

      expect(Array.from(view.text).length).toBeLessThanOrEqual(30);
      expect(view.cursorCol).toBeLessThanOrEqual(29);
    }
  });

  it("counts emoji as single code points", () => {
    const view = visibleSlice("🚀🚀🚀🚀", 4, 2, Infinity);

    expect(view.text).toBe("🚀");
    expect(view.cursorCol).toBe(1);
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
