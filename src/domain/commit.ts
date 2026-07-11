import type { CommandSpec, GlobalFlags } from "../commands.js";
import { getStagedDiff, getWorktreeDiff, type DiffInfo } from "../git/diff.js";
import { ensureGitRepo } from "../git/repo.js";
import type { RunCallbacks } from "../llm/events.js";
import { extractJsonObject, runSingleShot } from "../llm/single-shot.js";
import { CliError } from "./errors.js";
import { createCommitSystemPrompt } from "./prompts.js";

type CommitSpec = Extract<CommandSpec, { name: "commit" }>;

export const GITMOJI_BY_TYPE: Record<string, string> = {
  feat: "✨",
  fix: "🐛",
  docs: "📝",
  style: "🎨",
  refactor: "♻️",
  perf: "⚡️",
  test: "✅",
  build: "📦️",
  ci: "👷",
  chore: "🔧",
  revert: "⏪️",
};

const COMMIT_TYPES = Object.keys(GITMOJI_BY_TYPE);

async function gatherCommitDiff(
  spec: CommitSpec,
  cwd: string,
): Promise<DiffInfo> {
  await ensureGitRepo(cwd);

  const diff = spec.all ? await getWorktreeDiff(cwd) : await getStagedDiff(cwd);

  if (diff.isEmpty) {
    throw new CliError(
      spec.all
        ? "No tracked changes found. Nothing to commit."
        : "Nothing staged. Stage changes with `git add`, or pass --all to use all tracked changes.",
    );
  }

  return diff;
}

export async function dryRunCommit(
  spec: CommitSpec,
  cwd: string,
): Promise<string> {
  const diff = await gatherCommitDiff(spec, cwd);
  const skeleton = `${spec.gitmoji ? "<gitmoji> " : ""}<type>${spec.scope ? `(${spec.scope})` : "(<scope>)"}: <subject>\n\n<body?>`;

  return [
    "sinscribe commit (dry run: no LLM call, no credentials read)",
    "",
    `Source:    ${spec.all ? "all tracked changes (--all)" : "staged changes"}`,
    `Files:`,
    diff.nameStatus,
    "",
    `Stats:     ${diff.stat.split("\n").at(-1)?.trim() ?? ""}${diff.truncated ? " [truncated for prompt]" : ""}`,
    "",
    "Message skeleton the model would fill:",
    "---",
    skeleton,
    "---",
  ].join("\n");
}

export async function runCommit(
  spec: CommitSpec,
  flags: GlobalFlags,
  cwd: string,
  callbacks: RunCallbacks = {},
): Promise<string> {
  const diff = await gatherCommitDiff(spec, cwd);
  const userPrompt = [
    spec.scope ? `Required scope: ${spec.scope}` : null,
    "Changed files:",
    diff.nameStatus,
    "",
    "Diff:",
    diff.patch,
  ]
    .filter((line) => line !== null)
    .join("\n");

  const { text } = await runSingleShot(
    createCommitSystemPrompt(spec.gitmoji),
    userPrompt,
    {
      modelId: flags.modelId,
      provider: flags.provider,
      apiKey: flags.apiKey,
      debug: callbacks.debug,
    },
  );
  const parsed = extractJsonObject(text);
  const type =
    typeof parsed.type === "string" && COMMIT_TYPES.includes(parsed.type)
      ? parsed.type
      : "chore";
  const scope =
    spec.scope ??
    (typeof parsed.scope === "string" && parsed.scope.trim().length > 0
      ? parsed.scope.trim()
      : null);
  const subject =
    typeof parsed.subject === "string" ? parsed.subject.trim() : "";

  if (subject.length === 0) {
    throw new CliError(
      `Model did not produce a commit subject. Raw output:\n${text.slice(0, 500)}`,
    );
  }

  const body = typeof parsed.body === "string" ? parsed.body.trim() : "";
  const breaking =
    typeof parsed.breaking === "string" ? parsed.breaking.trim() : "";
  const gitmoji = spec.gitmoji ? `${GITMOJI_BY_TYPE[type] ?? "🔧"} ` : "";
  const header = `${gitmoji}${type}${scope ? `(${scope})` : ""}${breaking ? "!" : ""}: ${subject}`;
  const sections = [header];

  if (body) {
    sections.push("", body);
  }

  if (breaking) {
    sections.push("", `BREAKING CHANGE: ${breaking}`);
  }

  return sections.join("\n");
}
