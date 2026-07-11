import { writeFile } from "node:fs/promises";
import type { CommandSpec, GlobalFlags } from "../commands.js";
import { getLocalDiff, getRangeLog } from "../git/diff.js";
import {
  ensureGitRepo,
  getCurrentBranch,
  getRepoRoot,
  resolveBaseRef,
} from "../git/repo.js";
import { extractTicketId } from "../git/ticket.js";
import type { RunCallbacks } from "../llm/events.js";
import { extractJsonObject, runSingleShot } from "../llm/single-shot.js";
import {
  getLlmPlaceholderNames,
  renderTemplate,
  type PlaceholderValues,
} from "../templates/render.js";
import { resolveTemplate, type TemplateEntry } from "../templates/registry.js";
import {
  getSessionPath,
  loadSession,
  saveSession,
  type BranchSession,
} from "../session/store.js";
import { getProviderLabel, resolveConfiguredProvider } from "../constants.js";
import { InvalidModelJsonError, toFriendlyError } from "../llm/errors.js";
import { CliError } from "./errors.js";
import { createPrSystemPrompt, JSON_ONLY_INSTRUCTION } from "./prompts.js";

type PrSpec = Extract<CommandSpec, { name: "pr" }>;

type BaseSource = "flag" | "session" | "auto";

type PrContext = {
  template: TemplateEntry;
  repoRoot: string | null;
  branch: string;
  baseRef: string;
  baseSource: BaseSource;
  staged: boolean;
  ticket: string | null;
  session: BranchSession | null;
  diff: Awaited<ReturnType<typeof getLocalDiff>>;
  log: string;
  gitValues: PlaceholderValues;
};

function baseSourceLabel(source: BaseSource): string {
  switch (source) {
    case "flag":
      return "--base flag";
    case "session":
      return "saved session context";
    case "auto":
      return "auto-detected";
  }
}

async function gatherPrContext(spec: PrSpec, cwd: string): Promise<PrContext> {
  await ensureGitRepo(cwd);

  const repoRoot = await getRepoRoot(cwd);
  const template = await resolveTemplate(spec.template, "pr", repoRoot);
  const rawBranch = await getCurrentBranch(cwd);
  const branch = rawBranch ?? "(detached HEAD)";
  const session =
    repoRoot !== null && rawBranch !== null
      ? await loadSession(repoRoot, rawBranch)
      : null;
  // Target branch precedence: --base flag > session context > auto-detect.
  const sessionBase = session?.context?.baseRef ?? null;
  const requestedBase = spec.base ?? sessionBase;
  const baseSource: BaseSource = spec.base
    ? "flag"
    : sessionBase
      ? "session"
      : "auto";
  const baseRef = await resolveBaseRef(cwd, requestedBase);

  if (baseRef === null) {
    throw new CliError(
      requestedBase
        ? `Target branch not found: ${requestedBase}${baseSource === "session" ? " (from saved session context — recreate it or pass --base <ref>)" : ""}`
        : "Could not detect a target branch (tried origin/HEAD, origin/main, origin/master, origin/develop, main, master, develop). Pass one with --base <ref>.",
    );
  }

  const ticket =
    spec.ticket ?? extractTicketId(branch) ?? session?.context?.ticket ?? null;
  const [diff, log] = await Promise.all([
    getLocalDiff(cwd, baseRef, { staged: spec.staged }),
    getRangeLog(cwd, baseRef),
  ]);

  if (diff.isEmpty) {
    throw new CliError(
      spec.staged
        ? `No staged changes vs ${baseRef}. Stage changes with \`git add\`, or drop --staged to include unstaged edits.`
        : `No local changes vs ${baseRef}. Nothing to describe.`,
    );
  }

  const gitValues: PlaceholderValues = {};

  for (const [name, placeholderSpec] of Object.entries(template.placeholders)) {
    if (placeholderSpec.from === "git") {
      gitValues[name] = branch;
    } else if (placeholderSpec.from === "branch") {
      if (ticket === null && placeholderSpec.required) {
        throw new CliError(
          `Template ${template.name} requires a ticket ID, but none was found in branch "${branch}". Pass one with --ticket <id>.`,
        );
      }

      gitValues[name] = ticket ?? undefined;
    }
  }

  return {
    template,
    repoRoot,
    branch,
    baseRef,
    baseSource,
    staged: spec.staged,
    ticket,
    session,
    diff,
    log,
    gitValues,
  };
}

