import { useEffect, useState } from "react";
import { useStdout } from "ink";
import { LOGO_LINES, LOGO_WIDTH } from "./branding.js";

/**
 * One shared source of viewport math. Every height-aware widget used to
 * carry its own chrome constant (12/12/11) for the same "logo + header"
 * overhead; computeViewport centralizes that so all widgets derive their
 * window from contentRows plus a small named local for their own chrome.
 */

/**
 * Rows the logo needs before it is worth showing. Set so the tallest view —
 * the main menu (logo + header + the bordered action list with a two-line
 * hint + footer) — still fits under it; below this the logo is hidden so that
 * view never exceeds the viewport (an over-tall Ink frame in the alt-screen
 * can't be erased cleanly and leaves residue / triggers full-clear flashes).
 */
const LOGO_MIN_ROWS = 30;

/**
 * Rows the header block occupies above any view's content: the brand line,
 * the provider/model line, the cwd line, an optional subtitle, the header's
 * trailing margin, and a cushion. Deliberately a slight overestimate — an
 * over-tall alt-screen frame leaves redraw residue, so showing a few rows
 * fewer is always the safer direction.
 */
const HEADER_CHROME_ROWS = 8;

/**
 * Widest the content column ever gets. Past this the shell centers the column
 * instead of stretching: a full-bleed 200-column terminal wraps prose at ~195
 * characters, well past a readable measure, and leaves the 62-column menu
 * marooned against the left edge. Below this the cap is inert — contentColumns
 * is the terminal width and the gutter is 0, so narrow and standard terminals
 * render exactly as they did before.
 */
const MAX_CONTENT_COLUMNS = 120;

/**
 * Content width at which views may switch to a side-by-side layout. Matches
 * the breakpoint the PR-template picker already used before this was shared.
 */
export const WIDE_LAYOUT_COLUMNS = 100;

/** True when the viewport is tall and wide enough to show the ASCII logo. */
export function logoVisible(columns: number, rows: number): boolean {
  return columns >= LOGO_WIDTH + 2 && rows >= LOGO_MIN_ROWS;
}

export type Viewport = {
  /** The real terminal width. Only the shell's own math should need this. */
  columns: number;
  rows: number;
  /** Rows the logo occupies right now (0 when hidden). */
  logoRows: number;
  /** Rows left for view content under the logo + header chrome. */
  contentRows: number;
  /**
   * Columns a view may draw in. Every width and every wrap width derives from
   * this, never from `columns`: the shell renders content in a box this wide,
   * so wrapping text at the terminal width would under-count rows and push the
   * frame past the terminal's height (see computePromptRows).
   */
  contentColumns: number;
  /** Left offset that centers the content column in the terminal. */
  gutter: number;
};

/** Pure so extreme sizes are unit-testable without a terminal. */
export function computeViewport(columns: number, rows: number): Viewport {
  const contentColumns = Math.min(columns, MAX_CONTENT_COLUMNS);
  const logoRows = logoVisible(contentColumns, rows) ? LOGO_LINES.length : 0;

  return {
    columns,
    rows,
    logoRows,
    contentRows: Math.max(3, rows - logoRows - HEADER_CHROME_ROWS),
    contentColumns,
    gutter: Math.floor((columns - contentColumns) / 2),
  };
}

/**
 * Rows of text a prompt box may show: grows with the window instead of the
 * fixed clamps the prompts used to carry, but never past `max` — every row the
 * input takes is a row the history above it loses, and a frame that reaches
 * the terminal's height makes Ink clear and repaint the whole screen per
 * render (ink.js's `outputHeight >= stdout.rows` branch), which reads as a
 * freeze. `chromeRows` is what the view spends around the text: label,
 * borders, hint footer.
 */
export function computePromptRows(
  contentRows: number,
  chromeRows: number,
  bounds: { min: number; max: number },
): number {
  return Math.max(
    bounds.min,
    Math.min(bounds.max, contentRows - Math.max(0, chromeRows)),
  );
}

/** Current terminal size, re-rendering on resize (0/undefined → defaults). */
export function useTerminalSize(): { columns: number; rows: number } {
  const { stdout } = useStdout();
  const measure = () => ({
    columns: stdout.columns || 80,
    rows: stdout.rows || 24,
  });
  const [size, setSize] = useState(measure);

  useEffect(() => {
    const onResize = () => {
      setSize(measure());
    };

    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  return size;
}

/** Live viewport: terminal size + logo/content row math, updating on resize. */
export function useViewport(): Viewport {
  const { columns, rows } = useTerminalSize();

  return computeViewport(columns, rows);
}
