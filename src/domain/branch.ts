import type { CommandSpec, GlobalFlags } from "../commands.js";
import { getCurrentBranch, getRepoRoot } from "../git/repo.js";
import {
  buildBranchName,
  extractTicketId,
  inferBranchType,
  isBranchType,
  sanitizeBranchRef,
  slugify,
  type BranchType,
} from "../git/ticket.js";
import type { RunCallbacks } from "../llm/events.js";
import { InvalidModelJsonError } from "../llm/errors.js";
import { extractJsonObject, runSingleShot } from "../llm/single-shot.js";
import { loadSession, type SessionContext } from "../session/store.js";
import { CliError } from "./errors.js";
import { createBranchSystemPrompt, JSON_ONLY_INSTRUCTION } from "./prompts.js";

type BranchSpec = Extract<CommandSpec, { name: "branch" }>;

type BranchInput = {
  ticket: string | null;
  description: string;
  type: BranchType;
};

export type BranchSuggestions = {
  type: BranchType;
  /** Effective ticket: from the input, falling back to the session context. */
  ticket: string | null;
  /** 1-3 final branch names (type/TICKET-slug), deduplicated. */
  names: string[];
  source: "llm" | "deterministic";
};

function parseBranchInput(spec: BranchSpec): BranchInput {
  const ticket = extractTicketId(spec.input);
  const description = ticket
    ? spec.input
        .replace(
          new RegExp(ticket.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "iu"),
          " ",
        )
        .replace(/\s+/gu, " ")
        .trim()
    : spec.input.trim();

  return {
    ticket,
    description,
    type: spec.type ?? inferBranchType(description || spec.input),
  };
}

/** Fills missing ticket/description from the saved session context. */
function resolveBranchInput(
  spec: BranchSpec,
  sessionContext: SessionContext | null,
): BranchInput {
  const parsed = parseBranchInput(spec);
  const ticket = parsed.ticket ?? sessionContext?.ticket ?? null;
  const description =
    parsed.description || (sessionContext?.feature.trim() ?? "");

  return {
    ticket,
    description,
    type: spec.type ?? inferBranchType(description || spec.input),
  };
}

/** Deterministic suggestion — used by --dry-run and pure-ticket input. */
function deterministicSuggestions(input: BranchInput): string[] {
  const description = input.description || "work";

  return [buildBranchName(input.type, input.ticket, description)];
}

function deterministicResult(input: BranchInput): BranchSuggestions {
  return {
    type: input.type,
    ticket: input.ticket,
    names: deterministicSuggestions(input),
    source: "deterministic",
  };
}

/**
 * Deterministic preview. Reads the saved session context (a local file —
 * still no credentials and no network) so the preview resolves the same
 * ticket/description the real run would.
 */
export async function dryRunBranch(
  spec: BranchSpec,
  cwd: string,
): Promise<string> {
  const sessionContext = await loadCurrentSessionContext(cwd);
  const parsed = parseBranchInput(spec);
  const input = resolveBranchInput(spec, sessionContext);
  const fromSession = " (from session context)";
  const ticketNote =
    input.ticket !== null && parsed.ticket === null ? fromSession : "";
  const descriptionNote =
    input.description.length > 0 && parsed.description.length === 0
      ? fromSession
      : "";

  return [
    "sinscribe branch (dry run: no LLM call, no credentials read)",
    "",
    `Ticket:      ${input.ticket ? `${input.ticket}${ticketNote}` : "(none detected)"}`,
    `Description: ${input.description ? `${input.description}${descriptionNote}` : "(none)"}`,
    `Type:        ${input.type}${spec.type ? "" : " (inferred)"}`,
    "",
    "Deterministic suggestion:",
    ...deterministicSuggestions(input).map((name) => `  ${name}`),
  ].join("\n");
}

function buildBranchUserPrompt(
  input: BranchInput,
  spec: BranchSpec,
  context: SessionContext | null,
  preferences: string | null,
): string {
  return [
    input.ticket ? `Ticket: ${input.ticket}` : null,
    `Task: ${input.description}`,
    spec.type ? `Required type: ${spec.type}` : null,
    preferences
      ? `\nFormatting preferences (provided by the author):\n${preferences}`
      : null,
    context
      ? [
          "",
          "Business context (provided by the author):",
          `Feature: ${context.feature}`,
          context.requirements ? `Requirements: ${context.requirements}` : null,
        ]
          .filter((line) => line !== null)
          .join("\n")
      : null,
  ]
    .filter((line) => line !== null)
    .join("\n");
}

