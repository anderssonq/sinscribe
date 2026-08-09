import {
  isValidModelId,
  normalizeModelId,
  normalizeProvider,
  type SinscribeProvider,
} from "./constants.js";
import { isBranchType, type BranchType } from "./git/ticket.js";

export type GlobalFlags = {
  dryRun: boolean;
  print: boolean;
  modelId: string | null;
  provider: SinscribeProvider | null;
  apiKey: string | null;
};

export type CommandSpec =
  | { name: "chat"; message: string | null }
  | {
      name: "pr";
      template: string;
      base: string | null;
      ticket: string | null;
      staged: boolean;
      out: string | null;
    }
  | {
      name: "prompt";
      type: "feature" | "bugfix" | null;
      description: string | null;
      out: string | null;
      /** Write HANDOFF.md without asking — the only route in print mode. */
      handoff: boolean;
    }
  | { name: "commit"; all: boolean; scope: string | null; gitmoji: boolean }
  | { name: "branch"; input: string; type: BranchType | null }
  | { name: "context"; out: string | null; format: "md" | "json" }
  | { name: "docs"; out: string | null }
  | {
      name: "agents";
      target: "claude" | "agents" | "both";
      update: boolean;
    }
  | { name: "agent-setup" }
  | {
      name: "template";
      action: "list" | "show" | "add" | "edit" | "path";
      templateName: string | null;
      from: string | null;
    };

export type CliCommand =
  | { kind: "help"; exitCode: 0 }
  | { kind: "version"; exitCode: 0 }
  | { kind: "error"; exitCode: 1; message: string }
  | { kind: "run"; exitCode: 0; command: CommandSpec; flags: GlobalFlags };

const SUBCOMMANDS = [
  "pr",
  "prompt",
  "commit",
  "branch",
  "context",
  "docs",
  "agents",
  "agent-setup",
  "template",
] as const;

type Subcommand = (typeof SUBCOMMANDS)[number];

export function parseCommand(argv: string[]): CliCommand {
  const flags: GlobalFlags = {
    dryRun: false,
    print: false,
    modelId: null,
    provider: null,
    apiKey: null,
  };
  const rest: string[] = [];
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--version" || arg === "-v") {
      return { kind: "version", exitCode: 0 };
    }

    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }

    if (arg === "--dry-run") {
      flags.dryRun = true;
      continue;
    }

    if (arg === "--print" || arg === "-p") {
      flags.print = true;
      continue;
    }

    if (arg === "--model-id" || arg === "--modelId") {
      const nextArg = argv[index + 1];

      if (!nextArg || nextArg.startsWith("-")) {
        return error(`${arg} requires a model ID.`);
      }

      const modelId = normalizeModelId(nextArg);

      if (!isValidModelId(modelId)) {
        return error(`Invalid model ID: ${nextArg}`);
      }

      flags.modelId = modelId;
      index += 1;
      continue;
    }

    if (arg.startsWith("--model-id=") || arg.startsWith("--modelId=")) {
      const [, rawModelId = ""] = arg.split("=", 2);
      const modelId = normalizeModelId(rawModelId);

      if (!isValidModelId(modelId)) {
        return error(`Invalid model ID: ${rawModelId}`);
      }

      flags.modelId = modelId;
      continue;
    }

    if (arg === "--provider") {
      const nextArg = argv[index + 1];
      const provider = nextArg ? normalizeProvider(nextArg) : null;

      if (!nextArg || nextArg.startsWith("-") || provider === null) {
        return error(`${arg} requires a valid provider name.`);
      }

      flags.provider = provider;
      index += 1;
      continue;
    }

    if (arg.startsWith("--provider=")) {
      const [, rawProvider = ""] = arg.split("=", 2);
      const provider = normalizeProvider(rawProvider);

      if (provider === null) {
        return error(`Invalid provider: ${rawProvider}`);
      }

      flags.provider = provider;
      continue;
    }

    if (arg === "--api-key") {
      const nextArg = argv[index + 1];

      if (!nextArg || nextArg.startsWith("-")) {
        return error(`${arg} requires an API key.`);
      }

      flags.apiKey = nextArg;
      index += 1;
      continue;
    }

    if (arg.startsWith("--api-key=")) {
      const [, rawApiKey = ""] = arg.split("=", 2);

      if (rawApiKey.length === 0) {
        return error("--api-key requires a value.");
      }

      flags.apiKey = rawApiKey;
      continue;
    }

    rest.push(arg);
  }

  if (help && rest.length === 0) {
    return { kind: "help", exitCode: 0 };
  }

  const [first, ...args] = rest;

  if (first === undefined || !isSubcommand(first)) {
    // No subcommand: interactive chat (optionally with a startup message).
    const unknownFlag = rest.find((arg) => arg.startsWith("-"));

    if (unknownFlag) {
      return error(`Unknown option: ${unknownFlag}`);
    }

    if (help) {
      return { kind: "help", exitCode: 0 };
    }

    const message = rest.length > 0 ? rest.join(" ") : null;

    if (flags.print && message === null) {
      return error("-p, --print requires a message or a subcommand.");
    }

    return run({ name: "chat", message }, flags);
  }

  if (help) {
    return { kind: "help", exitCode: 0 };
  }

  const parsed = parseSubcommand(first, args);

  if ("kind" in parsed) {
    return parsed;
  }

  return run(parsed, flags);
}

