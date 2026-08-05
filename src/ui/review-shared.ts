import { access } from "node:fs/promises";
import { useViewport } from "./viewport.js";

/**
 * Helpers the pr/prompt/docs review flows previously each declared locally
 * (byte-identical copies) — one home so they cannot drift.
 */

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Export steps report failures as summary lines instead of aborting. */
export function isWarningLine(line: string): boolean {
  return /failed|could not|skipped/iu.test(line);
}

/**
 * Below this a preview is not worth its borders, and the select list under it
 * is what the user needs to reach.
 */
const MIN_PREVIEW_ROWS = 4;

/**
 * Rows a bordered preview panel may show, or null when the terminal has no
 * room for one at all — the caller then renders a one-line note instead.
 *
 * Returning null matters: a floor that hands back rows the terminal does not
 * have produces a frame as tall as the screen, and Ink then clears and
 * repaints everything on every render (its `outputHeight >= stdout.rows`
 * branch) instead of diffing — which reads as a freeze. `extraRows` is the
 * caller's own chrome around the panel (headings, select list, summary lines).
 */
export function useReviewPreviewRows(extraRows: number): number | null {
  const { contentRows } = useViewport();
  const rows = contentRows - extraRows;

  return rows >= MIN_PREVIEW_ROWS ? rows : null;
}

/**
 * Same budget for a streaming run log, which is unbordered and cannot simply
 * be dropped — a bounded one-row log still beats an unbounded one, so this
 * floors at 1 rather than returning null.
 */
export function useReviewLogRows(extraRows: number): number {
  const { contentRows } = useViewport();

  return Math.max(1, contentRows - extraRows);
}