export async function dryRunPr(spec: PrSpec, cwd: string): Promise<string> {
  const context = await gatherPrContext(spec, cwd);
  const scaffold = renderTemplate(context.template, context.gitValues, {
    leaveUnfilled: true,
  });

  const sessionLine =
    context.repoRoot !== null && context.session !== null
      ? `${getSessionPath(context.repoRoot, context.session.branch)} (${context.session.context !== null ? "context saved" : "no context"})`
      : "(none)";

  return [
    "sinscribe pr (dry run: no LLM call, no credentials read)",
    "",
    `Template:  ${context.template.name} (${context.template.tier}) — ${context.template.sourcePath}`,
    `Branch:    ${context.branch}`,
    `Base:      ${context.baseRef} (${baseSourceLabel(context.baseSource)})`,
    `Scope:     ${context.staged ? "staged changes only" : "all local changes (staged + unstaged)"} vs merge-base`,
    `Ticket:    ${context.ticket ?? "(none detected)"}`,
    `Session:   ${sessionLine}`,
    `Mode:      ${context.session?.pr ? "update existing description" : "create new description"}`,
    `Diff:      ${context.diff.stat.split("\n").at(-1)?.trim() ?? "(empty)"}${context.diff.truncated ? " [truncated for prompt]" : ""}`,
    "",
    "Scaffold ({{...}} slots would be filled by the model):",
    "---",
    scaffold.trimEnd(),
    "---",
  ].join("\n");
}

function buildPrUserPrompt(
  context: PrContext,
  previousDescription: string | null,
  feedback: string | null,
): string {
  const sessionContext = context.session?.context ?? null;

  return [
    `Branch: ${context.branch}`,
    `Base: ${context.baseRef}`,
    context.ticket ? `Ticket: ${context.ticket}` : null,
    sessionContext
      ? [
          "",
          "Business context (provided by the author):",
          `Feature: ${sessionContext.feature}`,
          sessionContext.ticket ? `Ticket: ${sessionContext.ticket}` : null,
          sessionContext.requirements
            ? `Requirements: ${sessionContext.requirements}`
            : null,
        ]
          .filter((line) => line !== null)
          .join("\n")
      : null,
    previousDescription
      ? [
          "",
          "Previously generated PR description (revise it for the current diff; do not start over):",
          previousDescription,
        ].join("\n")
      : null,
    feedback
      ? [
          "",
          "Author feedback on the previous description (apply all of it):",
          feedback,
        ].join("\n")
      : null,
    "",
    "Commits:",
    context.log || "(no commits listed)",
    "",
    "Changed files:",
    context.diff.nameStatus,
    "",
    "Diff:",
    context.diff.patch,
  ]
    .filter((line) => line !== null)
    .join("\n");
}

/** Parses the model's JSON reply and renders the template with it. */
function parseAndRender(context: PrContext, text: string): string {
  const llmSlots = getLlmPlaceholderNames(context.template);
  const values = extractJsonObject(text);
  const llmValues: PlaceholderValues = {};

  for (const name of llmSlots) {
    const value = values[name];

    if (typeof value === "string") {
      llmValues[name] = value;
    } else if (
      Array.isArray(value) &&
      value.every((item) => typeof item === "string")
    ) {
      llmValues[name] = value;
    }
  }

  return renderTemplate(context.template, {
    ...context.gitValues,
    ...llmValues,
  });
}

export type PrRunMeta = {
  branch: string;
  baseRef: string;
  ticket: string | null;
  templateName: string;
  repoRoot: string | null;
  /** True when a session PR exists, so the first generation revises it. */
  updating: boolean;
};

export type PrApproveResult = {
  outPath: string | null;
  sessionSaved: boolean;
};