function parseSubcommand(
  name: Subcommand,
  args: string[],
): CommandSpec | Extract<CliCommand, { kind: "error" }> {
  switch (name) {
    case "pr":
      return parsePr(args);
    case "prompt":
      return parsePrompt(args);
    case "commit":
      return parseCommit(args);
    case "branch":
      return parseBranch(args);
    case "context":
      return parseContext(args);
    case "docs":
      return parseDocs(args);
    case "agents":
      return parseAgents(args);
    case "agent-setup":
      return parseAgentSetup(args);
    case "template":
      return parseTemplate(args);
  }
}

function parsePr(
  args: string[],
): CommandSpec | Extract<CliCommand, { kind: "error" }> {
  let template = "andersoftware";
  let base: string | null = null;
  let ticket: string | null = null;
  let staged = false;
  let out: string | null = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = () => takeValue(args, index);

    switch (arg) {
      case "--template": {
        const taken = value();

        if (taken === null) {
          return error("--template requires a template name.");
        }

        template = taken;
        index += 1;
        break;
      }
      case "--base": {
        const taken = value();

        if (taken === null) {
          return error("--base requires a git ref.");
        }

        base = taken;
        index += 1;
        break;
      }
      case "--ticket": {
        const taken = value();

        if (taken === null) {
          return error("--ticket requires a ticket ID.");
        }

        ticket = taken;
        index += 1;
        break;
      }
      case "--staged": {
        staged = true;
        break;
      }
      case "--out": {
        const taken = value();

        if (taken === null) {
          return error("--out requires a file path.");
        }

        out = taken;
        index += 1;
        break;
      }
      default:
        return error(`Unknown option for pr: ${arg}`);
    }
  }

  return { name: "pr", template, base, ticket, staged, out };
}

function parsePrompt(
  args: string[],
): CommandSpec | Extract<CliCommand, { kind: "error" }> {
  let type: "feature" | "bugfix" | null = null;
  let out: string | null = null;
  let handoff = false;
  const descriptionParts: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--type") {
      const taken = takeValue(args, index);

      if (taken !== "feature" && taken !== "bugfix") {
        return error("--type must be feature or bugfix.");
      }

      type = taken;
      index += 1;
      continue;
    }

    if (arg === "--out") {
      const taken = takeValue(args, index);

      if (taken === null) {
        return error("--out requires a file path.");
      }

      out = taken;
      index += 1;
      continue;
    }

    if (arg === "--handoff") {
      handoff = true;
      continue;
    }

    if (arg.startsWith("-")) {
      return error(`Unknown option for prompt: ${arg}`);
    }

    descriptionParts.push(arg);
  }

  // The description is optional: interactive runs ask for it in the flow,
  // and print mode falls back to the saved session context.
  return {
    name: "prompt",
    type,
    description:
      descriptionParts.length > 0 ? descriptionParts.join(" ") : null,
    out,
    handoff,
  };
}

