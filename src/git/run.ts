import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Runs a git command without failing the whole run for normal git errors.
 * Returns merged, trimmed stdout/stderr (openwiki's runGit pattern).
 */
export async function runGit(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(
      "git",
      ["--no-pager", ...args],
      {
        cwd,
        maxBuffer: 10 * 1024 * 1024,
      },
    );

    return [stdout.trim(), stderr.trim()].filter(Boolean).join("\n").trim();
  } catch (error) {
    if (isExecError(error)) {
      return [error.stdout?.trim(), error.stderr?.trim()]
        .filter(Boolean)
        .join("\n")
        .trim();
    }

    throw error;
  }
}

/**
 * Runs a git command and returns trimmed stdout, or null when git exits
 * non-zero (used where failure must be detected, e.g. ref probing).
 */
export async function tryGit(
  cwd: string,
  args: string[],
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["--no-pager", ...args], {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
    });

    return stdout.trim();
  } catch {
    return null;
  }
}

export class GitCommandError extends Error {
  readonly args: string[];
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;

  constructor(input: {
    args: string[];
    exitCode: number | null;
    stdout: string;
    stderr: string;
  }) {
    const detail = input.stderr || input.stdout || "(no output)";

    super(
      `git ${input.args.join(" ")} failed (exit ${input.exitCode ?? "?"}): ${detail}`,
    );
    this.name = "GitCommandError";
    this.args = input.args;
    this.exitCode = input.exitCode;
    this.stdout = input.stdout;
    this.stderr = input.stderr;
  }
}

/**
 * Runs a git command and throws GitCommandError (preserving stderr) when git
 * exits non-zero. Used for write operations, where runGit would swallow the
 * failure and tryGit would drop the error message.
 */
export async function runGitStrict(
  cwd: string,
  args: string[],
): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["--no-pager", ...args], {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
    });

    return stdout.trim();
  } catch (error) {
    if (isExecError(error)) {
      throw new GitCommandError({
        args,
        exitCode: typeof error.code === "number" ? error.code : null,
        stdout: error.stdout?.trim() ?? "",
        stderr: error.stderr?.trim() ?? "",
      });
    }

    throw error;
  }
}

function isExecError(
  error: unknown,
): error is Error & { stdout?: string; stderr?: string; code?: unknown } {
  return error instanceof Error && ("stdout" in error || "stderr" in error);
}
