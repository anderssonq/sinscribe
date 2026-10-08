import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { CliError } from "../../domain/errors.js";
import { sinscribeEnvDir } from "../../env.js";
import { EXPLORE_DENY_GLOBS } from "../claude-cli/explore.js";
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
 * Verified against kiro-cli 2.3.0, with the config below:
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
 */

export const KIRO_EXPLORE_AGENT_NAME = "sinscribe-readonly";

const AGENT_MISSING_PATTERN = /no agent with name|agent .* not found/iu;

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

function cleanTranscript(raw: string): string {
  return raw.replace(ANSI, "").replace(/\r/gu, "");
}

/** The repo-relative file a "✓ Successfully read" line confirms, if any. */
function readFromLine(line: string, repoRoot: string): string | null {
  const file = READ_OK.exec(line)?.[1]?.trim();
  const root = repoRoot.replace(/\/+$/u, "");

  return file?.startsWith(`${root}/`) ? file.slice(root.length + 1) : null;
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

    const result = parseKiroExploreOutput(stdout, input.repoRoot);

    if (result.text.length === 0) {
      throw new CliError(`${input.command} explored but returned no answer.`);
    }

    return result;
  } finally {
    watchdog.dispose();
    await rm(agentDir, { recursive: true, force: true });
  }
}
