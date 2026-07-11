import { describe, expect, it } from "vitest";
import {
  appendInput,
  deleteLast,
  visibleTail,
  wrapLines,
} from "../src/ui/text-buffer.js";

describe("appendInput", () => {
  it("appends plain text", () => {
    expect(appendInput("ab", "cd")).toBe("abcd");
  });

  it("normalizes CRLF and CR to \\n (pasted text keeps its line breaks)", () => {
    expect(appendInput("", "one\r\ntwo\rthree")).toBe("one\ntwo\nthree");
  });

  it("expands tabs and drops other control characters", () => {
    const bel = String.fromCharCode(7);
    const esc = String.fromCharCode(27);

    expect(appendInput("", `a\tb${bel}c${esc}[31md`)).toBe("a  bc[31md");
  });

  it("keeps existing newlines when appending more input", () => {
    expect(appendInput("line1\n", "line2")).toBe("line1\nline2");
  });
});

describe("deleteLast", () => {
  it("removes the last character", () => {
    expect(deleteLast("abc")).toBe("ab");
  });

  it("joins lines when the last character is a newline", () => {
    expect(deleteLast("line1\n")).toBe("line1");
  });

  it("deletes a whole emoji instead of splitting its surrogate pair", () => {
    expect(deleteLast("deploy 🚀")).toBe("deploy ");
  });

  it("is a no-op on an empty string", () => {
    expect(deleteLast("")).toBe("");
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
