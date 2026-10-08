import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { CliError } from "../../domain/errors.js";
import { sinscribeEnvDir } from "../../env.js";
import { EXPLORE_DENY_GLOBS } from "../claude-cli/explore.js";
import { listTrackedFiles } from "../../domain/repo-brief.js";
import { redactSecrets } from "../../util/redact.js";
import { emitDebug, type RunCallbacks } from "../events.js";
import {
  createInactivityWatchdog,
  EXPLORE_TOTAL_MS,
  LLM_INACTIVITY_MS,
  raceAbort,
} from "../watchdog.js";

/**
 * Kiro CLI as a READ-ONLY repository explorer — the counterpart of
 * runClaudeExplore, kept apart from ChatKiroCli so the tools-less agent that
 * single-shot commands rely on is never touched.
 *
 * Verified against kiro-cli 2.3.0 and 2.28.0, with the config below:
 * - `fs_read` is the only tool, so there is nothing that writes or runs.
 * - The tool is NOT in `allowedTools`. Trusting it makes Kiro ignore
 *   `toolsSettings.fs_read.allowedPaths` (it warns, then read /etc/hosts);
 *   untrusted, `allowedPaths` is the only approval and every other read is
 *   rejected because no user can approve it in --no-interactive mode.
 * - `deniedPaths` refuses the secret globs inside the repository (`.env`).
 * - The agent lives in a fresh per-run directory that is also the child's
 *   cwd: Kiro discovers workspace agents under the cwd, so a repository can
 *   never shadow it with an agent of the same name, and concurrent runs on
 *   different repositories never share a config.
 * - A missing agent fails the run ("Mode '…' not found" on 2.28, exit 4)
 *   instead of falling back to the default agent; the pattern below refuses
 *   it either way.
 *
 * The transcript format changed between those versions. 2.3.0 prints
 * everything on stdout: "> " messages, "(using tool: …)" calls, "✓
 * Successfully read N bytes from /abs/path" and a credits footer. 2.28.0
 * prints only the model's text on stdout (narration, then the answer, no
 * "> ") and the tool traffic on stderr ("[tool] Reading a.ts:1, README.md:1",
 * "[tool] status: Completed"), with bare file names.
 */

export const KIRO_EXPLORE_AGENT_NAME = "sinscribe-readonly";

const AGENT_MISSING_PATTERN =
  /no agent with name|agent .* not found|failed to set agent/iu;

/* eslint-disable no-control-regex */
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/gu;
/* eslint-enable no-control-regex */

/**
 * Kiro confirms each successful read, single or batched:
 * " ✓ Successfully read 251 bytes from /abs/path". Rejected reads never print
 * it, so this lists only what the model actually saw.
 */
const READ_OK = /^\s*✓ Successfully read \d+ bytes from (.+)$/u;

/**
 * Every tool call — single, batched or rejected — opens with this marker; its
 * result lines (✓, ↱, Purpose:, - Summary:, …) follow until the next "> "
 * message. Only the marker anchors the answer search: the result lines'
 * shapes are ordinary markdown ("- Summary: …", "✓ done") that a document
 * may contain too.
 */
