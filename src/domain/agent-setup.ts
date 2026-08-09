import { access, readdir } from "node:fs/promises";
import path from "node:path";
import type { GlobalFlags } from "../commands.js";
import { ensureGitRepo, getRepoRoot } from "../git/repo.js";
import { runAgent } from "../llm/agent.js";
import type { RunCallbacks } from "../llm/events.js";
import { extractJsonObject } from "../llm/single-shot.js";
import { CliError } from "./errors.js";
import {
  createAgentPlanSystemPrompt,
  createAgentWriteSystemPrompt,
} from "./prompts.js";
import { describeRulesForDryRun, loadRules } from "./rules.js";

/**
 * "Set up project agents": analyze the repository, ask the author what the
 * code cannot tell us, then write one specialized agent definition per role.
 *
 * Two agent passes rather than one, because the deepagents loop has no
 * human-in-the-loop interrupt — the model cannot stop mid-run to ask a
 * question. The first pass reports what it needs; the UI collects the answers;
 * the second pass writes with them in hand.
 */

/** Directory the definitions live in, relative to the repository root. */
export const AGENT_DIR = path.join(".claude", "agents");

/**
 * Caps on what the model may propose. The plan is untrusted output: an
 * oversized roster would fan out into that many files and that many questions
 * into an interview nobody finishes.
 */
const MAX_ROSTER = 8;
const MAX_QUESTIONS = 6;
/** Long enough for a real question, short enough that no view has to window it. */
const MAX_FIELD_CHARS = 400;

export type PlannedAgent = {
  /** Slug; also the file name (`<id>.md`). */
  id: string;
  label: string;
  role: string;
};

export type PlannedQuestion = {
  id: string;
  question: string;
  /** Why the model needs it — shown under the prompt so the ask makes sense. */
  why: string;
  /** Free-form answers get the multi-line prompt; short facts get one line. */
  multiline: boolean;
};

export type AgentPlan = {
  /** Frameworks/tools detected in the repository, for display only. */
  stack: string[];
  roster: PlannedAgent[];
  questions: PlannedQuestion[];
};

export type Answer = { question: string; answer: string };

/** Path a definition is written to. */
export function agentFilePath(repoRoot: string, id: string): string {
  return path.join(repoRoot, AGENT_DIR, `${id}.md`);
}

/** The same path as the agent addresses it: virtual-rooted at the repo. */
export function agentVirtualPath(id: string): string {
  return `/${AGENT_DIR.split(path.sep).join("/")}/${id}.md`;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string"
    ? value.trim().slice(0, MAX_FIELD_CHARS)
    : fallback;
}

/**
 * Slug an id down to something that is safe as a file name AND meaningful.
 * Returns null when nothing usable survives — the caller drops the entry.
 *
 * This is the security boundary for the write pass: whatever the model
 * proposes becomes a path, so anything that could climb out of AGENT_DIR
 * ("../../.ssh/config", "/etc/passwd", "a/b") must not survive. Slashes and
 * dots are stripped rather than rejected outright so a merely sloppy id still
 * produces a file.
 */
export function normalizeAgentId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 40)
    .replace(/-+$/u, "");

  // Must still start with a letter: a leading digit is a valid file name but
  // reads as a version, and the frontmatter `name` inherits this.
  return /^[a-z][a-z0-9-]*$/u.test(slug) ? slug : null;
}

function normalizeRoster(value: unknown): PlannedAgent[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const roster: PlannedAgent[] = [];

  for (const entry of value) {
    if (roster.length >= MAX_ROSTER) {
      break;
    }

    if (typeof entry !== "object" || entry === null) {
      continue;
    }

    const record = entry as Record<string, unknown>;
    const id = normalizeAgentId(record.id ?? record.name);

    if (id === null || seen.has(id)) {
      continue;
    }

    const role = asString(record.role ?? record.why);

    if (role.length === 0) {
      continue;
    }

    seen.add(id);
    roster.push({ id, label: asString(record.label, id) || id, role });
  }

  return roster;
}

function normalizeQuestions(value: unknown): PlannedQuestion[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const questions: PlannedQuestion[] = [];

  for (const entry of value) {
    if (questions.length >= MAX_QUESTIONS) {
      break;
    }

    if (typeof entry !== "object" || entry === null) {
      continue;
    }

    const record = entry as Record<string, unknown>;
    const question = asString(record.question);

    if (question.length === 0) {
      continue;
    }

    // Ids only have to be unique keys here, so fall back to the position
    // rather than dropping an otherwise good question.
    const id = normalizeAgentId(record.id) ?? `q-${questions.length + 1}`;

    if (seen.has(id)) {
      continue;
    }

    seen.add(id);
    questions.push({
      id,
      question,
      why: asString(record.why),
      // Anything but an explicit `false` stays multi-line: an over-roomy
      // prompt costs nothing, a one-line box for a paragraph is a trap.
      multiline: record.multiline !== false,
    });
  }

  return questions;
}

function normalizeStack(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => asString(entry))
    .filter((entry) => entry.length > 0)
    .slice(0, 12);
}

/**
 * Parses the analysis pass's final message into a plan. Pure and total: model
 * output is untrusted, so malformed entries are dropped rather than thrown on,
 * and only a plan with no usable agents at all is an error worth surfacing.
 */
export function parseAgentPlan(raw: string): AgentPlan {
  const parsed = extractJsonObject(raw);
  const plan: AgentPlan = {
    stack: normalizeStack(parsed.stack),
    roster: normalizeRoster(parsed.roster ?? parsed.agents),
    questions: normalizeQuestions(parsed.questions),
  };

  if (plan.roster.length === 0) {
    throw new CliError(
      "The analysis did not propose any agents for this project. Try again, or run it from the repository root.",
    );
  }

  return plan;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);

    return true;
  } catch {
    return false;
  }
}

