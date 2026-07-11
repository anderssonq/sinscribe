import { writeFile } from "node:fs/promises";
import type { CommandSpec, GlobalFlags } from "../commands.js";
import { ensureGitRepo } from "../git/repo.js";
import { runAgent } from "../llm/agent.js";
import type { RunCallbacks } from "../llm/events.js";
import { CliError } from "./errors.js";
import { createDocsSystemPrompt } from "./prompts.js";

type DocsSpec = Extract<CommandSpec, { name: "docs" }>;

export async function dryRunDocs(spec: DocsSpec, cwd: string): Promise<string> {
  await ensureGitRepo(cwd);

  return [
    "sinscribe docs (dry run: no LLM call, no credentials read)",
    "",
    "Execution plan:",
    `  Repository:  ${cwd}`,
    "  Agent:       repository-exploring agent (read-only: ls, glob, grep, read_file, git)",
    "  Inspects:    manifests, entrypoints, module layout, scripts, CI, existing docs, sample sources",
    "  Produces:    project documentation (overview, architecture, data flow,",
    "               module dependencies — with mermaid diagrams, getting started, workflows)",
    `  Output:      markdown document${spec.out ? ` -> ${spec.out}` : " -> stdout (interactive runs offer an export)"}`,
    "  Writes:      no repository files (the CLI writes the export, not the agent)",
    "  Secrets:     .env files are never read",
  ].join("\n");
}

export async function runDocs(
  spec: DocsSpec,
  flags: GlobalFlags,
  cwd: string,
  callbacks: RunCallbacks = {},
): Promise<string> {
  await ensureGitRepo(cwd);

  const { text } = await runAgent(
    createDocsSystemPrompt(),
    `Produce the project documentation for the repository at ${cwd}.`,
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

    return `Wrote project documentation to ${spec.out}`;
  }

  return text.trim();
}
