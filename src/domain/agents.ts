import { access, readFile } from "node:fs/promises";
import path from "node:path";
import type { CommandSpec, GlobalFlags } from "../commands.js";
import { ensureGitRepo, getRepoRoot } from "../git/repo.js";
import { runAgent } from "../llm/agent.js";
import type { RunCallbacks } from "../llm/events.js";
import { agentsMdReaders } from "../standards/registry.js";
import {
  formatStandardsReport,
  validateAgainstStandard,
} from "../standards/validate.js";
import { createAgentsSystemPrompt } from "./prompts.js";
import { describeRulesForDryRun, loadRules } from "./rules.js";

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
  const rulesSummary = await loadRules(repoRoot);
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
    `  Rules:       ${describeRulesForDryRun(rulesSummary)}`,
    "Target files:",
    ...statuses,
    ...(spec.target === "claude" ? [] : describeAgentsMdReaders()),
  ].join("\n");
}

/**
 * Why one AGENTS.md is enough: the tools that read it natively, from the
 * standards registry, so the dry run says where the file will be used.
 */
function describeAgentsMdReaders(): string[] {
  return [
    "AGENTS.md is read by:",
    "  Codex          native format",
    ...agentsMdReaders().map(({ tool, how }) => `  ${tool.padEnd(14)} ${how}`),
  ];
}

export async function runAgents(
  spec: AgentsSpec,
  flags: GlobalFlags,
  cwd: string,
  callbacks: RunCallbacks = {},
): Promise<string> {
  await ensureGitRepo(cwd);

  const repoRoot = (await getRepoRoot(cwd)) ?? cwd;
  const rulesSummary = await loadRules(repoRoot);
  const { text } = await runAgent(
    createAgentsSystemPrompt(spec.target, spec.update, rulesSummary.combined),
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

  const report = formatStandardsReport(await checkWrittenFiles(repoRoot, spec));

  return `${text.trim() || "Done."}${report}`;
}

/**
 * Checks what the agent wrote against the standards in src/standards: line
 * limits for both files, and — when both were written — that CLAUDE.md
 * imports AGENTS.md instead of duplicating it. A missing file is skipped: the
 * agent's own summary already says what it did or did not write.
 */
export async function checkWrittenFiles(
  repoRoot: string,
  spec: AgentsSpec,
): Promise<Array<{ file: string; warnings: string[] }>> {
  const findings: Array<{ file: string; warnings: string[] }> = [];

  for (const file of targetFiles(spec)) {
    let content: string;

    try {
      content = await readFile(path.join(repoRoot, file), "utf8");
    } catch {
      continue;
    }

    const warnings = validateAgainstStandard(
      file === "CLAUDE.md" ? "claude-md" : "agents-md",
      content,
    );

    if (
      spec.target === "both" &&
      file === "CLAUDE.md" &&
      !IMPORTS_AGENTS_MD.test(content)
    ) {
      warnings.push(
        'does not import "@AGENTS.md"; the two files may drift apart',
      );
    }

    findings.push({ file, warnings });
  }

  // Claude Code skips AGENTS.md whenever a CLAUDE.md exists, so a fresh
  // AGENTS.md next to a CLAUDE.md that does not import it is invisible there.
  if (spec.target === "agents") {
    try {
      const claude = await readFile(path.join(repoRoot, "CLAUDE.md"), "utf8");

      if (!IMPORTS_AGENTS_MD.test(claude)) {
        findings.push({
          file: "CLAUDE.md",
          warnings: [
            'exists without "@AGENTS.md", so Claude Code will not read AGENTS.md — add that line or run with --target both',
          ],
        });
      }
    } catch {
      // No CLAUDE.md: Claude Code reads AGENTS.md directly.
    }
  }

  return findings;
}

/** A line that is exactly Claude Code's import of AGENTS.md. */
const IMPORTS_AGENTS_MD = /^@AGENTS\.md\s*$/mu;

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);

    return true;
  } catch {
    return false;
  }
}
