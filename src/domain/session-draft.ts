import path from "node:path";
import type { GlobalFlags } from "../commands.js";
import {
  providerExploreKind,
  resolveConfiguredProvider,
  type ExploreKind,
} from "../constants.js";
import { extractTicketId } from "../git/ticket.js";
import { InvalidModelJsonError } from "../llm/errors.js";
import type { RunCallbacks } from "../llm/events.js";
import { runExplore, type ExploreMode } from "../llm/explore.js";
import { extractJsonObject, runSingleShot } from "../llm/single-shot.js";
import type { SessionContext } from "../session/store.js";
import { redactSecrets } from "../util/redact.js";
import { CliError } from "./errors.js";
import {
  describeHandoff,
  gatherPromptContext,
  type PromptContext,
} from "./prompt.js";
import {
  createSessionDraftSystemPrompt,
  JSON_ONLY_INSTRUCTION,
} from "./prompts.js";
import {
  gatherRecoveryEvidence,
  RECOVERY_DIRECTION,
  type RecoveryEvidence,
  type RecoveryInput,
} from "./recover-evidence.js";
import {
  buildRepoBrief,
  isSecretPath,
  listTrackedFiles,
  readCapped,
} from "./repo-brief.js";

/**
 * AI-assisted session context: the author gives the direction, the model
 * backs it with evidence from the repository (code and markdown documents)
 * and proposes feature / requirements / sources / open questions. The author
 * reviews, refines and approves it — nothing here writes to disk; saving the
 * approved draft is the caller's job.
 *
 * The first generation (and "look again") goes through the read-only explore
 * tier, so every provider can ground itself in the code without ever being
 * able to change it; feedback rounds are single-shot refinements.
 */

export type SessionDraftSource = { path: string; why: string };

export type SessionDraft = {
  feature: string;
  ticket: string | null;
  requirements: string | null;
  baseRef: string | null;
  sources: SessionDraftSource[];
  openQuestions: string[];
  mode: ExploreMode;
  /** Every file the model opened across the rounds of this draft. */
  filesRead: string[];
  fallbackReason: string | null;
};

export type SessionDraftMeta = {
  branch: string;
  baseRef: string | null;
  /** Ticket detected from the branch name or the saved context. */
  ticket: string | null;
  commits: number;
  changedFiles: number;
  handoff: boolean;
  /** Tracked markdown documents the model may draw on. */
  docs: number;
  exploreKind: ExploreKind;
  /** Recovery mode only: what the failed pipeline left to read first. */
  recovery: {
    candidates: number;
    /** Where the diagnosis came from, or null when none was given. */
    diagnosis: string | null;
  } | null;
};

export type SessionDraftRequest = {
  /** Null for the first round; the author's feedback afterwards. */
  feedback: string | null;
  /**
   * Read the repository (read-only) for this round. Rounds with feedback
   * explore only when the author asks to look again.
   */
  explore: boolean;
  /**
   * Required on the first round. Later, a changed goal replaces the
   * direction from that round on.
   */
  direction?: string;
};

export type SessionDraftRun = {
  meta: SessionDraftMeta;
  generate(
    request: SessionDraftRequest,
    callbacks?: RunCallbacks,
  ): Promise<SessionDraft>;
};

const MAX_DOC_PATHS = 150;
const MAX_DOC_EXCERPTS = 6;
const MAX_EXCERPT_BYTES = 3_000;
const MAX_OPEN_QUESTIONS = 10;
/** Past this length a direction is pasted material, not a goal to quote. */
const MAX_QUOTED_DIRECTION = 300;

const MISSING_DIRECTION_MESSAGE =
  "Give the session a direction first: what is it for, and what should it achieve?";

/**
 * Gathers the evidence once (git state, handoff, tracked documents) so the
 * UI can show what the model will see before the author writes the
 * direction; each generate() is one round on top of it.
 */
