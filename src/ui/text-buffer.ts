/** Pure text and viewport helpers for the prompt components. */

/**
 * Normalizes typed or pasted input before insertion: CRLF/CR normalize to
 * \n, tabs become two spaces, and other control characters are dropped.
 * Single-line prompts (`multiline: false`) drop newlines too.
 */
export function normalizeInsert(input: string, multiline: boolean): string {
  const normalized = input
    .replace(/\r\n/gu, "\n")
    .replace(/\r/gu, "\n")
    .replace(/\t/gu, "  ");

  let kept = "";

  for (const char of normalized) {
    if (char === "\n") {
      if (multiline) {
        kept += char;
      }
      continue;
    }

    const code = char.codePointAt(0) ?? 0;

    if (code >= 32 && code !== 127) {
      kept += char;
    }
  }

  return kept;
}

/** Bottom-anchored viewport: the last `visible` lines + hidden-above count. */
export function visibleTail(
  text: string,
  visible: number,
): { lines: string[]; hidden: number } {
  const lines = text.split("\n");
  const hidden = Math.max(0, lines.length - visible);

  return { lines: lines.slice(hidden), hidden };
}

/** Logical row and column (both in code points) of a cursor index. */
export function cursorRowCol(
  text: string,
  cursor: number,
): { row: number; col: number } {
  const chars = Array.from(text);
  const end = Math.min(Math.max(cursor, 0), chars.length);
  let row = 0;
  let col = 0;

  for (let i = 0; i < end; i += 1) {
    if (chars[i] === "\n") {
      row += 1;
      col = 0;
    } else {
      col += 1;
    }
  }

  return { row, col };
}

/**
 * Cursor-following viewport over logical lines: at most `visible` lines,
 * scrolled only as far as needed to keep the cursor's row in view. Pass the
 * previous call's `start` back in (Infinity on first render) so the window
 * stays put while the cursor moves within it; Infinity anchors to the bottom,
 * matching visibleTail's behavior when the cursor starts at the end.
 */
export function visibleWindow(
  text: string,
  cursor: number,
  visible: number,
  prevStart: number,
): {
  lines: string[];
  start: number;
  hiddenAbove: number;
  hiddenBelow: number;
  cursorRow: number;
  cursorCol: number;
} {
  const allLines = text.split("\n");
  const { row, col } = cursorRowCol(text, cursor);
  const maxStart = Math.max(0, allLines.length - visible);
  let start = Math.min(Math.max(prevStart, 0), maxStart);

  if (row < start) {
    start = row;
  } else if (row >= start + visible) {
    start = row - visible + 1;
  }

  const lines = allLines.slice(start, start + visible);

  return {
    lines,
    start,
    hiddenAbove: start,
    hiddenBelow: Math.max(0, allLines.length - (start + lines.length)),
    cursorRow: row - start,
    cursorCol: col,
  };
}

/**
 * Word-wraps each logical line to `width` columns and returns the flat list of
 * visual rows, so a caller can window over them with exact scroll math (each
 * row is guaranteed ≤ width, so nothing re-wraps at render time). A line's
 * leading indentation is preserved as a hanging indent on its continuation
 * rows; a word too long to ever fit is hard-broken. Lines already within
 * `width` pass through untouched, so aligned columns stay aligned.
 */
export function wrapLines(text: string, width: number): string[] {
  if (width <= 0) {
    return text.split("\n");
  }

  const rows: string[] = [];

  for (const line of text.split("\n")) {
    if (line.length <= width) {
      rows.push(line);
      continue;
    }

    const indent = line.slice(0, line.length - line.trimStart().length);
    // Continuation rows hang under the original indent, unless that leaves too
    // little room — then they start at column 0.
    const hang = indent.length + 8 <= width ? indent : "";
    // Budget that keeps every emitted row within `width`, for both the
    // indented first row and the (never-wider) hanging continuations.
    const contentWidth = Math.max(1, width - indent.length);

    // Tokenize on spaces, hard-splitting any word too long to ever fit.
    const words: string[] = [];

    for (const word of line.trimStart().split(/ +/u)) {
      if (word.length <= contentWidth) {
        words.push(word);
      } else {
        for (let i = 0; i < word.length; i += contentWidth) {
          words.push(word.slice(i, i + contentWidth));
        }
      }
    }

    let row = indent;
    let empty = true; // row holds only its indent so far

    for (const word of words) {
      if (!empty && `${row} ${word}`.length > width) {
        rows.push(row);
        row = hang + word;
      } else {
        row = empty ? row + word : `${row} ${word}`;
      }

      empty = false;
    }

    rows.push(row);
  }

  return rows;
}
