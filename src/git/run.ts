import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Every git subprocess is bounded: GIT_TERMINAL_PROMPT=0 makes credential
 * prompts fail immediately instead of blocking on hidden input, and the
 * timeout covers whatever still stalls (e.g. a GPG pinentry). Without a
 * bound, one blocked prompt froze the whole CLI.
 */
const GIT_TIMEOUT_MS = 30_000;

type GitRunOptions = {
  /** Override for tests; defaults to GIT_TIMEOUT_MS. */
  timeoutMs?: number;
};

function execGit(
  cwd: string,
  args: string[],
  options: GitRunOptions,
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", ["--no-pager", ...args], {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
    timeout: options.timeoutMs ?? GIT_TIMEOUT_MS,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

function timeoutMessage(args: string[], options: GitRunOptions): string {
  const seconds = Math.round((options.timeoutMs ?? GIT_TIMEOUT_MS) / 1_000);

  return (
    `git ${args.join(" ")} timed out after ${seconds}s — ` +
    `a credential or GPG prompt may be blocking.`
  );
}

/**
 * Runs a git command without failing the whole run for normal git errors.
 * Returns merged, trimmed stdout/stderr (openwiki's runGit pattern).
 * Throws on timeout: a hung git process is exceptional, not a normal error.
 */
export async function runGit(
  cwd: string,
  args: string[],
  options: GitRunOptions = {},
): Promise<string> {
  try {
    const { stdout, stderr } = await execGit(cwd, args, options);

    return [stdout.trim(), stderr.trim()].filter(Boolean).join("\n").trim();
  } catch (error) {
    if (isExecTimeout(error)) {
      throw new GitCommandError({
        args,
        exitCode: null,
        stdout: "",
        stderr: timeoutMessage(args, options),
      });
    }

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
 * non-zero (used where failure must be detected, e.g. ref probing). A
 * timeout also returns null, honoring the swallow-to-null contract.
 */
export async function tryGit(
  cwd: string,
  args: string[],
  options: GitRunOptions = {},
): Promise<string | null> {
  try {
    const { stdout } = await execGit(cwd, args, options);

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
  options: GitRunOptions = {},
): Promise<string> {
  try {
    const { stdout } = await execGit(cwd, args, options);

    return stdout.trim();
  } catch (error) {
    if (isExecTimeout(error)) {
      throw new GitCommandError({
        args,
        exitCode: null,
        stdout: "",
        stderr: timeoutMessage(args, options),
      });
    }

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

/** execFile sets killed=true when it terminated the child on timeout. */
function isExecTimeout(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as { killed?: unknown }).killed === true &&
    (error as { signal?: unknown }).signal === "SIGTERM"
  );
}