export async function createSessionDraftRun(
  flags: GlobalFlags,
  cwd: string,
  options: {
    previous: SessionContext | null;
    /**
     * Recovery mode: the branch was left by a pipeline that failed. The
     * draft hunts for the failure and what is left, not for a new goal.
     */
    recovery?: RecoveryInput | null;
  },
): Promise<SessionDraftRun> {
  let direction = "";
  const context = await gatherPromptContext(cwd);

  if (context.repoRoot === null) {
    throw new CliError(
      "Session context must be created inside a git repository.",
    );
  }

  const repoRoot = context.repoRoot;
  const tracked = await listTrackedFiles(repoRoot);
  const docs = tracked.filter(isMarkdownPath);
  const knownFiles = new Set(tracked);
  const recovery =
    options.recovery == null
      ? null
      : await gatherRecoveryEvidence(repoRoot, {
          ticket: context.ticket,
          baseRef: context.baseRef,
          diagnosisPath: options.recovery.diagnosisPath,
        });
  const feedbackLog: string[] = [];
  let previousDraft: SessionDraft | null = null;

  const generate = async (
    request: SessionDraftRequest,
    callbacks: RunCallbacks = {},
  ): Promise<SessionDraft> => {
    if (request.direction !== undefined) {
      const changed = request.direction.trim();

      if (changed.length === 0) {
        throw new CliError(MISSING_DIRECTION_MESSAGE);
      }

      direction = changed;
    }

    if (direction.length === 0) {
      throw new CliError(MISSING_DIRECTION_MESSAGE);
    }

    const feedback = request.feedback?.trim() || null;
    const systemPrompt = createSessionDraftSystemPrompt(
      {
        update: previousDraft !== null || options.previous !== null,
        feedback: feedback !== null,
        recovery: recovery !== null,
      },
      context.rulesSummary.combined,
    );
    const userPrompt = buildSessionDraftUserPrompt({
      context,
      direction,
      docs,
      previousContext: previousDraft === null ? options.previous : null,
      previousDraft,
      feedback,
      recovery,
    });
    const llm = {
      modelId: flags.modelId,
      provider: flags.provider,
      apiKey: flags.apiKey,
      debug: callbacks.debug,
      onEvent: callbacks.onEvent,
    };
    const refineOnly = feedback !== null && !request.explore;
    const result = refineOnly
      ? {
          ...(await runSingleShot(systemPrompt, userPrompt, llm)),
          mode: "single-shot" as const,
          filesRead: [],
          fallbackReason:
            "refined from your feedback without re-reading the repository",
        }
      : await runExplore(systemPrompt, userPrompt, {
          ...llm,
          repoRoot,
          explore: request.explore,
          singleShotReason: "reading the code was turned off",
          fallbackContext: async () =>
            [
              await buildRepoBrief(repoRoot),
              recovery === null
                ? ""
                : await buildRecoveryDigest(
                    repoRoot,
                    recovery.candidates,
                    knownFiles,
                  ),
              await buildDocsDigest(repoRoot, docs, [
                direction,
                feedback ?? "",
                context.ticket ?? "",
              ]),
            ]
              .filter((section) => section.length > 0)
              .join("\n\n"),
        });

    if (feedback !== null) {
      feedbackLog.push(feedback);
    }

    const parsed = await parseOrRepair(
      result.text,
      systemPrompt,
      userPrompt,
      llm,
      () => buildReadExcerpts(repoRoot, result.filesRead, knownFiles),
    );
    // A model that echoes the recovery instruction back would make it the
    // title of the context and of every plan built from it.
    const reply =
      recovery === null
        ? parsed
        : {
            ...parsed,
            feature: withoutRecoveryGoal(parsed.feature) || parsed.feature,
          };
    const draft = finalizeDraft(reply, {
      // The pre-filled recovery goal is Sinscribe's instruction, not the
      // author's words: only what the author added to it must stay in the
      // feature (and so in every title built from it).
      direction: recovery === null ? direction : withoutRecoveryGoal(direction),
      detectedTicket: context.ticket,
      previousTicket: options.previous?.ticket ?? null,
      evidence: [
        direction,
        ...feedbackLog,
        context.branch,
        context.log,
        context.handoff?.body ?? "",
        recovery?.diagnosis?.text ?? "",
      ].join("\n"),
      knownFiles,
      repoRoot,
    });
    const filesRead = [
      ...new Set([...(previousDraft?.filesRead ?? []), ...result.filesRead]),
    ];

    previousDraft = {
      ...draft,
      baseRef: options.previous?.baseRef ?? context.baseRef,
      mode: result.mode,
      filesRead,
      fallbackReason: result.fallbackReason,
    };

    return previousDraft;
  };

  return {
    meta: {
      branch: context.branch,
      baseRef: options.previous?.baseRef ?? context.baseRef,
      ticket: context.ticket,
      commits: countLines(context.log),
      // The last line of changedFiles is git's stat summary, not a file.
      changedFiles: context.changedFiles
        ? Math.max(0, countLines(context.changedFiles) - 1)
        : 0,
      handoff: context.handoff !== null,
      docs: docs.length,
      exploreKind: providerExploreKind(
        resolveConfiguredProvider(flags.provider),
      ),
      recovery:
        recovery === null
          ? null
          : {
              candidates: recovery.candidates.length,
              diagnosis: recovery.diagnosis?.source ?? null,
            },
    },
    generate,
  };
}

