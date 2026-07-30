import { describe, expect, it } from "vitest";
import {
  caretSplit,
  deleteCharLeft,
  deleteWordLeft,
  deleteWordRight,
  handleEditingKey,
  insertAt,
  isMouseNoise,
  makeEditorState,
  maskedView,
  moveDown,
  moveLeft,
  moveLineEnd,
  moveLineStart,
  moveRight,
  moveUp,
  moveWordLeft,
  moveWordRight,
  type EditorState,
} from "../src/ui/editor.js";

function state(text: string, cursor: number): EditorState {
  return { text, cursor };
}

describe("makeEditorState", () => {
  it("seeds the cursor at the code-point end of prefilled text", () => {
    expect(makeEditorState("deploy 🚀")).toEqual({
      text: "deploy 🚀",
      cursor: 8,
    });
  });

  it("starts at zero for empty text", () => {
    expect(makeEditorState("")).toEqual({ text: "", cursor: 0 });
  });
});

describe("moveLeft/moveRight", () => {
  it("moves one code point at a time", () => {
    expect(moveLeft(state("ab", 2)).cursor).toBe(1);
    expect(moveRight(state("ab", 1)).cursor).toBe(2);
  });

  it("treats an emoji as a single step", () => {
    expect(moveLeft(state("a🚀", 2)).cursor).toBe(1);
    expect(moveRight(state("🚀b", 0)).cursor).toBe(1);
  });

  it("is an identity no-op at the boundaries", () => {
    const atStart = state("ab", 0);
    const atEnd = state("ab", 2);

    expect(moveLeft(atStart)).toBe(atStart);
    expect(moveRight(atEnd)).toBe(atEnd);
  });
});

describe("moveWordLeft/moveWordRight", () => {
  it("jumps to the start of the previous word", () => {
    expect(moveWordLeft(state("hello world", 11)).cursor).toBe(6);
    expect(moveWordLeft(state("hello world", 6)).cursor).toBe(0);
  });

  it("jumps to the end of the next word", () => {
    expect(moveWordRight(state("hello world", 0)).cursor).toBe(5);
    expect(moveWordRight(state("hello world", 5)).cursor).toBe(11);
  });

  it("treats punctuation runs as separators", () => {
    expect(moveWordLeft(state("foo--bar", 8)).cursor).toBe(5);
    expect(moveWordLeft(state("foo--bar", 5)).cursor).toBe(0);
    expect(moveWordRight(state("foo--bar", 3)).cursor).toBe(8);
  });

  it("counts underscores and digits as word characters", () => {
    expect(moveWordLeft(state("x foo_bar1", 10)).cursor).toBe(2);
  });

  it("handles accented and non-latin letters as word characters", () => {
    expect(moveWordLeft(state("café niño", 9)).cursor).toBe(5);
    expect(moveWordRight(state("café niño", 0)).cursor).toBe(4);
  });

  it("skips emoji like punctuation", () => {
    expect(moveWordLeft(state("a 🚀 b", 4)).cursor).toBe(0);
  });

  it("crosses newlines", () => {
    expect(moveWordLeft(state("one\ntwo", 4)).cursor).toBe(0);
    expect(moveWordRight(state("one\ntwo", 3)).cursor).toBe(7);
  });

  it("is an identity no-op at the boundaries and on empty text", () => {
    const atStart = state("hello", 0);
    const atEnd = state("hello", 5);
    const empty = state("", 0);

    expect(moveWordLeft(atStart)).toBe(atStart);
    expect(moveWordRight(atEnd)).toBe(atEnd);
    expect(moveWordLeft(empty)).toBe(empty);
    expect(moveWordRight(empty)).toBe(empty);
  });
});

describe("moveLineStart/moveLineEnd", () => {
  it("moves to the boundaries of the cursor's line", () => {
    expect(moveLineStart(state("hello", 3)).cursor).toBe(0);
    expect(moveLineEnd(state("hello", 3)).cursor).toBe(5);
  });

  it("stays within the current logical line", () => {
    expect(moveLineStart(state("ab\ncd", 4)).cursor).toBe(3);
    expect(moveLineEnd(state("ab\ncd", 3)).cursor).toBe(5);
    expect(moveLineEnd(state("ab\ncd", 0)).cursor).toBe(2);
  });

  it("is an identity no-op when already at the boundary", () => {
    const atStart = state("ab\ncd", 3);
    const atEnd = state("ab\ncd", 2);

    expect(moveLineStart(atStart)).toBe(atStart);
    expect(moveLineEnd(atEnd)).toBe(atEnd);
  });
});

