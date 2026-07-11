import { spawn } from "node:child_process";
import { CliError } from "../domain/errors.js";

export type ClipboardCommand = { command: string; args: string[] };

/**
 * Ordered candidate clipboard commands for a platform. Pure so tests can
 * cover the selection logic without spawning anything.
 */
export function getClipboardCommands(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): ClipboardCommand[] {
  if (platform === "darwin") {
    return [{ command: "pbcopy", args: [] }];
  }

  if (platform === "win32") {
    return [{ command: "clip", args: [] }];
  }

  if (platform === "linux") {
    const x11 = [
      { command: "xclip", args: ["-selection", "clipboard"] },
      { command: "xsel", args: ["--clipboard", "--input"] },
    ];
    const wayland = [{ command: "wl-copy", args: [] }];

    return env.WAYLAND_DISPLAY ? [...wayland, ...x11] : [...x11, ...wayland];
  }

  return [];
}

function runClipboardCommand(
  candidate: ClipboardCommand,
  text: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(candidate.command, candidate.args, {
      stdio: ["pipe", "ignore", "ignore"],
    });

    // ENOENT (utility not installed) and non-zero exits both mean "try the
    // next candidate", never a crash.
    child.on("error", () => {
      resolve(false);
    });
    child.on("close", (code) => {
      resolve(code === 0);
    });
    child.stdin.on("error", () => {
      // Ignore EPIPE from a child that exited before reading stdin.
    });
    child.stdin.end(text);
  });
}

/**
 * Copies text to the system clipboard using the platform's native utility.
 * Rejects with an actionable CliError when no utility works — callers treat
 * that as a warning, not a failure. `candidates` is injectable for tests.
 */
export async function copyToClipboard(
  text: string,
  candidates: ClipboardCommand[] = getClipboardCommands(),
): Promise<void> {
  for (const candidate of candidates) {
    if (await runClipboardCommand(candidate, text)) {
      return;
    }
  }

  throw new CliError(
    candidates.length === 0
      ? `No clipboard utility is available on platform "${process.platform}".`
      : "No clipboard utility found — install xclip or wl-clipboard (Linux), or check that the clipboard is accessible.",
  );
}