/**
 * The approved draft as the session context the rest of the CLI already
 * reads: sources and (optionally) unanswered questions ride along at the end
 * of the requirements, so pr/prompt/plan see them without a schema change.
 */
export function toSessionContext(
  draft: SessionDraft,
  options: { keepOpenQuestions: boolean },
): SessionContext {
  const sections = [
    draft.requirements === null
      ? null
      : stripAppendedSections(draft.requirements),
    draft.sources.length > 0
      ? [
          "References:",
          ...draft.sources.map((source) =>
            source.why
              ? `- ${source.path} — ${source.why}`
              : `- ${source.path}`,
          ),
        ].join("\n")
      : null,
    options.keepOpenQuestions && draft.openQuestions.length > 0
      ? [
          "Open questions:",
          ...draft.openQuestions.map((question) => `- ${question}`),
        ].join("\n")
      : null,
  ].filter(
    (section): section is string => section !== null && section.length > 0,
  );

  return {
    feature: draft.feature,
    ticket: draft.ticket,
    requirements: sections.length > 0 ? sections.join("\n\n") : null,
    baseRef: draft.baseRef,
  };
}

/**
 * Drops "References:" / "Open questions:" blocks that toSessionContext
 * appended to an earlier version. A regeneration sees those requirements as
 * the previous context and may echo them back; without this, every approval
 * would stack another copy.
 */
export function stripAppendedSections(requirements: string): string {
  return requirements
    .split(/\n{2,}/u)
    .filter(
      (block) =>
        !/^(?:References|Open questions):\n(?:- .*(?:\n|$))+$/u.test(
          block.trim() + "\n",
        ),
    )
    .join("\n\n")
    .trim();
}

function buildSessionDraftUserPrompt(input: {
  context: PromptContext;
  direction: string;
  docs: string[];
  previousContext: SessionContext | null;
  previousDraft: SessionDraft | null;
  feedback: string | null;
  recovery: RecoveryEvidence | null;
}): string {
  const { context } = input;
  const shownDocs = input.docs.slice(0, MAX_DOC_PATHS);

  return [
    "The author's direction for this session (their decision — back it, do not replace it):",
    input.direction,
    "",
    `Repository branch: ${context.branch}`,
    `Target/base branch: ${context.baseRef ?? "(unknown)"}`,
    context.ticket
      ? `Ticket detected from the branch: ${context.ticket}`
      : null,
    describeHandoff(context.handoff, context.branch),
    input.recovery === null ? null : describeRecovery(input.recovery),
    "",
    "Commits already on this branch:",
    context.log || "(none yet)",
    context.changedFiles
      ? [
          "",
          "Files already changed vs the base branch:",
          context.changedFiles,
        ].join("\n")
      : null,
    shownDocs.length > 0
      ? [
          "",
          `Markdown documents tracked in the repository (${input.docs.length}):`,
          ...shownDocs,
          ...(input.docs.length > shownDocs.length
            ? [`… +${input.docs.length - shownDocs.length} more`]
            : []),
        ].join("\n")
      : null,
    input.previousContext
      ? [
          "",
          "Session context saved earlier for this branch (revise it):",
          `Feature: ${input.previousContext.feature}`,
          input.previousContext.ticket
            ? `Ticket: ${input.previousContext.ticket}`
            : null,
          input.previousContext.requirements
            ? `Requirements: ${input.previousContext.requirements}`
            : null,
        ]
          .filter((line) => line !== null)
          .join("\n")
      : null,
    input.previousDraft
      ? [
          "",
          "Previous draft (revise it; do not start over):",
          JSON.stringify(
            {
              feature: input.previousDraft.feature,
              requirements: input.previousDraft.requirements,
              ticket: input.previousDraft.ticket,
              sources: input.previousDraft.sources,
              openQuestions: input.previousDraft.openQuestions,
            },
            null,
            2,
          ),
        ].join("\n")
      : null,
    input.feedback
      ? [
          "",
          "The author's feedback on the previous draft (apply all of it):",
          input.feedback,
        ].join("\n")
      : null,
    "",
    "Write the session context JSON now.",
  ]
    .filter((line) => line !== null)
    .join("\n");
}