/** Which of these ids already have a definition on disk. */
export async function findExistingAgentFiles(
  repoRoot: string,
  ids: string[],
): Promise<string[]> {
  const found = await Promise.all(
    ids.map(async (id) =>
      (await fileExists(agentFilePath(repoRoot, id))) ? id : null,
    ),
  );

  return found.filter((id): id is string => id !== null);
}

/** How many definitions the project already has (drives the menu's done state). */
export async function countAgentFiles(repoRoot: string): Promise<number> {
  try {
    const entries = await readdir(path.join(repoRoot, AGENT_DIR));

    return entries.filter((entry) => entry.endsWith(".md")).length;
  } catch {
    return 0;
  }
}

export async function dryRunAgentSetup(cwd: string): Promise<string> {
  await ensureGitRepo(cwd);

  const repoRoot = (await getRepoRoot(cwd)) ?? cwd;
  const rulesSummary = await loadRules(repoRoot);
  const existing = await countAgentFiles(repoRoot);

  return [
    "sinscribe agent-setup (dry run: no LLM call, no credentials read)",
    "",
    "Execution plan:",
    `  Repository:  ${repoRoot}`,
    `  Output:      ${path.join(repoRoot, AGENT_DIR)}`,
    `  Existing:    ${existing} definition${existing === 1 ? "" : "s"}`,
    `  Rules:       ${describeRulesForDryRun(rulesSummary)}`,
    "  Pass 1:      read-only repository analysis -> stack, agent roster, open questions",
    "  Pass 2:      writes one definition per confirmed agent (interactive runs ask the",
    "               questions first; -p/--print skips them)",
  ].join("\n");
}

/** Pass 1: analyze the repository and propose a roster plus what to ask. */
export async function planAgentSetup(
  flags: GlobalFlags,
  cwd: string,
  callbacks: RunCallbacks = {},
): Promise<{ plan: AgentPlan; repoRoot: string }> {
  await ensureGitRepo(cwd);

  const repoRoot = (await getRepoRoot(cwd)) ?? cwd;
  const rulesSummary = await loadRules(repoRoot);
  const { text } = await runAgent(
    createAgentPlanSystemPrompt(rulesSummary.combined),
    `Analyze the repository at ${repoRoot} and propose the agent roster for it.`,
    repoRoot,
    {
      modelId: flags.modelId,
      provider: flags.provider,
      apiKey: flags.apiKey,
      ...callbacks,
    },
  );

  return { plan: parseAgentPlan(text), repoRoot };
}

export type WriteAgentSetupInput = {
  /** The agents the author kept — every other proposal is discarded. */
  roster: PlannedAgent[];
  /** Ids whose file exists and should be updated in place (never re-created). */
  refresh: string[];
  answers: Answer[];
  stack: string[];
};

/**
 * Pass 2: write the definitions. The agent writes them itself through its own
 * filesystem tools (rooted at the repository), so a large roster never has to
 * round-trip through one JSON blob and each file appears in the run log as it
 * lands.
 *
 * The prompt receives an explicit whitelist of paths, split by whether the
 * file exists: deepagents' write_file refuses to overwrite, so an existing
 * definition must be read and edited instead. A whitelist the model cannot
 * widen is also a far better guarantee than asking it to avoid a blacklist.
 */
export async function writeAgentSetup(
  input: WriteAgentSetupInput,
  flags: GlobalFlags,
  cwd: string,
  callbacks: RunCallbacks = {},
): Promise<string> {
  await ensureGitRepo(cwd);

  const repoRoot = (await getRepoRoot(cwd)) ?? cwd;
  const rulesSummary = await loadRules(repoRoot);
  const refresh = new Set(input.refresh);
  const create = input.roster.filter((agent) => !refresh.has(agent.id));
  const update = input.roster.filter((agent) => refresh.has(agent.id));

  if (create.length === 0 && update.length === 0) {
    return "Nothing to write — every proposed agent was skipped.";
  }

  const { text } = await runAgent(
    createAgentWriteSystemPrompt(
      { create, update, stack: input.stack, answers: input.answers },
      rulesSummary.combined,
    ),
    `Write the agent definitions for the repository at ${repoRoot}.`,
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

/**
 * The non-interactive path (`sinscribe agent-setup -p`, or off a TTY): analyze,
 * then write the whole proposed roster. There is nobody to answer the
 * questions or trim the roster, so both steps are skipped and the output says
 * so — the interactive flow is what this command is really for.
 */
export async function runAgentSetupPrint(
  flags: GlobalFlags,
  cwd: string,
  callbacks: RunCallbacks = {},
): Promise<string> {
  const { plan, repoRoot } = await planAgentSetup(flags, cwd, callbacks);
  const refresh = await findExistingAgentFiles(
    repoRoot,
    plan.roster.map((agent) => agent.id),
  );
  const written = await writeAgentSetup(
    { roster: plan.roster, refresh, answers: [], stack: plan.stack },
    flags,
    cwd,
    callbacks,
  );
  const skipped =
    plan.questions.length > 0
      ? [
          "",
          `Skipped ${plan.questions.length} clarifying question(s) — run sinscribe interactively to answer them:`,
          ...plan.questions.map((entry) => `  - ${entry.question}`),
        ]
      : [];

  return [written, ...skipped].join("\n");
}