describe("moveUp/moveDown", () => {
  it("moves between lines preserving the column", () => {
    expect(moveUp(state("abc\ndef", 5)).cursor).toBe(1);
    expect(moveDown(state("abc\ndef", 1)).cursor).toBe(5);
  });

  it("clamps the column on a shorter target line", () => {
    expect(moveUp(state("hi\nlonger", 9)).cursor).toBe(2);
    expect(moveDown(state("longer\nhi", 6)).cursor).toBe(9);
  });

  it("counts columns in code points on emoji lines", () => {
    expect(moveDown(state("🚀🚀🚀\nabc", 2)).cursor).toBe(6);
  });

  it("is an identity no-op on the first/last row", () => {
    const topRow = state("ab\ncd", 1);
    const bottomRow = state("ab\ncd", 4);

    expect(moveUp(topRow)).toBe(topRow);
    expect(moveDown(bottomRow)).toBe(bottomRow);
  });
});

describe("deleteCharLeft", () => {
  it("removes the code point left of the cursor", () => {
    expect(deleteCharLeft(state("abc", 3))).toEqual({
      text: "ab",
      cursor: 2,
    });
    expect(deleteCharLeft(state("abc", 1))).toEqual({
      text: "bc",
      cursor: 0,
    });
  });

  it("joins lines when deleting a newline", () => {
    expect(deleteCharLeft(state("line1\n", 6))).toEqual({
      text: "line1",
      cursor: 5,
    });
  });

  it("deletes a whole emoji instead of splitting its surrogate pair", () => {
    expect(deleteCharLeft(state("deploy 🚀", 8))).toEqual({
      text: "deploy ",
      cursor: 7,
    });
  });

  it("is an identity no-op at the start of text", () => {
    const atStart = state("abc", 0);

    expect(deleteCharLeft(atStart)).toBe(atStart);
  });
});

describe("deleteWordLeft/deleteWordRight", () => {
  it("deletes the word left of the cursor", () => {
    expect(deleteWordLeft(state("hello world", 11))).toEqual({
      text: "hello ",
      cursor: 6,
    });
  });

  it("deletes trailing separators together with the word", () => {
    expect(deleteWordLeft(state("hello world  ", 13))).toEqual({
      text: "hello ",
      cursor: 6,
    });
  });

  it("deletes the word right of the cursor", () => {
    expect(deleteWordRight(state("hello world", 5))).toEqual({
      text: "hello",
      cursor: 5,
    });
  });

  it("deletes across a newline", () => {
    expect(deleteWordLeft(state("one\ntwo", 7))).toEqual({
      text: "one\n",
      cursor: 4,
    });
    expect(deleteWordRight(state("one\ntwo", 3))).toEqual({
      text: "one",
      cursor: 3,
    });
  });

  it("deletes whole emoji", () => {
    expect(deleteWordLeft(state("hi 🚀🚀", 5))).toEqual({
      text: "",
      cursor: 0,
    });
  });

  it("is an identity no-op at the boundaries and on empty text", () => {
    const atStart = state("hello", 0);
    const atEnd = state("hello", 5);
    const empty = state("", 0);

    expect(deleteWordLeft(atStart)).toBe(atStart);
    expect(deleteWordRight(atEnd)).toBe(atEnd);
    expect(deleteWordLeft(empty)).toBe(empty);
    expect(deleteWordRight(empty)).toBe(empty);
  });
});

describe("insertAt", () => {
  it("inserts at the cursor and advances it", () => {
    expect(insertAt(state("ab", 1), "XY", false)).toEqual({
      text: "aXYb",
      cursor: 3,
    });
  });

  it("normalizes pasted CRLF line breaks mid-string in multiline mode", () => {
    expect(insertAt(state("ab", 1), "one\r\ntwo", true)).toEqual({
      text: "aone\ntwob",
      cursor: 8,
    });
  });

  it("flattens newlines to a space in single-line mode", () => {
    expect(insertAt(state("ab", 1), "1\n2", false)).toEqual({
      text: "a1 2b",
      cursor: 4,
    });
  });

  it("inserts a paste larger than the argument limit without overflowing", () => {
    // Guards the splice-with-spread this used to do: a coalesced paste can
    // carry more code points than a call's argument list can hold.
    const huge = "x".repeat(200_000);
    const result = insertAt(state("ab", 1), huge, true);

    expect(result.text.length).toBe(200_002);
    expect(result.cursor).toBe(200_001);
    expect(result.text.startsWith("ax")).toBe(true);
    expect(result.text.endsWith("xb")).toBe(true);
  });

  it("expands tabs and drops other control characters", () => {
    const bel = String.fromCharCode(7);

    expect(insertAt(state("", 0), `a\tb${bel}c`, true)).toEqual({
      text: "a  bc",
      cursor: 5,
    });
  });

  it("advances the cursor by code points for emoji pastes", () => {
    expect(insertAt(state("ab", 1), "🚀🚀", true)).toEqual({
      text: "a🚀🚀b",
      cursor: 3,
    });
  });

  it("is an identity no-op when nothing survives normalization", () => {
    const current = state("ab", 1);

    expect(insertAt(current, String.fromCharCode(7), false)).toBe(current);
    expect(insertAt(current, "", true)).toBe(current);
  });
});