function parseCommit(
  args: string[],
): CommandSpec | Extract<CliCommand, { kind: "error" }> {
  let all = false;
  let scope: string | null = null;
  let gitmoji = true;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--all" || arg === "-a") {
      all = true;
      continue;
    }

    if (arg === "--no-gitmoji") {
      gitmoji = false;
      continue;
    }

    if (arg === "--scope") {
      const taken = takeValue(args, index);

      if (taken === null) {
        return error("--scope requires a scope name.");
      }

      scope = taken;
      index += 1;
      continue;
    }

    return error(`Unknown option for commit: ${arg}`);
  }

  return { name: "commit", all, scope, gitmoji };
}

function parseBranch(
  args: string[],
): CommandSpec | Extract<CliCommand, { kind: "error" }> {
  let type: BranchType | null = null;
  const inputParts: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--type") {
      const taken = takeValue(args, index);

      if (taken === null || !isBranchType(taken)) {
        return error(
          "--type requires one of: feat, fix, chore, docs, refactor, test, perf, build, ci, hotfix.",
        );
      }

      type = taken;
      index += 1;
      continue;
    }

    if (arg.startsWith("-")) {
      return error(`Unknown option for branch: ${arg}`);
    }

    inputParts.push(arg);
  }

  if (inputParts.length === 0) {
    return error("branch requires a ticket ID and/or a short description.");
  }

  return { name: "branch", input: inputParts.join(" "), type };
}

function parseContext(
  args: string[],
): CommandSpec | Extract<CliCommand, { kind: "error" }> {
  let out: string | null = null;
  let format: "md" | "json" = "md";

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--out") {
      const taken = takeValue(args, index);

      if (taken === null) {
        return error("--out requires a file path.");
      }

      out = taken;
      index += 1;
      continue;
    }

    if (arg === "--format") {
      const taken = takeValue(args, index);

      if (taken !== "md" && taken !== "json") {
        return error("--format must be md or json.");
      }

      format = taken;
      index += 1;
      continue;
    }

    return error(`Unknown option for context: ${arg}`);
  }

  return { name: "context", out, format };
}

function parseDocs(
  args: string[],
): CommandSpec | Extract<CliCommand, { kind: "error" }> {
  let out: string | null = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--out") {
      const taken = takeValue(args, index);

      if (taken === null) {
        return error("--out requires a file path.");
      }

      out = taken;
      index += 1;
      continue;
    }

    return error(`Unknown option for docs: ${arg}`);
  }

  return { name: "docs", out };
}

function parseAgents(
  args: string[],
): CommandSpec | Extract<CliCommand, { kind: "error" }> {
  let target: "claude" | "agents" | "both" = "both";
  let update = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--update") {
      update = true;
      continue;
    }

    if (arg === "--target") {
      const taken = takeValue(args, index);

      if (taken !== "claude" && taken !== "agents" && taken !== "both") {
        return error("--target must be claude, agents, or both.");
      }

      target = taken;
      index += 1;
      continue;
    }

    return error(`Unknown option for agents: ${arg}`);
  }

  return { name: "agents", target, update };
}

function parseAgentSetup(
  args: string[],
): CommandSpec | Extract<CliCommand, { kind: "error" }> {
  // No options yet: the roster and the answers come from the interactive
  // flow, and everything else is discovered from the repository.
  if (args.length > 0) {
    return error(`Unknown option for agent-setup: ${args[0]}`);
  }

  return { name: "agent-setup" };
}

function parseTemplate(
  args: string[],
): CommandSpec | Extract<CliCommand, { kind: "error" }> {
  const [action, ...actionArgs] = args;

  if (
    action !== "list" &&
    action !== "show" &&
    action !== "add" &&
    action !== "edit" &&
    action !== "path"
  ) {
    return error("template requires an action: list, show, add, edit, path.");
  }

  let templateName: string | null = null;
  let from: string | null = null;

  for (let index = 0; index < actionArgs.length; index += 1) {
    const arg = actionArgs[index];

    if (arg === "--from") {
      const taken = takeValue(actionArgs, index);

      if (taken === null) {
        return error("--from requires a file path.");
      }

      from = taken;
      index += 1;
      continue;
    }

    if (arg.startsWith("-")) {
      return error(`Unknown option for template ${action}: ${arg}`);
    }

    if (templateName !== null) {
      return error(`Unexpected argument: ${arg}`);
    }

    templateName = arg;
  }

  if (
    (action === "show" || action === "add" || action === "edit") &&
    templateName === null
  ) {
    return error(`template ${action} requires a template name.`);
  }

  return { name: "template", action, templateName, from };
}

