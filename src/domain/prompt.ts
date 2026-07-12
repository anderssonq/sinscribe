import { writeFile } from "node:fs/promises";
import type { CommandSpec, GlobalFlags } from "../commands.js";
import { getLocalDiff, getRangeLog } from "../git/diff.js";
import {
  ensureGitRepo,
  getCurrentBranch,
  getRecentCommits,
  getRepoRoot,
  resolveBaseRef,
} from "../git/repo.js";
import { extractTicketId } from "../git/ticket.js";
import type { RunCallbacks } from "../llm/events.js";
import { runSingleShot } from "../llm/single-shot.js";
import {
  getSessionPath,
  loadSession,
  type BranchSession,
} from "../session/store.js";
import { CliError } from "./errors.js";
import { PROMPT_EXPORT_FILENAME } from "./prompt-export.js";
import {
  createPromptSystemPrompt,
  getPromptSectionSkeleton,
} from "./prompts.js";

type PromptSpec = Extract<CommandSpec, { name: "prompt" }>;

export type PromptKind = NonNullable<PromptSpec["type"]>;

const STRONG_BUGFIX_KEYWORDS = /\b(fix|bug|broken|crash|regression|defect)\b/iu;
const WEAK_BUGFIX_KEYWORDS = /\b(error|fail(s|ing|ure)?|incorrect|wrong)\b/iu;

/** Cheap keyword-based kind inference for deterministic dry runs. */
export function inferPromptKind(description: string): PromptKind {
  // Unambiguous bugfix words count anywhere; words requirement bodies use
  // incidentally ("error", "failures") only count on the leading intent line,
  // so acceptance criteria never flip a feature to bugfix.
  const intent =
    description.split("\n").find((line) => line.trim().length > 0) ?? "";

  return STRONG_BUGFIX_KEYWORDS.test(description) ||
    WEAK_BUGFIX_KEYWORDS.test(intent)
    ? "bugfix"
    : "feature";
}

type PromptContext = {
  repoRoot: string | null;
  branch: string;
  /**
   * Null when no base resolves — unlike `pr`, that is not fatal here: the
   * prompt is usually written before any work (or even a remote) exists.
   */
  baseRef: string | null;
  ticket: string | null;
  session: BranchSession | null;
  /** Range log vs the base when one resolves, else the recent commit log. */
  log: string;
  /** name-status + stat tail vs the base; null when no base or no changes. */
  changedFiles: string | null;
};

async function gatherPromptContext(cwd: string): Promise<PromptContext> {
  await ensureGitRepo(cwd);

  const repoRoot = await getRepoRoot(cwd);
  const rawBranch = await getCurrentBranch(cwd);
  const branch = rawBranch ?? "(detached HEAD)";
  const session =
    repoRoot !== null && rawBranch !== null
      ? await loadSession(repoRoot, rawBranch)
      : null;
  const baseRef = await resolveBaseRef(cwd, session?.context?.baseRef ?? null);
  const ticket = extractTicketId(branch) ?? session?.context?.ticket ?? null;

  if (baseRef === null) {
    return {
      repoRoot,
      branch,
      baseRef,
      ticket,
      session,
      log: await getRecentCommits(cwd, 10),
      changedFiles: null,
    };
  }

  const [log, diff] = await Promise.all([
    getRangeLog(cwd, baseRef),
    // Only the file list and stat tail go to the model: the prompt describes
    // upcoming work, so the patch itself (often empty anyway) adds nothing.
    getLocalDiff(cwd, baseRef, { staged: false }),
  ]);
  const statTail = diff.stat.split("\n").at(-1)?.trim() ?? "";

  return {
    repoRoot,
    branch,
    baseRef,
    ticket,
    session,
    log,
    changedFiles: diff.isEmpty ? null : `${diff.nameStatus}\n${statTail}`,
  };
}

const MISSING_DESCRIPTION_MESSAGE =
  "prompt requires a description. Pass one as arguments, or save a session context for this branch first.";

/** CLI description first, then the saved session context, else null. */
export function resolvePromptDescription(
  spec: PromptSpec,
  session: BranchSession | null,
): string | null {
  if (spec.description !== null) {
    return spec.description;
  }

  const context = session?.context ?? null;

  if (context === null) {
    return null;
  }

  return context.requirements
    ? `${context.feature}\n\nRequirements:\n${context.requirements}`
    : context.feature;
}

function buildPromptUserPrompt(
  context: PromptContext,
  kind: PromptKind,
  description: string,
  previousPrompt: string | null,
  feedback: string | null,
): string {
  const sessionContext = context.session?.context ?? null;

  return [
    `Repository branch: ${context.branch}`,
    `Target/base branch: ${context.baseRef ?? "(unknown)"}`,
    context.ticket ? `Ticket: ${context.ticket}` : null,
    sessionContext
      ? [
          "",
          "Business context (saved by the author for this branch):",
          `Feature: ${sessionContext.feature}`,
          sessionContext.ticket ? `Ticket: ${sessionContext.ticket}` : null,
          sessionContext.requirements
            ? `Requirements: ${sessionContext.requirements}`
            : null,
        ]
          .filter((line) => line !== null)
          .join("\n")
      : null,
    "",
    "Commits already on this branch (background, not the task):",
    context.log || "(none yet)",
    context.changedFiles
      ? [
          "",
          "Files already changed vs the base branch (background, not the task):",
          context.changedFiles,
        ].join("\n")
      : null,
    previousPrompt
      ? [
          "",
          "Previously generated prompt (revise it; do not start over):",
          previousPrompt,
        ].join("\n")
      : null,
    feedback
      ? [
          "",
          "Developer feedback on the previous prompt (apply all of it):",
          feedback,
        ].join("\n")
      : null,
    "",
    `Task type: ${kind}`,
    "The developer's description of the work:",
    description,
    "",
    `Write the ${kind} prompt now.`,
  ]
    .filter((line) => line !== null)
    .join("\n");
}

