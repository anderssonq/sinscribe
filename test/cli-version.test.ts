import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

describe("sinscribe --version", () => {
  it("prints exactly the package.json version and exits 0", async () => {
    const { version } = JSON.parse(
      readFileSync(path.join(repoRoot, "package.json"), "utf8"),
    ) as { version: string };

    const child = spawn(
      path.join(repoRoot, "node_modules", ".bin", "tsx"),
      [path.join(repoRoot, "src", "cli.tsx"), "--version"],
      { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
    );

    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (data: string) => {
      stdout += data;
    });

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", resolve);
    });

    expect(exitCode).toBe(0);
    // Strict equality: scripts capture this output (`VER=$(sinscribe -v)`),
    // so nothing — banners, escape codes — may ride along with the version.
    expect(stdout).toBe(`${version}\n`);
  }, 15_000);
});
