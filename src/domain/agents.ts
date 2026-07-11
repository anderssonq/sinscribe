import { access } from "node:fs/promises";
import path from "node:path";
import type { CommandSpec, GlobalFlags } from "../commands.js";
import { ensureGitRepo, getRepoRoot } from "../git/repo.js";
import { runAgent } from "../llm/agent.js";
import type { RunCallbacks } from "../llm/events.js";
import { createAgentsSystemPrompt } from "./prompts.js";

type AgentsSpec = Extract<CommandSpec, { name: "agents" }>;

function targetFiles(spec: AgentsSpec): string[] {
  if (spec.target === "claude") {
    return ["CLAUDE.md"];
  }

  if (spec.target === "agents") {
    return ["AGENTS.md"];
  }

  return ["CLAUDE.md", "AGENTS.md"];
}

export async function dryRunAgents(
  spec: AgentsSpec,
  cwd: string,
): Promise<string> {
  await ensureGitRepo(cwd);

  const repoRoot = (await getRepoRoot(cwd)) ?? cwd;
  const files = targetFiles(spec);
  const statuses = await Promise.all(
    files.map(async (file) => {
      const exists = await fileExists(path.join(repoRoot, file));

      return `  ${file.padEnd(10)} ${exists ? "exists (would merge/refresh)" : "missing (would create)"}`;
    }),
  );

  return [
    "sinscribe agents (dry run: no LLM call, no credentials read)",
    "",
    "Execution plan:",
    `  Repository:  ${repoRoot}`,
    `  Mode:        ${spec.update ? "surgical update" : "create/merge"}`,
    "  Agent:       repository-exploring agent; writes only the files below",
    "Target files:",
    ...statuses,
  ].join("\n");
}

export async function runAgents(
  spec: AgentsSpec,
  flags: GlobalFlags,
  cwd: string,
  callbacks: RunCallbacks = {},
): Promise<string> {
  await ensureGitRepo(cwd);

  const repoRoot = (await getRepoRoot(cwd)) ?? cwd;
  const { text } = await runAgent(
    createAgentsSystemPrompt(spec.target, spec.update),
    `${spec.update ? "Update" : "Generate"} the agent context file(s) ${targetFiles(
      spec,
    )
      .map((file) => `/${file}`)
      .join(" and ")} for the repository at ${repoRoot}.`,
    repoRoot,
    {
      modelId: flags.modelId,
      provider: flags.provider,
      apiKey: flags.apiKey,
      ...callbacks,
    },
  );

  return text.trim() || "Done.";
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);

    return true;
  } catch {
    return false;
  }
}