describe("caretSplit", () => {
  it("splits around the character under the cursor", () => {
    expect(caretSplit("hello", 2)).toEqual({
      before: "he",
      at: "l",
      after: "lo",
    });
  });

  it("handles the start of the line", () => {
    expect(caretSplit("hello", 0)).toEqual({
      before: "",
      at: "h",
      after: "ello",
    });
  });

  it("uses a space caret past the end of the line", () => {
    expect(caretSplit("hello", 5)).toEqual({
      before: "hello",
      at: " ",
      after: "",
    });
    expect(caretSplit("", 0)).toEqual({ before: "", at: " ", after: "" });
  });

  it("keeps an emoji under the caret whole", () => {
    expect(caretSplit("a🚀b", 1)).toEqual({
      before: "a",
      at: "🚀",
      after: "b",
    });
  });
});

describe("maskedView", () => {
  it("shows every mask character when under the cap", () => {
    expect(maskedView(5, 2, 40)).toEqual({ before: 2, at: "*", after: 2 });
    expect(maskedView(5, 5, 40)).toEqual({ before: 5, at: " ", after: 0 });
    expect(maskedView(0, 0, 40)).toEqual({ before: 0, at: " ", after: 0 });
  });

  it("windows long secrets while keeping the caret visible", () => {
    expect(maskedView(100, 0, 40)).toEqual({ before: 0, at: "*", after: 39 });
    expect(maskedView(100, 100, 40)).toEqual({
      before: 40,
      at: " ",
      after: 0,
    });
    expect(maskedView(100, 50, 40)).toEqual({ before: 39, at: "*", after: 0 });
  });

  it("never renders wider than the cap plus the caret cell", () => {
    for (const cursor of [0, 1, 39, 40, 73, 99, 100]) {
      const view = maskedView(100, cursor, 40);

      expect(view.before + 1 + view.after).toBeLessThanOrEqual(41);
    }
  });
});

describe("isMouseNoise", () => {
  it("matches SGR mouse sequences and not ordinary pastes", () => {
    expect(isMouseNoise("[<0;12;5M")).toBe(true);
    expect(isMouseNoise("[<65;3;9m")).toBe(true);
    expect(isMouseNoise("[<not a mouse")).toBe(false);
    expect(isMouseNoise("plain text")).toBe(false);
  });
});