function takeValue(args: string[], index: number): string | null {
  const next = args[index + 1];

  return next === undefined || next.startsWith("--") ? null : next;
}

function isSubcommand(value: string): value is Subcommand {
  return (SUBCOMMANDS as readonly string[]).includes(value);
}

function error(message: string): Extract<CliCommand, { kind: "error" }> {
  return { kind: "error", exitCode: 1, message };
}

function run(command: CommandSpec, flags: GlobalFlags): CliCommand {
  return { kind: "run", exitCode: 0, command, flags };
}

export function getHelpText(): string {
  return `sinscribe
  Git-centric developer-workflow assistant: PR descriptions, commit messages,
  branch names, feature/bugfix prompts for AI agents, project context briefs,
  project documentation, and AI agent context files.

Usage
  sinscribe                                Interactive chat/agent mode
  sinscribe pr [options]                   Generate a PR/MR description from local changes vs the target branch
                                           (interactive runs review the draft: approve, refine with feedback,
                                           then optionally export PR_DESCRIPTION.md and/or copy to the clipboard)
  sinscribe prompt [options] [description] Generate a copy-ready feature/bugfix task prompt for an AI coding agent
                                           (interactive runs review the draft, then optionally export
                                           AGENT_PROMPT.md and/or copy to the clipboard, and update HANDOFF.md;
                                           without a description, the saved session context is used)
  sinscribe commit [options]               Generate a commit message from staged changes
  sinscribe branch <ticket|description>    Suggest branch names
  sinscribe context [options]              Extract a structured project-context brief
  sinscribe docs [options]                 Generate project documentation (markdown + mermaid diagrams)
  sinscribe agents [options]               Scaffold/update CLAUDE.md and AGENTS.md
  sinscribe agent-setup                    Analyze the project and generate specialized agent definitions
                                           in .claude/agents (interactive runs ask what the code cannot
                                           tell them first; -p/--print skips the questions)
  sinscribe template <action> [name]       Manage the template library

Command options
  pr        --template <name>   Template to use (default: andersoftware)
            --base <ref>        Target branch to diff against (default: session context, else auto-detect)
            --staged            Diff only staged changes (default: all local changes)
            --ticket <id>       Ticket ID (default: parsed from branch name)
            --out <file>        Write the description to a file
  prompt    --type <type>       feature|bugfix (default: inferred from the description)
            --out <file>        Write the prompt to a file
            --handoff           Also write HANDOFF.md, the branch's session handoff
                                (interactive runs offer this after approval)
  commit    --all, -a           Use all tracked changes, not only staged
            --scope <scope>     Force the conventional-commit scope
            --no-gitmoji        Skip the gitmoji prefix
  branch    --type <type>       feat|fix|chore|docs|refactor|test|perf|build|ci|hotfix
  context   --out <file>        Write the brief to a file
            --format <md|json>  Output format (default: md)
  docs      --out <file>        Write the documentation to a file
                                (interactive runs offer PROJECT_DOCUMENTATION.md / clipboard export)
  agents    --target <t>        claude|agents|both (default: both)
            --update            Surgically refresh existing files
  agent-setup                   (no options)
  template  list                List available templates
            show <name>         Print a template
            add <name> [--from <file>]  Add a user template
            edit <name>         Open a template in $EDITOR
            path                Print template directories

Global options
  -p, --print          Run once, print the result, exit
  --dry-run            No LLM call, no credentials: print a deterministic scaffold
  --model-id <id>      Model ID for this run
  --provider <name>    Provider override for this run (not persisted)
  --api-key <key>      API key override for this run (not persisted)
  -v, --version        Print the sinscribe version
  -h, --help           Show this help

Examples
  sinscribe pr --template github
  sinscribe pr --base develop --staged
  sinscribe pr --dry-run
  sinscribe commit
  sinscribe branch ABC-123 add retry logic to uploader
  sinscribe prompt --type bugfix uploader crashes on empty files
  sinscribe prompt --handoff -p "add retry logic to the uploader"
  sinscribe context --out CONTEXT.md
  sinscribe docs
  sinscribe agents --target claude
  sinscribe agent-setup
  sinscribe template list
  sinscribe -p "Summarize what sinscribe can do"
  sinscribe pr --provider anthropic --api-key sk-ant-...`;
}
