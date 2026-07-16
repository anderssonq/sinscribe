import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/** OSC 111 — the terminal-background restore written by the cleanup net. */
const RESET_BACKGROUND = "\x1b]111\x07";

describe("signal handling", () => {
  it("SIGINT exits cleanly and restores the terminal within 2s", async () => {
    const child = spawn(
      path.join(repoRoot, "node_modules", ".bin", "tsx"),
      [path.join(repoRoot, "test", "fixtures", "hang-with-cleanup.ts")],
      { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
    );

    let stdout = "";
    child.stdout.setEncoding("utf8");

    // Wait for the fixture to be fully set up before signalling it.
    await new Promise<void>((resolve, reject) => {
      const onData = (data: string): void => {
        stdout += data;

        if (stdout.includes("ready")) {
          resolve();
        }
      };

      child.stdout.on("data", onData);
      child.on("error", reject);
      child.on("exit", () => {
        reject(new Error(`fixture exited before ready: ${stdout}`));
      });
    });

    child.removeAllListeners("exit");
    child.kill("SIGINT");

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("fixture did not exit within 2s of SIGINT"));
      }, 2_000);

      // The ready-phase data listener stays attached and keeps capturing.
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });

    expect(exitCode).toBe(1);
    expect(stdout).toContain(RESET_BACKGROUND);
  }, 15_000);
});
