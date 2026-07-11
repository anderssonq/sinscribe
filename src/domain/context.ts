import { writeFile } from "node:fs/promises";
import type { CommandSpec, GlobalFlags } from "../commands.js";
import { ensureGitRepo } from "../git/repo.js";
import { runAgent } from "../llm/agent.js";
import type { RunCallbacks } from "../llm/events.js";
import { CliError } from "./errors.js";
import { createContextSystemPrompt } from "./prompts.js";

type ContextSpec = Extract<CommandSpec, { name: "context" }>;

export async function dryRunContext(
  spec: ContextSpec,
  cwd: string,
): Promise<string> {
  await ensureGitRepo(cwd);

  return [
    "sinscribe context (dry run: no LLM call, no credentials read)",
    "",
    "Execution plan:",
    `  Repository:  ${cwd}`,
    "  Agent:       repository-exploring agent (read-only: ls, glob, grep, read_file, git)",
    "  Inspects:    manifests, entrypoints, folder layout, scripts, CI, docs, sample sources",
    `  Output:      project-context brief (${spec.format})${spec.out ? ` -> ${spec.out}` : " -> stdout"}`,
    "  Writes:      no repository files",
    "  Secrets:     .env files are never read",
  ].join("\n");
}

export async function runContext(
  spec: ContextSpec,
  flags: GlobalFlags,
  cwd: string,
  callbacks: RunCallbacks = {},
): Promise<string> {
  await ensureGitRepo(cwd);

  const { text } = await runAgent(
    createContextSystemPrompt(spec.format),
    `Produce the project-context brief for the repository at ${cwd}.`,
    cwd,
    {
      modelId: flags.modelId,
      provider: flags.provider,
      apiKey: flags.apiKey,
      ...callbacks,
    },
  );

  if (text.trim().length === 0) {
    throw new CliError("The agent produced no output.");
  }

  if (spec.out) {
    await writeFile(spec.out, `${text.trim()}\n`, "utf8");

    return `Wrote project context to ${spec.out}`;
  }

  return text.trim();
}