/**
 * The recovery brief: the pipeline's leftovers named up front, so the
 * explorer starts from the failure instead of rediscovering the repository.
 */
function describeRecovery(recovery: RecoveryEvidence): string {
  return [
    "",
    "RECOVERY MODE: an automated pipeline (AI agents) produced the commits on this branch and could not finish — its fix attempts ran out, tests may be failing, or the work is incomplete. A developer is taking over; the session context must let them do so without re-reading everything.",
    recovery.diagnosis
      ? [
          "",
          "Failure diagnosis the developer brought (from the ticket or the CI run):",
          recovery.diagnosis.text,
        ].join("\n")
      : "No diagnosis was supplied: infer the failure from the commits, the files below, and the code.",
    recovery.candidates.length > 0
      ? [
          "",
          "Files on this branch that likely describe the work or the failure — read these first:",
          ...recovery.candidates.map((file) => `- ${file}`),
        ].join("\n")
      : null,
  ]
    .filter((line) => line !== null)
    .join("\n");
}

type ParsedReply = {
  feature: string;
  requirements: string | null;
  ticket: string | null;
  sources: SessionDraftSource[];
  openQuestions: string[];
};

/** Exported for tests: the model's reply as typed fields, nothing validated yet. */
export function parseSessionDraftReply(text: string): ParsedReply {
  const parsed = extractJsonObject(text);
  const feature =
    typeof parsed.feature === "string" ? parsed.feature.trim() : "";

  if (feature.length === 0) {
    throw new InvalidModelJsonError(text);
  }

  const requirements = asMarkdownList(parsed.requirements);
  const ticket =
    typeof parsed.ticket === "string" && parsed.ticket.trim().length > 0
      ? parsed.ticket.trim()
      : null;
  const sources = Array.isArray(parsed.sources)
    ? parsed.sources.flatMap((entry): SessionDraftSource[] => {
        if (typeof entry === "string") {
          return [{ path: entry, why: "" }];
        }

        if (typeof entry !== "object" || entry === null) {
          return [];
        }

        const record = entry as Record<string, unknown>;

        return typeof record.path === "string"
          ? [
              {
                path: record.path,
                why: typeof record.why === "string" ? record.why.trim() : "",
              },
            ]
          : [];
      })
    : [];
  const openQuestions = Array.isArray(parsed.openQuestions)
    ? parsed.openQuestions
        .filter((question): question is string => typeof question === "string")
        .map((question) => question.trim())
        .filter((question) => question.length > 0)
    : [];

  return { feature, requirements, ticket, sources, openQuestions };
}

/**
 * Requirements as one markdown string. Models asked for "a markdown list"
 * often return a JSON array of lines instead; both are accepted.
 */
function asMarkdownList(value: unknown): string | null {
  if (typeof value === "string") {
    return value.trim().length > 0 ? value.trim() : null;
  }

  if (!Array.isArray(value)) {
    return null;
  }

  const lines = value
    .filter((line): line is string => typeof line === "string")
    .map((line) => line.trim().replace(/^[-*]\s+/u, ""))
    .filter((line) => line.length > 0);

  return lines.length > 0 ? lines.map((line) => `- ${line}`).join("\n") : null;
}

/**
 * Applies the deterministic guarantees the model cannot be trusted with:
 * the author's direction stays in the feature, a ticket must appear in the
 * evidence, a source must be a tracked file, and secrets never survive.
 */