export type PrRun = {
  meta: PrRunMeta;
  /**
   * One single-shot generation. Pass feedback to refine the last candidate;
   * null generates fresh (revising a prior session PR when one exists).
   */
  generate(feedback: string | null, callbacks?: RunCallbacks): Promise<string>;
  /** Persists the approved candidate: session save plus optional --out file. */
  approve(): Promise<PrApproveResult>;
};

/**
 * Gathers git/template context once and exposes a generate → review →
 * refine → approve cycle for the interactive UIs. Each generate() is a
 * single-shot model call (no tools, no checkpointer); the session is only
 * saved on approve() so rejected candidates never poison future revise runs.
 */
export async function createPrRun(
  spec: PrSpec,
  flags: GlobalFlags,
  cwd: string,
): Promise<PrRun> {
  const context = await gatherPrContext(spec, cwd);
  // The rendered candidate, untrimmed for --out parity with the old runPr.
  let lastRendered: string | null = null;

  const generate = async (
    feedback: string | null,
    callbacks: RunCallbacks = {},
  ): Promise<string> => {
    const previousDescription =
      lastRendered?.trimEnd() ?? context.session?.pr?.description ?? null;
    const systemPrompt = createPrSystemPrompt(context.template, {
      update: previousDescription !== null,
      feedback: feedback !== null,
    });
    const userPrompt = buildPrUserPrompt(
      context,
      previousDescription,
      feedback,
    );
    const options = {
      modelId: flags.modelId,
      provider: flags.provider,
      apiKey: flags.apiKey,
      debug: callbacks.debug,
      onEvent: callbacks.onEvent,
    };
    let rendered: string;

    try {
      const { text } = await runSingleShot(systemPrompt, userPrompt, options);

      rendered = parseAndRender(context, text);
    } catch (error) {
      if (!(error instanceof InvalidModelJsonError)) {
        throw error;
      }

      // One re-ask on unparseable output (owner-approved second single-shot
      // call — still zero tools, zero checkpointer).
      callbacks.onEvent?.({
        type: "status",
        message:
          "Model returned invalid JSON — asking it to correct the format...",
      });

      const retryPrompt = `${userPrompt}\n\nYour previous response was not valid JSON. ${JSON_ONLY_INSTRUCTION}`;

      try {
        const { text } = await runSingleShot(
          systemPrompt,
          retryPrompt,
          options,
        );

        rendered = parseAndRender(context, text);
      } catch (retryError) {
        if (!(retryError instanceof InvalidModelJsonError)) {
          throw retryError;
        }

        throw toFriendlyError(retryError, {
          providerLabel: getProviderLabel(
            resolveConfiguredProvider(flags.provider ?? null),
          ),
        });
      }
    }

    lastRendered = rendered;

    return rendered.trimEnd();
  };

  const approve = async (): Promise<PrApproveResult> => {
    if (lastRendered === null) {
      throw new Error("approve() called before a successful generate().");
    }

    let sessionSaved = false;

    if (context.repoRoot !== null && context.branch !== "(detached HEAD)") {
      const now = new Date().toISOString();

      await saveSession(context.repoRoot, {
        version: 1,
        branch: context.branch,
        context: context.session?.context ?? null,
        pr: {
          template: context.template.name,
          description: lastRendered.trimEnd(),
          baseRef: context.baseRef,
          generatedAt: now,
        },
        createdAt: context.session?.createdAt ?? now,
        updatedAt: now,
      });
      sessionSaved = true;
    }

    if (spec.out) {
      await writeFile(spec.out, lastRendered, "utf8");
    }

    return { outPath: spec.out ?? null, sessionSaved };
  };

  return {
    meta: {
      branch: context.branch,
      baseRef: context.baseRef,
      ticket: context.ticket,
      templateName: context.template.name,
      repoRoot: context.repoRoot,
      updating: context.session?.pr != null,
    },
    generate,
    approve,
  };
}

export async function runPr(
  spec: PrSpec,
  flags: GlobalFlags,
  cwd: string,
  callbacks: RunCallbacks = {},
): Promise<string> {
  const run = await createPrRun(spec, flags, cwd);
  const rendered = await run.generate(null, callbacks);
  const { outPath } = await run.approve();

  return outPath ? `Wrote PR description to ${outPath}` : rendered;
}
