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

/** True when the terminal is tall and wide enough to show the ASCII logo. */
export function logoVisible(columns: number, rows: number): boolean {
  return columns >= LOGO_WIDTH + 2 && rows >= LOGO_MIN_ROWS;
}

export type Viewport = {
  columns: number;
  rows: number;
  /** Rows the logo occupies right now (0 when hidden). */
  logoRows: number;
  /** Rows left for view content under the logo + header chrome. */
  contentRows: number;
};

/** Pure so extreme sizes are unit-testable without a terminal. */
export function computeViewport(columns: number, rows: number): Viewport {
  const logoRows = logoVisible(columns, rows) ? LOGO_LINES.length : 0;

  return {
    columns,
    rows,
    logoRows,
    contentRows: Math.max(3, rows - logoRows - HEADER_CHROME_ROWS),
  };
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
