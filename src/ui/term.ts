import { writeSync } from "node:fs";

/**
 * Raw terminal escape sequences and their lifecycle.
 *
 * Every sequence the CLI emits outside of Ink's own rendering lives here, so
 * setup/restore stays in one place. Writes go directly to process.stdout —
 * they are zero-width control sequences that do not disturb Ink's line math
 * (routing them through useStdout().write would force a re-render instead).
 */
export const ENTER_ALT_SCREEN = "\x1b[?1049h\x1b[2J\x1b[H";
export const LEAVE_ALT_SCREEN = "\x1b[?1049l";
/** SGR mouse reporting: button events (?1000) in SGR encoding (?1006). */
export const ENABLE_MOUSE = "\x1b[?1000h\x1b[?1006h";
export const DISABLE_MOUSE = "\x1b[?1006l\x1b[?1000l";

const RESET_BACKGROUND = "\x1b]111\x07";

type TerminalFeature = "bg" | "alt" | "mouse";

const RESTORE_SEQUENCES: Record<TerminalFeature, string> = {
  mouse: DISABLE_MOUSE,
  alt: LEAVE_ALT_SCREEN,
  bg: RESET_BACKGROUND,
};

/** Restore order matters: mouse off, leave alt screen, then reset background. */
const RESTORE_ORDER: TerminalFeature[] = ["mouse", "alt", "bg"];

const active = new Set<TerminalFeature>();

/** Tracks which features the exit safety net still needs to undo. */
export function markActive(feature: TerminalFeature, on: boolean): void {
  if (on) {
    active.add(feature);
  } else {
    active.delete(feature);
  }
}

/** OSC 11: set the terminal window background color (e.g. "#0d1117"). */
export function setTerminalBackground(hex: string): void {
  process.stdout.write(`\x1b]11;${hex}\x07`);
}

/** OSC 111: reset the terminal window background to its default. */
export function resetTerminalBackground(): void {
  process.stdout.write(RESET_BACKGROUND);
}

/**
 * Whether to attempt OSC 11 background control. Terminals that don't
 * understand it ignore the sequence, so this only excludes cases where
 * emitting it is wrong (non-TTY), unwanted (NO_COLOR) or mis-scoped
 * (tmux/screen swallow or leak OSC to the wrong pane).
 */
export function supportsBackgroundControl(): boolean {
  if (!process.stdout.isTTY || process.env.NO_COLOR) {
    return false;
  }

  const term = process.env.TERM ?? "";

  return !(
    process.env.TMUX ||
    term.startsWith("screen") ||
    term.startsWith("tmux")
  );
}

let cleanupInstalled = false;

/**
 * Idempotent safety net: restores any still-active terminal feature on
 * process exit and on SIGTERM/SIGHUP. The normal path is the caller's
 * finally block (Ctrl+C resolves Ink's waitUntilExit, so that path runs
 * too); this net only fires for whatever markActive still has flagged.
 */
export function installTerminalCleanup(): void {
  if (cleanupInstalled) {
    return;
  }

  cleanupInstalled = true;

  process.on("exit", restoreActiveFeatures);

  // SIGINT included: raw-mode Ctrl+C never raises it (Ink unmounts instead),
  // but an external `kill -INT` would otherwise die without running 'exit'.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      restoreActiveFeatures();
      process.exit(1);
    });
  }
}

function restoreActiveFeatures(): void {
  for (const feature of RESTORE_ORDER) {
    if (!active.has(feature)) {
      continue;
    }

    try {
      // writeSync: exit handlers cannot await an async stdout flush.
      writeSync(1, RESTORE_SEQUENCES[feature]);
    } catch {
      // Best-effort — stdout may already be closed.
    }

    active.delete(feature);
  }
}
