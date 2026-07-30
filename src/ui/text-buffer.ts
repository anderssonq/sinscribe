/** Pure text and viewport helpers for the prompt components. */

/**
 * Normalizes typed or pasted input before insertion: CRLF/CR normalize to
 * \n, tabs become two spaces, and other control characters are dropped.
 * Single-line prompts (`multiline: false`) flatten newlines to a space —
 * dropping them outright glued the surrounding words together ("…the
 * ticketABC-123…") in pasted text.
 */
export function normalizeInsert(input: string, multiline: boolean): string {
  const normalized = input
    .replace(/\r\n/gu, "\n")
    .replace(/\r/gu, "\n")
    .replace(/\t/gu, "  ");

  let kept = "";

  for (const char of normalized) {
    if (char === "\n") {
      kept += multiline ? char : " ";
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

/** One visual row of wrapped text, with its code-point span in the source. */
export type WrappedRow = {
  text: string;
  /** Code-point index of the row's first character. */
  start: number;
  /** Code-point index one past the row's last character. */
  end: number;
};

/**
 * Offset-exact soft wrap for EDITING: unlike wrapLines (which reflows for
 * display — collapsing space runs and adding a hanging indent), every row here
 * is a literal slice of the source, so `rows.join("")` gives the text back with
 * only the newlines consumed. That exactness is what lets the caret map to a
 * row/column without a second, disagreeing pass over the text.
 *
 * A line breaks after the last space that fits (the space stays at the end of
 * its row, so no character is lost); a word too long to ever fit breaks hard at
 * `width`. Every row is therefore at most `width` code points.
 */
export function wrapRows(text: string, width: number): WrappedRow[] {
  const chars = Array.from(text);
  const rows: WrappedRow[] = [];
  let lineStart = 0;

  for (;;) {
    let lineEnd = lineStart;

    while (lineEnd < chars.length && chars[lineEnd] !== "\n") {
      lineEnd += 1;
    }

    if (width <= 0) {
      rows.push({
        text: chars.slice(lineStart, lineEnd).join(""),
        start: lineStart,
        end: lineEnd,
      });
    } else {
      let start = lineStart;

      do {
        let end: number;

        if (lineEnd - start <= width) {
          end = lineEnd;
        } else {
          const hardEnd = start + width;
          let breakAt = -1;

          for (let i = hardEnd - 1; i > start; i -= 1) {
            if (chars[i] === " ") {
              breakAt = i + 1;
              break;
            }
          }

          end = breakAt > start ? breakAt : hardEnd;
        }

        rows.push({ text: chars.slice(start, end).join(""), start, end });
        start = end;
      } while (start < lineEnd);
    }

    if (lineEnd >= chars.length) {
      return rows;
    }

    lineStart = lineEnd + 1;
  }
}

/**
 * Cursor-following viewport over VISUAL rows — the same contract as
 * visibleWindow, but counting wrapped rows instead of logical lines, so one
 * long pasted paragraph can no longer outgrow the box it is drawn in.
 *
 * `width` is the room a row's text has, with the caret cell already subtracted
 * by the caller: cursorCol may equal the row length, and rendering a caret
 * there needs one more column than the text uses.
 */
export function visibleRowWindow(
  text: string,
  cursor: number,
  width: number,
  visible: number,
  prevStart: number,
): {
  rows: string[];
  start: number;
  hiddenAbove: number;
  hiddenBelow: number;
  cursorRow: number;
  cursorCol: number;
  totalRows: number;
} {
  const all = wrapRows(text, width);
  const cap = Math.max(1, visible);
  const clamped = Math.min(Math.max(cursor, 0), Array.from(text).length);
  // The LAST row starting at or before the cursor: at a soft-wrap boundary the
  // cursor belongs to the new row (column 0), never one column past the old
  // row's edge — which would draw the caret outside the box.
  let cursorRow = 0;

  for (let i = 1; i < all.length; i += 1) {
    if (all[i].start > clamped) {
      break;
    }
    cursorRow = i;
  }

  const maxStart = Math.max(0, all.length - cap);
  let start = Math.min(Math.max(prevStart, 0), maxStart);

  if (cursorRow < start) {
    start = cursorRow;
  } else if (cursorRow >= start + cap) {
    start = cursorRow - cap + 1;
  }

  const rows = all.slice(start, start + cap);

  return {
    rows: rows.map((row) => row.text),
    start,
    hiddenAbove: start,
    hiddenBelow: Math.max(0, all.length - (start + rows.length)),
    cursorRow: cursorRow - start,
    cursorCol: clamped - all[cursorRow].start,
    totalRows: all.length,
  };
}

/**
 * Single-row horizontal viewport for one-line prompts: the `width` code points
 * around the cursor, scrolled only as far as needed to keep it visible (the
 * sticky-start rule of visibleRowWindow, one axis over). Keeps a one-line box
 * exactly one line tall however much text is pasted into it — the generalized
 * form of maskedView's cap.
 */
export function visibleSlice(
  text: string,
  cursor: number,
  width: number,
  prevStart: number,
): {
  text: string;
  cursorCol: number;
  hiddenLeft: number;
  hiddenRight: number;
} {
  const chars = Array.from(text);
  const cap = Math.max(1, width);
  const clamped = Math.min(Math.max(cursor, 0), chars.length);
  // +1: the cursor may sit one past the last character (append position).
  const maxStart = Math.max(0, chars.length - cap + 1);
  let start = Math.min(Math.max(prevStart, 0), maxStart);

  if (clamped < start) {
    start = clamped;
  } else if (clamped > start + cap - 1) {
    start = clamped - cap + 1;
  }

  return {
    text: chars.slice(start, start + cap).join(""),
    cursorCol: clamped - start,
    hiddenLeft: start,
    hiddenRight: Math.max(0, chars.length - (start + cap)),
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