export function finalizeDraft(
  reply: ParsedReply,
  evidence: {
    direction: string;
    detectedTicket: string | null;
    previousTicket: string | null;
    evidence: string;
    knownFiles: Set<string>;
    repoRoot: string;
  },
): Pick<
  SessionDraft,
  "feature" | "requirements" | "ticket" | "sources" | "openQuestions"
> {
  const redact = (text: string): string => redactSecrets(text).text;
  const seen = new Set<string>();
  const sources = reply.sources.flatMap((source): SessionDraftSource[] => {
    const relPath = normalizeSourcePath(source.path, evidence.repoRoot);

    if (
      !evidence.knownFiles.has(relPath) ||
      isSecretPath(relPath) ||
      seen.has(relPath)
    ) {
      return [];
    }

    seen.add(relPath);

    return [{ path: relPath, why: redact(source.why) }];
  });

  return {
    feature: redact(keepDirection(reply.feature, evidence.direction)),
    requirements:
      reply.requirements === null ? null : redact(reply.requirements),
    ticket:
      evidence.detectedTicket ??
      acceptTicket(reply.ticket, evidence.evidence) ??
      evidence.previousTicket,
    sources,
    openQuestions: reply.openQuestions.slice(0, MAX_OPEN_QUESTIONS).map(redact),
  };
}

/**
 * Text without the pre-filled recovery goal at its start: the whole goal, or
 * just its opening sentence (what a model echoing it tends to keep). "" when
 * nothing else is left.
 */
export function withoutRecoveryGoal(text: string): string {
  const lead = RECOVERY_DIRECTION.slice(0, RECOVERY_DIRECTION.indexOf(".") + 1);

  for (const prefix of [RECOVERY_DIRECTION, lead]) {
    if (text.startsWith(prefix)) {
      return text.slice(prefix.length).trim();
    }
  }

  return text;
}

/** A short direction is the author's goal: it must stay in their words. */
function keepDirection(feature: string, direction: string): string {
  if (direction.length > MAX_QUOTED_DIRECTION) {
    return feature;
  }

  const normalize = (text: string): string =>
    text.toLowerCase().replace(/\s+/gu, " ").trim();

  return normalize(feature).includes(normalize(direction))
    ? feature
    : `${direction}\n\n${feature}`;
}

/** A model-proposed ticket survives only when the evidence contains it. */
function acceptTicket(ticket: string | null, evidence: string): string | null {
  if (ticket === null) {
    return null;
  }

  const id = extractTicketId(ticket);

  return id !== null && evidence.toUpperCase().includes(id.toUpperCase())
    ? id
    : null;
}