const TOOL_CALL = /\(using tool: /u;

/** Kiro's footer after the answer: " ▸ Credits: 0.01 • Time: 2s". */
const FOOTER = /^\s*▸\s*Credits:/u;

/** 2.28: a call's read list, "[tool] Reading a.ts:1-1, README.md:1". */
const STDERR_READING = /^\[tool\] Reading (.+)$/u;
/** 2.28: the end of a call — its result is in, the model writes next. */
const STDERR_STATUS = /^\[tool\] status: (\w+)/u;

/** Transcript lines quoted when no answer is found. */
const MISSING_ANSWER_TAIL_LINES = 6;

export function buildKiroExploreAgentConfig(repoRoot: string): string {
  const root = repoRoot.replace(/\/+$/u, "");

  return `${JSON.stringify(
    {
      name: KIRO_EXPLORE_AGENT_NAME,
      description:
        "Sinscribe read-only repository explorer. Reads one repository, nothing else.",
      prompt: null,
      mcpServers: {},
      tools: ["fs_read"],
      toolAliases: {},
      // Empty on purpose: a trusted fs_read ignores allowedPaths.
      allowedTools: [],
      resources: [],
      hooks: {},
      toolsSettings: {
        fs_read: {
          allowedPaths: [root, `${root}/**`],
          deniedPaths: EXPLORE_DENY_GLOBS.map((glob) => `${root}/${glob}`),
        },
      },
      includeMcpJson: false,
      model: null,
    },
    null,
    2,
  )}\n`;
}

export type KiroExploreInput = RunCallbacks & {
  command: string;
  /** "auto" lets the CLI choose. */
  model: string;
  systemPrompt: string;
  userPrompt: string;
  repoRoot: string;
};

export type KiroExploreResult = { text: string; filesRead: string[] };

/**
 * Splits Kiro's human-facing transcript into the final answer and the files
 * it read. The transcript interleaves "> " narration, tool lines and their
 * results; the answer is the first "> " message after the last tool line,
 * up to the credits footer. Not simply the last "> " line: an answer may
 * itself contain markdown quotes.
 */
export function parseKiroExploreOutput(
  raw: string,
  repoRoot: string,
): KiroExploreResult {
  const lines = cleanTranscript(raw).split("\n");
  const filesRead: string[] = [];
  let lastToolLine = -1;

  lines.forEach((line, index) => {
    const relative = readFromLine(line, repoRoot);

    if (relative !== null && !filesRead.includes(relative)) {
      filesRead.push(relative);
    }

    if (TOOL_CALL.test(line)) {
      lastToolLine = index;
    }
  });

  const answerStart = lines.findIndex(
    (line, index) => index > lastToolLine && line.startsWith("> "),
  );

  if (answerStart === -1) {
    return { text: "", filesRead };
  }

  const answer: string[] = [lines[answerStart].slice(2)];

  for (const line of lines.slice(answerStart + 1)) {
    if (FOOTER.test(line)) {
      break;
    }

    answer.push(line);
  }

  return { text: answer.join("\n").trim(), filesRead };
}

/**
 * Follows kiro-cli 2.28's stderr tool traffic as it streams. Each completed
 * call moves the answer offset to the end of the stdout written so far: the
 * model's text before it was narration ("I'll look at…"), what follows is
 * the answer. Reads count only once their call completes; a call with a
 * refused path fails as a whole.
 */
export class KiroToolTracker {
  private partial = "";
  private pending: string[] = [];
  /** Bare file names Kiro confirmed reading, in first-read order. */
  readonly names: string[] = [];
  /** Where the answer starts in stdout. */
  answerOffset = 0;
  /** True once any tool line arrived — the 2.28 format. */
  sawToolLine = false;

  /** Feeds a stderr chunk; returns the names newly confirmed as read. */
  push(chunk: string, stdoutLength: number): string[] {
    this.partial += chunk;

    const lines = this.partial.split("\n");

    this.partial = lines.pop() ?? "";

    return lines.flatMap((line) =>
      this.handle(cleanTranscript(line).trim(), stdoutLength),
    );
  }

  private handle(line: string, stdoutLength: number): string[] {
    const reading = STDERR_READING.exec(line);

    if (reading?.[1]) {
      this.sawToolLine = true;
      this.pending = reading[1]
        .split(/,\s+/u)
        .map((name) => name.trim().replace(/:\d+(?:-\d+)?$/u, ""))
        // "listing src" is a directory listing, not a file read.
        .filter((name) => name.length > 0 && !name.startsWith("listing "));

      return [];
    }

    const status = STDERR_STATUS.exec(line);

    if (!status) {
      return [];
    }

    this.sawToolLine = true;
    this.answerOffset = stdoutLength;

    const read = status[1] === "Completed" ? this.pending : [];

    this.pending = [];

    const fresh = read.filter((name) => !this.names.includes(name));

    this.names.push(...fresh);

    return fresh;
  }
}

/**
 * Bare names (2.28 prints "explore.ts", not a path) back to repo-relative
 * paths. A name shared by several tracked files is skipped: claiming the
 * wrong one would be worse than not listing it.
 */
export function resolveReadNames(names: string[], tracked: string[]): string[] {
  const byName = new Map<string, string[]>();

  for (const file of tracked) {
    const name = path.posix.basename(file);

    byName.set(name, [...(byName.get(name) ?? []), file]);
  }

  return names.flatMap((name) => {
    const matches = byName.get(name) ?? [];

    return matches.length === 1 ? matches : [];
  });
}

/**
 * True for 2.3.0's all-on-stdout transcript. 2.28 never prints the
 * "(using tool: " marker or "> " message prefixes on stdout, and puts its
 * tool lines on stderr.
 */
export function isLegacyKiroTranscript(
  stdout: string,
  sawToolLine: boolean,
): boolean {
  if (sawToolLine) {
    return false;
  }

  const clean = cleanTranscript(stdout);
  const first = clean.split("\n").find((line) => line.trim().length > 0);

  return TOOL_CALL.test(clean) || (first?.startsWith("> ") ?? false);
}

/** 2.28: the answer is stdout from the last completed tool call on. */
export function parseModernKiroAnswer(
  stdout: string,
  answerOffset: number,
): string {
  return cleanTranscript(stdout.slice(answerOffset))
    .split("\n")
    .filter((line) => !FOOTER.test(line))
    .join("\n")
    .trim();
}

function cleanTranscript(raw: string): string {
  return raw.replace(ANSI, "").replace(/\r/gu, "");
}

/** The repo-relative file a "✓ Successfully read" line confirms, if any. */
function readFromLine(line: string, repoRoot: string): string | null {
  const file = READ_OK.exec(line)?.[1]?.trim();
  const root = repoRoot.replace(/\/+$/u, "");

  return file?.startsWith(`${root}/`) ? file.slice(root.length + 1) : null;
}

/**
 * Kiro exited cleanly but no answer could be found. Its last output says why
 * (expired login, no credits, a refused read, a changed transcript format),
 * so it goes into the error instead of being thrown away.
 */
export function describeMissingAnswer(
  command: string,
  stdout: string,
  stderr: string,
  filesRead: string[],
): string {
  const tail = (text: string): string[] =>
    cleanTranscript(text)
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !FOOTER.test(line))
      .slice(-MISSING_ANSWER_TAIL_LINES);
  const output = redactSecrets([...tail(stdout), ...tail(stderr)].join("\n"))
    .text.split("\n")
    .filter((line) => line.length > 0)
    .map((line) => (line.length > 160 ? `${line.slice(0, 157)}...` : line));
  const last = output.at(-1);
  const head =
    `${command} explored but returned no answer ` +
    `(${filesRead.length} file(s) read)`;

  // The error screen shows the first line in full: put the most telling
  // output (the last line) there, the lines before it underneath.
  return last === undefined
    ? `${head}. It printed nothing.`
    : [`${head}: ${last}`, ...output.slice(0, -1).reverse()].join("\n");
}

