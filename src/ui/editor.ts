/**
 * Cursor-aware editing model shared by the text prompts (InlinePrompt,
 * MultilinePrompt, ChatApp's input): a plain string plus a code-point cursor
 * index, driven by pure functions so tests exercise every key combination
 * without Ink. Every motion/edit returns the SAME state object when nothing
 * changes, letting React bail out of re-renders for ignored keys.
 */

import { cursorRowCol, normalizeInsert } from "./text-buffer.js";

export type EditorState = {
  text: string;
  /** Code-point index into `text`, 0..codePointLength (end = append). */
  cursor: number;
};

/**
 * The subset of Ink's `Key` booleans the editor reads. All optional and
 * structural so Ink's `Key` is assignable and tests can pass partial fakes.
 */
export type EditorKey = {
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  pageDown?: boolean;
  pageUp?: boolean;
  return?: boolean;
  escape?: boolean;
  ctrl?: boolean;
  shift?: boolean;
  tab?: boolean;
  backspace?: boolean;
  delete?: boolean;
  meta?: boolean;
};

/** Initial state for a prompt: cursor at the end of any prefilled text. */
export function makeEditorState(text: string): EditorState {
  return { text, cursor: Array.from(text).length };
}

/** Word characters for word-wise motions (readline/macOS-like). */
function isWordChar(char: string): boolean {
  return /[\p{L}\p{N}_]/u.test(char);
}

export function moveLeft(state: EditorState): EditorState {
  return state.cursor > 0 ? { ...state, cursor: state.cursor - 1 } : state;
}

export function moveRight(state: EditorState): EditorState {
  return state.cursor < Array.from(state.text).length
    ? { ...state, cursor: state.cursor + 1 }
    : state;
}

/** Skips separators, then the word to its start (readline backward-word). */
export function moveWordLeft(state: EditorState): EditorState {
  const chars = Array.from(state.text);
  let i = Math.min(state.cursor, chars.length);

  while (i > 0 && !isWordChar(chars[i - 1] ?? "")) {
    i -= 1;
  }
  while (i > 0 && isWordChar(chars[i - 1] ?? "")) {
    i -= 1;
  }

  return i === state.cursor ? state : { ...state, cursor: i };
}

/** Skips separators, then the word to its end (readline forward-word). */
export function moveWordRight(state: EditorState): EditorState {
  const chars = Array.from(state.text);
  let i = Math.max(state.cursor, 0);

  while (i < chars.length && !isWordChar(chars[i] ?? "")) {
    i += 1;
  }
  while (i < chars.length && isWordChar(chars[i] ?? "")) {
    i += 1;
  }

  return i === state.cursor ? state : { ...state, cursor: i };
}

/** Start of the cursor's logical line (readline ctrl+a). */
export function moveLineStart(state: EditorState): EditorState {
  const chars = Array.from(state.text);
  let i = Math.min(state.cursor, chars.length);

  while (i > 0 && chars[i - 1] !== "\n") {
    i -= 1;
  }

  return i === state.cursor ? state : { ...state, cursor: i };
}

/** End of the cursor's logical line (readline ctrl+e). */
export function moveLineEnd(state: EditorState): EditorState {
  const chars = Array.from(state.text);
  let i = Math.max(state.cursor, 0);

  while (i < chars.length && chars[i] !== "\n") {
    i += 1;
  }

  return i === state.cursor ? state : { ...state, cursor: i };
}

/** Cursor index of (row, col), with col clamped to that row's length. */
function cursorIndexAt(text: string, row: number, col: number): number {
  const chars = Array.from(text);
  let index = 0;
  let currentRow = 0;

  while (currentRow < row && index < chars.length) {
    if (chars[index] === "\n") {
      currentRow += 1;
    }
    index += 1;
  }

  let remaining = col;

  while (remaining > 0 && index < chars.length && chars[index] !== "\n") {
    index += 1;
    remaining -= 1;
  }

  return index;
}

/** Up one logical line, column clamped to the shorter target line. */
export function moveUp(state: EditorState): EditorState {
  const { row, col } = cursorRowCol(state.text, state.cursor);

  if (row === 0) {
    return state;
  }

  const cursor = cursorIndexAt(state.text, row - 1, col);

  return cursor === state.cursor ? state : { ...state, cursor };
}

/** Down one logical line, column clamped to the shorter target line. */
export function moveDown(state: EditorState): EditorState {
  const { row, col } = cursorRowCol(state.text, state.cursor);
  const lastRow = state.text.split("\n").length - 1;

  if (row >= lastRow) {
    return state;
  }

  const cursor = cursorIndexAt(state.text, row + 1, col);

  return cursor === state.cursor ? state : { ...state, cursor };
}

/**
 * Deletes the code point left of the cursor (emoji are never split into a
 * lone surrogate); deleting a \n joins lines.
 */
export function deleteCharLeft(state: EditorState): EditorState {
  if (state.cursor === 0) {
    return state;
  }

  const chars = Array.from(state.text);

  chars.splice(state.cursor - 1, 1);
  return { text: chars.join(""), cursor: state.cursor - 1 };
}

/** Deletes from the previous word start to the cursor (option+backspace). */
export function deleteWordLeft(state: EditorState): EditorState {
  const target = moveWordLeft(state);

  if (target === state) {
    return state;
  }

  const chars = Array.from(state.text);

  chars.splice(target.cursor, state.cursor - target.cursor);
  return { text: chars.join(""), cursor: target.cursor };
}

/** Deletes from the cursor to the next word end (esc+d forward delete). */
export function deleteWordRight(state: EditorState): EditorState {
  const target = moveWordRight(state);

  if (target === state) {
    return state;
  }

  const chars = Array.from(state.text);

  chars.splice(state.cursor, target.cursor - state.cursor);
  return { text: chars.join(""), cursor: state.cursor };
}