/**
 * Defensively unwraps a whole-document ```/```markdown fence — the system
 * prompt forbids one, but models occasionally add it anyway.
 */
export function stripMarkdownFence(text: string): string {
  const trimmed = text.trim();
  const match = /^```[a-z]*\n([\s\S]*?)\n?```$/u.exec(trimmed);

  return match ? match[1] : trimmed;
}

export type PromptRunMeta = {
  kind: PromptKind;
  branch: string;
  baseRef: string | null;
  ticket: string | null;
  repoRoot: string | null;
  description: string;
};

export type PromptRun = {
  meta: PromptRunMeta;
  /**
   * One single-shot generation. Pass feedback to refine the last candidate;
   * null generates fresh.
   */
  generate(feedback: string | null, callbacks?: RunCallbacks): Promise<string>;
  /** Persists the approved candidate to --out when set. No session save. */
  approve(): Promise<{ outPath: string | null }>;
};

/**
 * Gathers git/session context once and exposes a generate → review →
 * refine → approve cycle for the interactive UIs. Each generate() is a
 * single-shot model call (no tools, no checkpointer) that emits the finished
 * markdown prompt directly — no template, no JSON envelope.
 */
export async function createPromptRun(
  spec: PromptSpec,
  flags: GlobalFlags,
  cwd: string,
): Promise<PromptRun> {
  const context = await gatherPromptContext(cwd);
  const description = resolvePromptDescription(spec, context.session);

  if (description === null) {
    throw new CliError(MISSING_DESCRIPTION_MESSAGE);
  }

  const kind = spec.type ?? inferPromptKind(description);
  let lastGenerated: string | null = null;

  const generate = async (
    feedback: string | null,
    callbacks: RunCallbacks = {},
  ): Promise<string> => {
    const previousPrompt = lastGenerated;
    const systemPrompt = createPromptSystemPrompt(kind, {
      update: previousPrompt !== null,
      feedback: feedback !== null,
    });
    const userPrompt = buildPromptUserPrompt(
      context,
      kind,
      description,
      previousPrompt,
      feedback,
    );
    const { text } = await runSingleShot(systemPrompt, userPrompt, {
      modelId: flags.modelId,
      provider: flags.provider,
      apiKey: flags.apiKey,
      debug: callbacks.debug,
      onEvent: callbacks.onEvent,
    });
    const content = stripMarkdownFence(text);

    if (content.length === 0) {
      throw new CliError("The model produced no output.");
    }

    lastGenerated = content;

    return content;
  };

  const approve = async (): Promise<{ outPath: string | null }> => {
    if (lastGenerated === null) {
      throw new Error("approve() called before a successful generate().");
    }

    if (spec.out) {
      await writeFile(spec.out, `${lastGenerated}\n`, "utf8");
    }

    return { outPath: spec.out ?? null };
  };

  return {
    meta: {
      kind,
      branch: context.branch,
      baseRef: context.baseRef,
      ticket: context.ticket,
      repoRoot: context.repoRoot,
      description,
    },
    generate,
    approve,
  };
}

export async function dryRunPrompt(
  spec: PromptSpec,
  cwd: string,
): Promise<string> {
  const context = await gatherPromptContext(cwd);
  const description = resolvePromptDescription(spec, context.session);
  const kind =
    spec.type ??
    (description !== null ? inferPromptKind(description) : "feature");
  const kindSource = spec.type
    ? "--type flag"
    : description !== null
      ? "inferred from the description"
      : "default";
  const descriptionLine =
    spec.description !== null
      ? previewText(spec.description)
      : description !== null
        ? "(from saved session context)"
        : "(asked interactively; required with -p/--print)";
  const sessionLine =
    context.repoRoot !== null && context.session !== null
      ? `${getSessionPath(context.repoRoot, context.session.branch)} (${context.session.context !== null ? "context saved" : "no context"})`
      : "(none)";

  return [
    "sinscribe prompt (dry run: no LLM call, no credentials read)",
    "",
    `Type:        ${kind} (${kindSource})`,
    `Branch:      ${context.branch}`,
    `Base:        ${context.baseRef ?? "(none detected — the prompt still works without one)"}`,
    `Ticket:      ${context.ticket ?? "(none detected)"}`,
    `Session:     ${sessionLine}`,
    `Description: ${descriptionLine}`,
    `Export:      ${spec.out ?? `${PROMPT_EXPORT_FILENAME} and/or clipboard, offered after approval`}`,
    "",
    "The model would emit a markdown prompt with exactly these sections:",
    "---",
    getPromptSectionSkeleton(kind),
    "---",
  ].join("\n");
}

function previewText(text: string): string {
  const singleLine = text.replace(/\s+/gu, " ").trim();

  return singleLine.length > 80 ? `${singleLine.slice(0, 77)}...` : singleLine;
}

export async function runPrompt(
  spec: PromptSpec,
  flags: GlobalFlags,
  cwd: string,
  callbacks: RunCallbacks = {},
): Promise<string> {
  const run = await createPromptRun(spec, flags, cwd);
  const content = await run.generate(null, callbacks);
  const { outPath } = await run.approve();

  return outPath ? `Wrote agent prompt to ${outPath}` : content;
}
