import { spawn } from "node:child_process";
import { CliError } from "../../domain/errors.js";
import { emitDebug, type RunCallbacks } from "../events.js";
import {
  createInactivityWatchdog,
  EXPLORE_TOTAL_MS,
  LLM_INACTIVITY_MS,
  raceAbort,
} from "../watchdog.js";
import { ClaudeExploreParser } from "./explore-stream.js";
import { buildClaudeEnv, toSpawnError } from "./model.js";

/**
 * The claude CLI as a READ-ONLY repository explorer — the plan's third
 * runner tier, deliberately separate from ChatClaudeCli/buildClaudeArgs so
 * the single-shot "no tools" contract of pr/commit/branch/prompt is
 * untouched.
 *
 * Verified against claude 2.1.293:
 * - `--restricted` drops every command/code-running tool and WebFetch,
 *   ignores user/project/local settings files (so a repo's
 *   .claude/settings.json hooks never run), and confines the file tools to
 *   the working directory: reading /etc/hosts or ~/.zshrc is refused.
 * - `--tools Read,Glob,Grep` is the whole tool set; nothing can write.
 * - `Read(...)` deny rules also stop Grep from reading those files.
 */

/** Secret-bearing paths the explorer may never open (gitignore-style globs). */
export const EXPLORE_DENY_GLOBS = [
  "**/.env",
  "**/.env.*",
  "**/*.pem",
  "**/*.key",
  "**/*.p12",
  "**/*.pfx",
  "**/id_rsa*",
  "**/id_ed25519*",
  "**/id_ecdsa*",
  "**/.npmrc",
  "**/.netrc",
  "**/.pypirc",
  "**/credentials*",
  "**/secrets/**",
  "**/secrets.*",
  "**/.sinscribe/**",
  "**/.git/**",
] as const;

export const EXPLORE_TOOLS = "Read,Glob,Grep";
export const DEFAULT_EXPLORE_MAX_TURNS = 30;

export function buildClaudeExploreSettings(): Record<string, unknown> {
  return {
    permissions: {
      allow: ["Read", "Glob", "Grep"],
      // Both spellings: `./x` anchors at the working directory, `**/x`
      // matches at any depth.
      deny: EXPLORE_DENY_GLOBS.flatMap((glob) => [
        `Read(${glob})`,
        `Read(./${glob.replace(/^\*\*\//u, "")})`,
      ]),
      defaultMode: "dontAsk",
    },
    disableAllHooks: true,
  };
}

export function buildClaudeExploreArgs(
  model: string,
  systemPrompt: string,
  options: { maxTurns: number },
): string[] {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    // Kept for liveness: without partial messages the CLI is silent while
    // the final document is written, and the inactivity watchdog would fire.
    "--include-partial-messages",
    "--model",
    model,
    "--restricted",
    "--tools",
    EXPLORE_TOOLS,
    // Comma form: the variadic flag would otherwise swallow what follows.
    "--allowedTools",
    EXPLORE_TOOLS,
    "--permission-mode",
    "dontAsk",
    // Anything that would prompt is denied — there is no human on stdin.
    "--permission-prompts",
    "none",
    "--max-turns",
    String(options.maxTurns),
    "--no-session-persistence",
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--exclude-dynamic-system-prompt-sections",
    "--settings",
    JSON.stringify(buildClaudeExploreSettings()),
  ];

  if (systemPrompt.length > 0) {
    args.push("--system-prompt", systemPrompt);
  }

  return args;
}

/** The installed CLI predates a flag explore mode needs; fall back. */
export class ExploreUnsupportedError extends CliError {}

const UNKNOWN_OPTION_PATTERN = /unknown option|unrecognized option/iu;

export type ClaudeExploreInput = RunCallbacks & {
  command: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  repoRoot: string;
  maxTurns?: number;
};

export type ClaudeExploreResult = { text: string; filesRead: string[] };

export async function runClaudeExplore(
  input: ClaudeExploreInput,
): Promise<ClaudeExploreResult> {
  const maxTurns = input.maxTurns ?? DEFAULT_EXPLORE_MAX_TURNS;
  const watchdog = createInactivityWatchdog({
    inactivityMs: LLM_INACTIVITY_MS,
    totalMs: EXPLORE_TOTAL_MS,
  });

  emitDebug(input, `claude explore cwd=${input.repoRoot} turns=${maxTurns}`);

  const child = spawn(
    input.command,
    buildClaudeExploreArgs(input.model, input.systemPrompt, { maxTurns }),
    {
      // The repo root IS the sandbox: --restricted confines Read/Glob/Grep
      // to the working directory.
      cwd: input.repoRoot,
      env: buildClaudeEnv(),
      signal: watchdog.signal,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  let stderr = "";

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const exited = new Promise<{ code: number | null; failure: Error | null }>(
    (resolve) => {
      child.on("error", (failure) => {
        resolve({ code: null, failure });
      });
      child.on("close", (code) => {
        resolve({ code, failure: null });
      });
    },
  );

  child.stdin.on("error", () => undefined);
  child.stdin.end(input.userPrompt);
  child.stdout.setEncoding("utf8");

  const parser = new ClaudeExploreParser(input.repoRoot);
  const forward = (output: ReturnType<ClaudeExploreParser["push"]>): void => {
    for (const event of output.events) {
      input.onEvent?.(event);
    }
  };

  try {
    for await (const chunk of raceAbort(
      child.stdout as AsyncIterable<string>,
      watchdog,
    )) {
      // Any output — narration, tool traffic, the final document — is life.
      watchdog.touch();
      forward(parser.push(chunk));
    }

    forward(parser.flush());
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
    }

    watchdog.dispose();
  }

  if (watchdog.timeoutError !== null) {
    throw watchdog.timeoutError;
  }

  const { code, failure } = await exited;

  if (failure !== null) {
    throw toSpawnError(failure, input.command);
  }

  if (code !== 0 && UNKNOWN_OPTION_PATTERN.test(stderr)) {
    throw new ExploreUnsupportedError(
      `${input.command} does not support read-only explore mode ` +
        `(${stderr.trim().split("\n")[0]}) — update Claude Code.`,
    );
  }

  if (parser.result?.isError) {
    if (parser.result.subtype === "error_max_turns") {
      throw new CliError(
        `${input.command} used all ${maxTurns} exploration turns without ` +
          `finishing — retry without exploring.`,
      );
    }

    throw new CliError(
      `${input.command} failed: ${parser.result.message || "(no detail)"}`,
    );
  }

  if (code !== 0) {
    throw new CliError(
      `${input.command} exited with code ${code ?? "?"}: ` +
        `${stderr.trim().slice(0, 500) || "(no output)"}`,
    );
  }

  const text = parser.result?.message.trim() ?? "";

  if (text.length === 0) {
    throw new CliError(`${input.command} returned no document.`);
  }

  return { text, filesRead: parser.filesRead };
}