/** Parses the model's JSON reply into suggestions; null when no usable slug. */
function parseModelReply(
  text: string,
  spec: BranchSpec,
  input: BranchInput,
): BranchSuggestions | null {
  const parsed = extractJsonObject(text);
  const type =
    spec.type ??
    (typeof parsed.type === "string" && isBranchType(parsed.type)
      ? parsed.type
      : input.type);
  const slugs = Array.isArray(parsed.slugs)
    ? parsed.slugs
        .filter((slug): slug is string => typeof slug === "string")
        .map((slug) => slugify(slug))
        .filter((slug) => slug.length > 0)
    : [];
  const names = [
    ...new Set(slugs.map((slug) => buildBranchName(type, input.ticket, slug))),
  ];

  if (names.length === 0) {
    return null;
  }

  return {
    type,
    ticket: input.ticket,
    names: names.slice(0, 3),
    source: "llm",
  };
}

/**
 * Parses the preferences-path reply, where the model returns whole branch
 * names (to honor a requested format) rather than bare slugs. Each name is
 * sanitized to a valid git ref; null when none survive.
 */
function parseModelNamesReply(
  text: string,
  input: BranchInput,
): BranchSuggestions | null {
  const parsed = extractJsonObject(text);
  const names = Array.isArray(parsed.names)
    ? [
        ...new Set(
          parsed.names
            .filter((name): name is string => typeof name === "string")
            .map((name) => sanitizeBranchRef(name))
            .filter((name): name is string => name !== null),
        ),
      ]
    : [];

  if (names.length === 0) {
    return null;
  }

  return {
    type: input.type,
    ticket: input.ticket,
    names: names.slice(0, 3),
    source: "llm",
  };
}

/**
 * One single-shot model call (no tools, no checkpointer) returning structured
 * suggestions. The saved session context, when provided, fills a missing
 * ticket/description and is quoted to the model as business context.
 *
 * When `preferences` are supplied (the menu's format prompt), the model is
 * asked for whole names in that format instead of slugs; the deterministic
 * fallback still produces the default `type/TICKET-slug` name.
 */
export async function generateBranchSuggestions(
  spec: BranchSpec,
  flags: GlobalFlags,
  options: {
    sessionContext?: SessionContext | null;
    /** Free-text format/style guidance; switches the model to whole-name output. */
    preferences?: string | null;
    callbacks?: RunCallbacks;
  } = {},
): Promise<BranchSuggestions> {
  const sessionContext = options.sessionContext ?? null;
  const callbacks = options.callbacks ?? {};
  const preferences = options.preferences?.trim() || null;
  const input = resolveBranchInput(spec, sessionContext);

  // Nothing for a model to improve on without any description.
  if (input.description.length === 0) {
    if (input.ticket === null) {
      throw new CliError("branch requires a ticket ID and/or a description.");
    }

    return deterministicResult(input);
  }

  const systemPrompt = createBranchSystemPrompt(preferences !== null);
  const userPrompt = buildBranchUserPrompt(
    input,
    spec,
    sessionContext,
    preferences,
  );
  const parseReply = (text: string): BranchSuggestions | null =>
    preferences !== null
      ? parseModelNamesReply(text, input)
      : parseModelReply(text, spec, input);
  const runOptions = {
    modelId: flags.modelId,
    provider: flags.provider,
    apiKey: flags.apiKey,
    debug: callbacks.debug,
    onEvent: callbacks.onEvent,
  };
  let suggestions: BranchSuggestions | null;

  try {
    const { text } = await runSingleShot(systemPrompt, userPrompt, runOptions);

    suggestions = parseReply(text);
  } catch (error) {
    if (!(error instanceof InvalidModelJsonError)) {
      throw error;
    }

    // One re-ask on unparseable output (same pattern as pr.ts — still a
    // second single-shot call: zero tools, zero checkpointer).
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
        runOptions,
      );

      suggestions = parseReply(text);
    } catch (retryError) {
      if (!(retryError instanceof InvalidModelJsonError)) {
        throw retryError;
      }

      suggestions = null;
    }
  }

  return suggestions ?? deterministicResult(input);
}

/**
 * String-output wrapper for executeCommand (-p/print and RunApp): loads the
 * current branch's session context best-effort and joins the names one per
 * line, preserving the historical output shape.
 */
export async function runBranch(
  spec: BranchSpec,
  flags: GlobalFlags,
  cwd: string,
  callbacks: RunCallbacks = {},
): Promise<string> {
  const sessionContext = await loadCurrentSessionContext(cwd);
  const suggestions = await generateBranchSuggestions(spec, flags, {
    sessionContext,
    callbacks,
  });

  return suggestions.names.join("\n");
}

async function loadCurrentSessionContext(
  cwd: string,
): Promise<SessionContext | null> {
  const repoRoot = await getRepoRoot(cwd);

  if (repoRoot === null) {
    return null;
  }

  const branch = await getCurrentBranch(cwd);

  if (branch === null) {
    return null;
  }

  return (await loadSession(repoRoot, branch))?.context ?? null;
}
