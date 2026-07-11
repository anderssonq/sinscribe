import type { CommandSpec, GlobalFlags } from "../commands.js";
import type { RunCallbacks } from "../llm/events.js";
import { runAgent } from "../llm/agent.js";
import { dryRunAgents, runAgents } from "./agents.js";
import { dryRunBranch, runBranch } from "./branch.js";
import { dryRunCommit, runCommit } from "./commit.js";
import { dryRunContext, runContext } from "./context.js";
import { dryRunDocs, runDocs } from "./docs.js";
import { dryRunPr, runPr } from "./pr.js";
import { dryRunPrompt, runPrompt } from "./prompt.js";
import { createChatSystemPrompt } from "./prompts.js";
import { runTemplateCommand } from "./template.js";

/** Deterministic scaffold output: no LLM call, no credential read. */
export async function executeDryRun(
  command: CommandSpec,
  cwd: string,
): Promise<string> {
  switch (command.name) {
    case "pr":
      return dryRunPr(command, cwd);
    case "prompt":
      return dryRunPrompt(command, cwd);
    case "commit":
      return dryRunCommit(command, cwd);
    case "branch":
      return dryRunBranch(command, cwd);
    case "context":
      return dryRunContext(command, cwd);
    case "docs":
      return dryRunDocs(command, cwd);
    case "agents":
      return dryRunAgents(command, cwd);
    case "template":
      return runTemplateCommand(command, cwd, true);
    case "chat":
      return [
        "sinscribe chat (dry run: no LLM call, no credentials read)",
        "",
        `Message: ${command.message ?? "(interactive session)"}`,
        "Agent:   repository chat agent (read-only exploration)",
      ].join("\n");
  }
}

export async function executeCommand(
  command: CommandSpec,
  flags: GlobalFlags,
  cwd: string,
  callbacks: RunCallbacks = {},
  threadId?: string,
): Promise<string> {
  switch (command.name) {
    case "pr":
      return runPr(command, flags, cwd, callbacks);
    case "prompt":
      return runPrompt(command, flags, cwd, callbacks);
    case "commit":
      return runCommit(command, flags, cwd, callbacks);
    case "branch":
      return runBranch(command, flags, cwd, callbacks);
    case "context":
      return runContext(command, flags, cwd, callbacks);
    case "docs":
      return runDocs(command, flags, cwd, callbacks);
    case "agents":
      return runAgents(command, flags, cwd, callbacks);
    case "template":
      return runTemplateCommand(command, cwd, false);
    case "chat": {
      const { text } = await runAgent(
        createChatSystemPrompt(),
        command.message ?? "Introduce yourself in two sentences.",
        cwd,
        {
          modelId: flags.modelId,
          provider: flags.provider,
          apiKey: flags.apiKey,
          threadId,
          ...callbacks,
        },
      );

      return text;
    }
  }
}

/** True when the command streams agent tool activity worth showing live. */
export function isAgenticCommand(command: CommandSpec): boolean {
  return (
    command.name === "context" ||
    command.name === "docs" ||
    command.name === "agents" ||
    command.name === "chat"
  );
}

/** template never needs credentials or a model. */
export function isOfflineCommand(command: CommandSpec): boolean {
  return command.name === "template";
}
