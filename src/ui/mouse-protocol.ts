/**
 * SGR mouse protocol parsing — pure functions, no React/Ink imports.
 *
 * With mouse reporting enabled (see ENABLE_MOUSE in term.ts) the terminal
 * writes sequences like "\x1b[<0;12;5M" to stdin: button code, then 1-based
 * column and row, with a final "M" for press and "m" for release. Wheel
 * events set bit 64 on the button code, with bit 0 giving the direction.
 */

const ESC = String.fromCharCode(27);
const SEQUENCE_PREFIX = `${ESC}[<`;

const SGR_EVENT = new RegExp(`${ESC}\\[<(\\d+);(\\d+);(\\d+)([Mm])`, "gu");

/** A parsed SGR mouse event; x/y are 1-based terminal coordinates. */
export type MouseEvent =
  | { kind: "press" | "release"; button: number; x: number; y: number }
  | { kind: "wheel"; direction: "up" | "down"; x: number; y: number };

/**
 * Extracts every complete SGR event from a stdin chunk. `rest` carries a
 * trailing partial sequence — prepend it to the next chunk so events split
 * across reads are not dropped. Non-mouse bytes are ignored.
 */
export function parseSgrMouse(data: string): {
  events: MouseEvent[];
  rest: string;
} {
  const events: MouseEvent[] = [];

  for (const match of data.matchAll(SGR_EVENT)) {
    const code = Number(match[1]);
    const x = Number(match[2]);
    const y = Number(match[3]);

    if (code & 64) {
      events.push({
        kind: "wheel",
        direction: (code & 1) === 0 ? "up" : "down",
        x,
        y,
      });
    } else {
      events.push({
        kind: match[4] === "M" ? "press" : "release",
        button: code & 3,
        x,
        y,
      });
    }
  }

  return { events, rest: partialTail(data) };
}

/** Returns a trailing incomplete SGR sequence, or "" when there is none. */
function partialTail(data: string): string {
  const start = data.lastIndexOf(ESC);

  if (start === -1) {
    return "";
  }

  const tail = data.slice(start);

  if (tail.length <= SEQUENCE_PREFIX.length) {
    return SEQUENCE_PREFIX.startsWith(tail) ? tail : "";
  }

  if (!tail.startsWith(SEQUENCE_PREFIX)) {
    return "";
  }

  return /^[\d;]*$/u.test(tail.slice(SEQUENCE_PREFIX.length)) ? tail : "";
}

/** A component's rectangle in 0-based Ink layout coordinates. */
export type Rect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

/** True when a 1-based SGR coordinate lands inside a 0-based rect. */
export function hitTest(rect: Rect, x: number, y: number): boolean {
  const column = x - 1;
  const row = y - 1;

  return (
    column >= rect.left &&
    column < rect.left + rect.width &&
    row >= rect.top &&
    row < rect.top + rect.height
  );
}
