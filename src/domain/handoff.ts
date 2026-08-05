import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { GlobalFlags } from "../commands.js";
import type { RunCallbacks } from "../llm/events.js";
import { runSingleShot, stripMarkdownFence } from "../llm/single-shot.js";
import type { SessionContext } from "../session/store.js";
import { CliError } from "./errors.js";
import {
  buildHandoffMarkdown,
  getHandoffPath,
  type ParsedHandoff,
} from "./handoff-export.js";
import { createHandoffSystemPrompt } from "./prompts.js";

/**
 * Everything the handoff needs, handed over by the prompt run that already
 * gathered it — this never re-shells git.
 */
export type HandoffInput = {
  repoRoot: string;
  branch: string;
  ticket: string | null;
  baseRef: string | null;
  sessionContext: SessionContext | null;
  /** Commit log for the branch, as shown to the prompt generator. */
  log: string;
  /** name-status + stat tail vs the base; null when nothing changed. */
  changedFiles: string | null;
  /** The agent prompt the developer just approved. */
  agentPrompt: string;
  /** The handoff already on disk, when one was read. */
  previousHandoff: ParsedHandoff | null;
  rules: string | null;
};

function buildHandoffUserPrompt(
  input: HandoffInput,
  feedback: string | null,
  draft: string | null,
): string {
  const previousBody = draft ?? input.previousHandoff?.body ?? null;
  const previousLabel =
    draft !== null
      ? "Your previous draft of this handoff (revise it; do not start over):"
      : input.previousHandoff !== null &&
          input.previousHandoff.branch !== null &&
          input.previousHandoff.branch !== input.branch
        ? `Previous handoff (written on branch ${input.previousHandoff.branch}, not this one — treat it as background and correct anything that no longer applies):`
        : "Previous handoff for this branch (update it; do not start over):";

  return [
    `Repository branch: ${input.branch}`,
    `Target/base branch: ${input.baseRef ?? "(unknown)"}`,
    input.ticket ? `Ticket: ${input.ticket}` : null,
    input.sessionContext
      ? [
          "",
          "Business context (saved by the author for this branch):",
          `Feature: ${input.sessionContext.feature}`,
          input.sessionContext.ticket
            ? `Ticket: ${input.sessionContext.ticket}`
            : null,
          input.sessionContext.requirements
            ? `Requirements: ${input.sessionContext.requirements}`
            : null,
        ]
          .filter((line) => line !== null)
          .join("\n")
      : null,
    "",
    "Commits on this branch:",
    input.log || "(none yet)",
    input.changedFiles
      ? ["", "Files changed vs the base branch:", input.changedFiles].join("\n")
      : null,
    previousBody ? ["", previousLabel, previousBody].join("\n") : null,
    feedback
      ? [
          "",
          "Author feedback on the previous draft (apply all of it):",
          feedback,
        ].join("\n")
      : null,
    "",
    "The agent prompt approved in this session (the work being handed to a coding agent — a plan, not a result):",
    input.agentPrompt,
    "",
    "Write the handoff now.",
  ]
    .filter((line) => line !== null)
    .join("\n");
}

export type HandoffRun = {
  /** One generation. Pass feedback to revise the last draft; null generates fresh. */
  generate(feedback: string | null, callbacks?: RunCallbacks): Promise<string>;
  /** Writes HANDOFF.md at the repo root. Returns the path written. */
  save(): Promise<string>;
};

/**
 * generate → review → refine → save cycle for the session handoff, mirroring
 * createPromptRun. Each generate() is one single-shot model call (no tools,
 * no checkpointer) emitting the markdown sections directly.
 */
export function createHandoffRun(
  input: HandoffInput,
  flags: GlobalFlags,
): HandoffRun {
  let lastGenerated: string | null = null;

  const generate = async (
    feedback: string | null,
    callbacks: RunCallbacks = {},
  ): Promise<string> => {
    const draft = lastGenerated;
    const systemPrompt = createHandoffSystemPrompt(
      {
        update: draft !== null || input.previousHandoff !== null,
        feedback: feedback !== null,
      },
      input.rules,
    );
    const { text } = await runSingleShot(
      systemPrompt,
      buildHandoffUserPrompt(input, feedback, draft),
      {
        modelId: flags.modelId,
        provider: flags.provider,
        apiKey: flags.apiKey,
        debug: callbacks.debug,
        onEvent: callbacks.onEvent,
      },
    );
    const content = stripMarkdownFence(text);

    if (content.length === 0) {
      throw new CliError("The model produced no output.");
    }

    lastGenerated = content;

    return content;
  };

  const save = async (): Promise<string> => {
    if (lastGenerated === null) {
      throw new Error("save() called before a successful generate().");
    }

    const handoffPath = getHandoffPath(input.repoRoot);

    await writeFile(
      handoffPath,
      buildHandoffMarkdown({
        projectName: path.basename(input.repoRoot),
        branch: input.branch,
        ticket: input.ticket,
        body: lastGenerated,
      }),
      "utf8",
    );

    return handoffPath;
  };

  return { generate, save };
}
