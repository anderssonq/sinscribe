/** Pure editing helpers for MultilinePrompt (append-at-end cursor model). */

/**
 * Appends typed or pasted input, preserving line breaks: CRLF/CR normalize
 * to \n (single-line prompts strip them instead), tabs become two spaces,
 * and other control characters are dropped.
 */
export function appendInput(current: string, input: string): string {
  const normalized = input
    .replace(/\r\n/gu, "\n")
    .replace(/\r/gu, "\n")
    .replace(/\t/gu, "  ");

  let kept = "";

  for (const char of normalized) {
    const code = char.codePointAt(0) ?? 0;
    const isControl = (code < 32 && code !== 10) || code === 127;

    if (!isControl) {
      kept += char;
    }
  }

  return current + kept;
}

/**
 * Deletes the last character (code point, so emoji are not split into a
 * lone surrogate); deleting a trailing \n joins lines.
 */
export function deleteLast(current: string): string {
  const chars = Array.from(current);

  chars.pop();
  return chars.join("");
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