function normalizeSourcePath(rawPath: string, repoRoot: string): string {
  const trimmed = rawPath.trim().replace(/^`|`$/gu, "");
  const relative = path.isAbsolute(trimmed)
    ? path.relative(repoRoot, trimmed)
    : trimmed;

  return relative.split(path.sep).join("/").replace(/^\.\//u, "");
}

/**
 * One repair round on unparseable output. It is single-shot on purpose —
 * re-exploring would only repeat the cost — so the files the explorer opened
 * are handed back as excerpts: an explorer that read the evidence but
 * narrated instead of answering must not lose that evidence in the repair.
 */
async function parseOrRepair(
  text: string,
  systemPrompt: string,
  userPrompt: string,
  llm: Parameters<typeof runSingleShot>[2],
  readExcerpts: () => Promise<string>,
): Promise<ParsedReply> {
  try {
    return parseSessionDraftReply(text);
  } catch (error) {
    if (!(error instanceof InvalidModelJsonError)) {
      throw error;
    }
  }

  llm?.onEvent?.({
    type: "status",
    message: "Model returned invalid JSON — asking it to correct the format...",
  });

  const excerpts = await readExcerpts();
  const retryPrompt = [
    userPrompt,
    excerpts.length > 0
      ? `\nFiles you opened while exploring (excerpts — you cannot open files now):\n${excerpts}`
      : null,
    `\nYour previous response was not valid JSON:\n${text}`,
    `\nReturn the session context in the required shape, grounded in the files above. ${JSON_ONLY_INSTRUCTION}`,
  ]
    .filter((part) => part !== null)
    .join("\n");
  const retry = await runSingleShot(systemPrompt, retryPrompt, llm);

  try {
    return parseSessionDraftReply(retry.text);
  } catch (error) {
    if (error instanceof InvalidModelJsonError) {
      throw new CliError(
        "The model did not return a usable session context. Try again, or write it manually.",
      );
    }

    throw error;
  }
}

/** Bounded excerpts of the tracked, non-secret files the explorer opened. */
async function buildReadExcerpts(
  repoRoot: string,
  filesRead: string[],
  knownFiles: Set<string>,
): Promise<string> {
  const excerpts: string[] = [];

  for (const file of filesRead.slice(0, MAX_DOC_EXCERPTS * 2)) {
    if (!knownFiles.has(file) || isSecretPath(file)) {
      continue;
    }

    const content = await readCapped(
      path.join(repoRoot, file),
      MAX_EXCERPT_BYTES,
    );

    if (content !== null) {
      excerpts.push(`--- ${file} ---\n${content}`);
    }
  }

  return redactSecrets(excerpts.join("\n\n")).text;
}

/**
 * For a model that cannot open files: excerpts of the recovery candidates,
 * which are what such a model most needs and would otherwise never see.
 */
async function buildRecoveryDigest(
  repoRoot: string,
  candidates: string[],
  knownFiles: Set<string>,
): Promise<string> {
  const excerpts = await buildReadExcerpts(repoRoot, candidates, knownFiles);

  return excerpts.length > 0
    ? `Files the failed pipeline left on this branch (excerpts):\n${excerpts}`
    : "";
}

function isMarkdownPath(file: string): boolean {
  return /\.(md|mdx|markdown)$/iu.test(file);
}

/**
 * Words too common to tie a doc to the direction ("add that with the…",
 * "agregar para esta…"): matching them would excerpt nearly every doc.
 */
const DIGEST_STOPWORDS = new Set([
  "about",
  "also",
  "been",
  "from",
  "have",
  "into",
  "just",
  "like",
  "make",
  "more",
  "need",
  "only",
  "should",
  "some",
  "than",
  "that",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "when",
  "where",
  "which",
  "will",
  "with",
  "would",
  "your",
  "add",
  "change",
  "fix",
  "update",
  "para",
  "como",
  "esta",
  "este",
  "esto",
  "pero",
  "porque",
  "sobre",
  "todo",
  "todos",
  "cuando",
  "donde",
  "entre",
  "hacer",
  "desde",
  "hasta",
  "tiene",
  "tener",
  "debe",
  "puede",
  "agregar",
  "añadir",
  "cambiar",
  "arreglar",
]);

/**
 * What a model that cannot open files gets instead: the tracked markdown
 * documents, with bounded excerpts of the ones whose path or opening text
 * mentions words from the direction, feedback or ticket.
 */
export async function buildDocsDigest(
  repoRoot: string,
  docs: string[],
  hints: string[],
): Promise<string> {
  if (docs.length === 0) {
    return "";
  }

  const keywords = [
    ...new Set(
      hints
        .join(" ")
        .toLowerCase()
        .split(/[^\p{L}\p{N}-]+/u)
        .filter((word) => word.length >= 4 && !DIGEST_STOPWORDS.has(word)),
    ),
  ];
  const excerpts: string[] = [];

  for (const doc of docs) {
    if (excerpts.length >= MAX_DOC_EXCERPTS || keywords.length === 0) {
      break;
    }

    const content = await readCapped(
      path.join(repoRoot, doc),
      MAX_EXCERPT_BYTES,
    );

    if (content === null) {
      continue;
    }

    const haystack = `${doc}\n${content}`.toLowerCase();

    if (keywords.some((word) => haystack.includes(word))) {
      excerpts.push(`--- ${doc} ---\n${content}`);
    }
  }

  return redactSecrets(
    [
      excerpts.length > 0
        ? `Markdown documents related to the direction (excerpts):\n${excerpts.join("\n\n")}`
        : "No markdown document mentions the direction's keywords.",
    ].join("\n\n"),
  ).text;
}

function countLines(text: string): number {
  return text.split("\n").filter((line) => line.trim().length > 0).length;
}
