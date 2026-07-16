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
 * Height-aware replacement for the old fixed 16-line review/done clamps:
 * tall terminals see more of the generated text, short ones stop
 * overflowing. `extraRows` is the caller's own chrome below/around the
 * clamped panel (select list, summary lines, headings).
 */
export function useReviewVisibleLines(extraRows: number): number {
  const { contentRows } = useViewport();

  return Math.max(6, contentRows - extraRows);
}