describe("handleEditingKey", () => {
  const multi = { multiline: true };
  const single = { multiline: false };

  it("word-jumps on meta+arrow (option/alt+arrow)", () => {
    const result = handleEditingKey(
      state("hello world", 11),
      "",
      { leftArrow: true, meta: true },
      single,
    );

    expect(result).toMatchObject({ handled: true });
    expect(result.state.cursor).toBe(6);

    const right = handleEditingKey(
      state("hello world", 0),
      "",
      { rightArrow: true, meta: true },
      single,
    );

    expect(right.state.cursor).toBe(5);
  });

  it("word-jumps on ctrl+arrow (linux/windows terminals)", () => {
    const result = handleEditingKey(
      state("hello world", 11),
      "",
      { leftArrow: true, ctrl: true },
      single,
    );

    expect(result.state.cursor).toBe(6);
  });

  it("degrades shift+meta+arrow to a plain word jump (no selection)", () => {
    const result = handleEditingKey(
      state("hello world", 11),
      "",
      { leftArrow: true, meta: true, shift: true },
      single,
    );

    expect(result).toMatchObject({ handled: true });
    expect(result.state.cursor).toBe(6);
  });

  it("word-jumps on esc+b / esc+f (option-as-meta terminals)", () => {
    const left = handleEditingKey(
      state("hello world", 11),
      "b",
      { meta: true },
      single,
    );
    const right = handleEditingKey(
      state("hello world", 0),
      "f",
      { meta: true },
      single,
    );

    expect(left.state.cursor).toBe(6);
    expect(right.state.cursor).toBe(5);
  });

  it("still inserts plain letters used by the word-motion combos", () => {
    for (const letter of ["b", "f", "d", "w", "a", "e"]) {
      const result = handleEditingKey(state("x", 1), letter, {}, single);

      expect(result.state.text).toBe(`x${letter}`);
    }
  });

  it("deletes the word left on meta+backspace and meta+delete", () => {
    const viaBackspace = handleEditingKey(
      state("hello world", 11),
      "",
      { backspace: true, meta: true },
      single,
    );
    const viaDelete = handleEditingKey(
      state("hello world", 11),
      "",
      { delete: true, meta: true },
      single,
    );

    expect(viaBackspace.state).toEqual({ text: "hello ", cursor: 6 });
    expect(viaDelete.state).toEqual({ text: "hello ", cursor: 6 });
  });

  it("deletes the word left on ctrl+w", () => {
    const result = handleEditingKey(
      state("hello world", 11),
      "w",
      { ctrl: true },
      single,
    );

    expect(result.state).toEqual({ text: "hello ", cursor: 6 });
  });

  it("deletes the word right on esc+d", () => {
    const result = handleEditingKey(
      state("hello world", 5),
      "d",
      { meta: true },
      single,
    );

    expect(result.state).toEqual({ text: "hello", cursor: 5 });
  });

  it("leaves ctrl+d alone (multiline submit key)", () => {
    const current = state("hello", 5);
    const result = handleEditingKey(current, "d", { ctrl: true }, multi);

    expect(result.handled).toBe(false);
    expect(result.state).toBe(current);
  });

  it("moves by one character on plain arrows", () => {
    const left = handleEditingKey(
      state("ab", 2),
      "",
      { leftArrow: true },
      single,
    );
    const right = handleEditingKey(
      state("ab", 0),
      "",
      { rightArrow: true },
      single,
    );

    expect(left.state.cursor).toBe(1);
    expect(right.state.cursor).toBe(1);
  });

  it("moves to line start/end on ctrl+a / ctrl+e", () => {
    const start = handleEditingKey(
      state("hello", 3),
      "a",
      { ctrl: true },
      single,
    );
    const end = handleEditingKey(
      state("hello", 3),
      "e",
      { ctrl: true },
      single,
    );

    expect(start.state.cursor).toBe(0);
    expect(end.state.cursor).toBe(5);
  });

  it("moves between lines on up/down only in multiline mode", () => {
    const up = handleEditingKey(
      state("ab\ncd", 4),
      "",
      { upArrow: true },
      multi,
    );

    expect(up).toMatchObject({ handled: true });
    expect(up.state.cursor).toBe(1);

    const singleLine = state("ab", 1);
    const refused = handleEditingKey(singleLine, "", { upArrow: true }, single);

    expect(refused.handled).toBe(false);
    expect(refused.state).toBe(singleLine);
  });

  it("deletes one character on unmodified backspace/delete", () => {
    const viaBackspace = handleEditingKey(
      state("abc", 3),
      "",
      { backspace: true },
      single,
    );
    const viaDelete = handleEditingKey(
      state("abc", 3),
      "",
      { delete: true },
      single,
    );

    expect(viaBackspace.state).toEqual({ text: "ab", cursor: 2 });
    expect(viaDelete.state).toEqual({ text: "ab", cursor: 2 });
  });

  it("inserts typed text at the cursor", () => {
    const result = handleEditingKey(state("ab", 1), "X", {}, single);

    expect(result.state).toEqual({ text: "aXb", cursor: 2 });
  });

  it("inserts pastes with newlines at a mid-string cursor", () => {
    const result = handleEditingKey(state("ab", 1), "one\r\ntwo", {}, multi);

    expect(result.state).toEqual({ text: "aone\ntwob", cursor: 8 });
  });

  it("ignores special keys that arrive as empty input (home/end/F-keys)", () => {
    const current = state("abc", 3);
    const result = handleEditingKey(current, "", {}, single);

    expect(result.handled).toBe(false);
    expect(result.state).toBe(current);
  });

  it("never inserts mouse noise", () => {
    const current = state("abc", 3);
    const result = handleEditingKey(current, "[<0;12;5M", {}, single);

    expect(result.handled).toBe(false);
    expect(result.state).toBe(current);
  });

  it("never inserts meta-modified characters", () => {
    const current = state("abc", 3);
    const result = handleEditingKey(current, "x", { meta: true }, single);

    expect(result.handled).toBe(false);
    expect(result.state).toBe(current);
  });

  it("refuses the keys owned by the components", () => {
    const current = state("abc", 3);

    for (const key of [
      { return: true },
      { escape: true, meta: true },
      { tab: true },
      { pageUp: true },
      { pageDown: true },
    ]) {
      const result = handleEditingKey(current, "", key, multi);

      expect(result.handled).toBe(false);
      expect(result.state).toBe(current);
    }
  });
});