export async function runKiroExplore(
  input: KiroExploreInput,
): Promise<KiroExploreResult> {
  const parent = path.join(sinscribeEnvDir, "kiro-explore");

  await mkdir(parent, { recursive: true, mode: 0o700 });

  const agentDir = await mkdtemp(path.join(parent, "run-"));
  const configDir = path.join(agentDir, ".amazonq", "cli-agents");
  const watchdog = createInactivityWatchdog({
    inactivityMs: LLM_INACTIVITY_MS,
    totalMs: EXPLORE_TOTAL_MS,
  });

  try {
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(configDir, `${KIRO_EXPLORE_AGENT_NAME}.json`),
      buildKiroExploreAgentConfig(input.repoRoot),
      "utf8",
    );

    emitDebug(
      input,
      `kiro explore agentDir=${agentDir} repo=${input.repoRoot}`,
    );

    const args = [
      "chat",
      "--no-interactive",
      "--agent",
      KIRO_EXPLORE_AGENT_NAME,
      ...(input.model === "auto" ? [] : ["--model", input.model]),
    ];
    const child = spawn(input.command, args, {
      cwd: agentDir,
      env: { ...process.env, NO_COLOR: "1" },
      signal: watchdog.signal,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    let stdout = "";
    const tracker = new KiroToolTracker();

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      // Tool calls are activity too: a long batch prints nothing on stdout.
      watchdog.touch();

      for (const name of tracker.push(chunk, stdout.length)) {
        input.onEvent?.({ type: "status", message: `Read ${name}` });
      }
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
    child.stdin.end(
      [
        input.systemPrompt,
        `The repository is at ${input.repoRoot}. Open files with absolute paths under it; nothing outside it is readable.`,
        input.userPrompt,
      ].join("\n\n"),
    );
    child.stdout.setEncoding("utf8");

    const reported = new Set<string>();
    // Only complete new lines are scanned for reads: re-parsing the whole
    // transcript per chunk is quadratic on a long exploration.
    let partial = "";

    try {
      for await (const chunk of raceAbort(
        child.stdout as AsyncIterable<string>,
        watchdog,
      )) {
        watchdog.touch();
        stdout += chunk;
        partial += chunk;

        const complete = partial.split("\n");

        partial = complete.pop() ?? "";

        for (const line of complete) {
          const file = readFromLine(cleanTranscript(line), input.repoRoot);

          if (file !== null && !reported.has(file)) {
            reported.add(file);
            input.onEvent?.({ type: "status", message: `Read ${file}` });
          }
        }
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
      }
    }

    if (watchdog.timeoutError !== null) {
      throw watchdog.timeoutError;
    }

    const { code, failure } = await exited;

    if (failure !== null) {
      throw new CliError(
        (failure as NodeJS.ErrnoException).code === "ENOENT"
          ? `The ${input.command} CLI is not installed or not on PATH.`
          : `Could not run ${input.command}: ${failure.message}`,
      );
    }

    if (AGENT_MISSING_PATTERN.test(stderr)) {
      throw new CliError(
        `${input.command} did not load Sinscribe's read-only agent, so it ` +
          `could have run with other tools. Refusing: ${stderr.trim()}`,
      );
    }

    if (code !== 0) {
      throw new CliError(
        `${input.command} chat exited with code ${code ?? "?"}: ` +
          `${stderr.trim().slice(0, 500) || "(no output)"}`,
      );
    }

    const result = isLegacyKiroTranscript(stdout, tracker.sawToolLine)
      ? parseKiroExploreOutput(stdout, input.repoRoot)
      : {
          text: parseModernKiroAnswer(stdout, tracker.answerOffset),
          filesRead: resolveReadNames(
            tracker.names,
            await listTrackedFiles(input.repoRoot),
          ),
        };

    if (result.text.length === 0) {
      throw new CliError(
        describeMissingAnswer(input.command, stdout, stderr, result.filesRead),
      );
    }

    return result;
  } finally {
    watchdog.dispose();
    await rm(agentDir, { recursive: true, force: true });
  }
}