/**
 * Inserts typed or pasted input at the cursor after normalization. Joins
 * slices rather than `splice(..., ...insert)`: a coalesced paste can carry
 * more code points than the argument limit, and the spread would blow the
 * stack (RangeError) on exactly the large paste this path exists to serve.
 */
export function insertAt(
  state: EditorState,
  raw: string,
  multiline: boolean,
): EditorState {
  const insert = normalizeInsert(raw, multiline);
  const length = Array.from(insert).length;

  if (length === 0) {
    return state;
  }

  const chars = Array.from(state.text);

  return {
    text:
      chars.slice(0, state.cursor).join("") +
      insert +
      chars.slice(state.cursor).join(""),
    cursor: state.cursor + length,
  };
}

/**
 * Splits a single line for caret rendering: the text before the cursor, the
 * character under it (an inverse space when the cursor sits past the end),
 * and the rest. Code-point safe so the caret never lands inside an emoji.
 */
export function caretSplit(
  line: string,
  col: number,
): { before: string; at: string; after: string } {
  const chars = Array.from(line);
  const clamped = Math.min(Math.max(col, 0), chars.length);

  return {
    before: chars.slice(0, clamped).join(""),
    at: clamped < chars.length ? (chars[clamped] ?? " ") : " ",
    after: chars.slice(clamped + 1).join(""),
  };
}

/**
 * Caret layout for masked (secret) input: asterisk counts around the caret,
 * windowed to at most `cap` mask characters so long secrets cannot blow out
 * the prompt box while the caret always stays visible.
 */
export function maskedView(
  length: number,
  cursor: number,
  cap: number,
): { before: number; at: string; after: number } {
  const clamped = Math.min(Math.max(cursor, 0), length);
  const at = clamped < length ? "*" : " ";

  if (length <= cap) {
    return { before: clamped, at, after: Math.max(0, length - clamped - 1) };
  }

  const start = Math.min(Math.max(clamped - (cap - 1), 0), length - cap);
  const end = start + cap;

  return {
    before: clamped - start,
    at,
    after: clamped < length ? Math.max(0, end - clamped - 1) : 0,
  };
}

/**
 * True for SGR mouse sequences that Ink surfaces as literal text ("[<0;12;5M")
 * when mouse reporting is on — text prompts must never insert them. Matches
 * the full sequence shape so pasted text that merely starts with "[<" passes.
 */
export function isMouseNoise(value: string): boolean {
  return /^\[<\d+;\d+;\d+[Mm]/u.test(value);
}

/**
 * Shared keydown handler for the text prompts. Callers run their own
 * branches first (escape/enter submit, ctrl+d, focus guards) and delegate
 * everything else here. Returns the same state object for keys it refuses
 * (`handled: false`) so unknown special keys are guaranteed no-ops.
 *
 * Encodings handled (Ink 5 facts): option/alt+arrow arrives as arrow+meta
 * (xterm `\x1b[1;3D`) or as meta+"b"/"f" (terminals that send esc+b/f);
 * option+backspace arrives as meta+delete because macOS backspace is `\x7f`,
 * which Ink names "delete" — and option+fn+delete collapses onto the same
 * booleans, so both delete the word LEFT; forward word-delete is esc+d.
 * Unmodified fn+delete (`\x1b[3~`) also parses to key.delete, so it erases
 * backward like backspace — the two are indistinguishable here, and erasing
 * backward preserves the pre-cursor-model behavior. Esc-prefixed combos are
 * byte-identical to a coalesced Esc-then-letter chunk; that ambiguity is
 * inherent to option-as-meta encodings (readline has it too).
 * Plain escape also sets meta, so escape must bail out before any meta combo.
 */
export function handleEditingKey(
  state: EditorState,
  input: string,
  key: EditorKey,
  options: { multiline: boolean },
): { state: EditorState; handled: boolean } {
  if (key.escape || key.return || key.tab || key.pageUp || key.pageDown) {
    return { state, handled: false };
  }

  if (key.meta || key.ctrl) {
    // shift+option+arrow degrades to a plain word jump (no selection yet).
    if (key.leftArrow) {
      return { state: moveWordLeft(state), handled: true };
    }
    if (key.rightArrow) {
      return { state: moveWordRight(state), handled: true };
    }
  }

  if (key.meta && (key.backspace || key.delete)) {
    return { state: deleteWordLeft(state), handled: true };
  }

  if (key.meta) {
    if (input === "b") {
      return { state: moveWordLeft(state), handled: true };
    }
    if (input === "f") {
      return { state: moveWordRight(state), handled: true };
    }
    if (input === "d") {
      return { state: deleteWordRight(state), handled: true };
    }
  }

  if (key.ctrl) {
    if (input === "w") {
      return { state: deleteWordLeft(state), handled: true };
    }
    if (input === "a") {
      return { state: moveLineStart(state), handled: true };
    }
    if (input === "e") {
      return { state: moveLineEnd(state), handled: true };
    }
  }

  if (key.leftArrow) {
    return { state: moveLeft(state), handled: true };
  }
  if (key.rightArrow) {
    return { state: moveRight(state), handled: true };
  }

  if (key.upArrow || key.downArrow) {
    if (!options.multiline) {
      return { state, handled: false };
    }
    return {
      state: key.upArrow ? moveUp(state) : moveDown(state),
      handled: true,
    };
  }

  if (key.backspace || key.delete) {
    return { state: deleteCharLeft(state), handled: true };
  }

  if (input.length > 0 && !key.ctrl && !key.meta && !isMouseNoise(input)) {
    return { state: insertAt(state, input, options.multiline), handled: true };
  }

  return { state, handled: false };
}
