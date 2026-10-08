import { useEffect, useRef, useState } from "react";
import { Box, Text } from "ink";
import type { GlobalFlags } from "../commands.js";
import {
  createSessionDraftRun,
  toSessionContext,
  type SessionDraft,
  type SessionDraftMeta,
  type SessionDraftRequest,
  type SessionDraftRun,
} from "../domain/session-draft.js";
import { HANDOFF_FILENAME } from "../domain/handoff-export.js";
import type { SessionContext } from "../session/store.js";
import { MultilinePrompt, ScrollView, SelectList } from "./menu-view.js";
import { HeadPanel } from "./panel.js";
import { useReviewLogRows, useReviewPreviewRows } from "./review-shared.js";
import { appendEvent, RunLog, type LogItem } from "./run-view.js";
import { getErrorMessage, isDebugMode } from "./shared.js";
import { Spinner } from "./spinner.js";
import { theme } from "./theme.js";

export type SessionDraftOutcome =
  | { status: "approved"; context: SessionContext }
  /** The author wants to finish it by hand in the manual form. */
  | { status: "edit"; context: SessionContext }
  | { status: "cancelled" };

type FeedbackKind = "goal" | "details" | "look";

type Phase =
  | { phase: "loading" }
  | { phase: "direction"; meta: SessionDraftMeta }
  | { phase: "mode-pick"; meta: SessionDraftMeta; direction: string }
  | { phase: "generating"; label: string }
  | { phase: "review"; draft: SessionDraft }
  | { phase: "feedback-input"; draft: SessionDraft; kind: FeedbackKind }
  | { phase: "view-full"; draft: SessionDraft }
  | { phase: "questions-confirm"; draft: SessionDraft }
  | {
      phase: "error";
      message: string;
      /** The round to retry; null when the evidence could not be gathered. */
      request: SessionDraftRequest | null;
      draft: SessionDraft | null;
    };

/**
 * Rows around the preview during review: heading (1), mode line (1), the
 * panel's borders and hidden note (3), and the select list (13 — title, two
 * borders, two scroll indicators, seven items and a footer).
 */
const REVIEW_EXTRA_ROWS = 18;

/** Lines summarising the evidence, shown before the author writes the direction. */
export function describeSessionEvidence(meta: SessionDraftMeta): string[] {
  const plural = (count: number, word: string): string =>
    `${count} ${word}${count === 1 ? "" : "s"}`;

  return [
    `Branch ${meta.branch} → ${meta.baseRef ?? "(target not detected)"}${meta.ticket ? ` · ticket ${meta.ticket}` : ""}`,
    `${plural(meta.commits, "commit")} · ${plural(meta.changedFiles, "changed file")} · ${plural(meta.docs, "markdown doc")}${meta.handoff ? ` · ${HANDOFF_FILENAME}` : ""}`,
    meta.exploreKind === "none"
      ? "This provider cannot open files: the AI gets git, the repo brief and matching docs instead."
      : "The AI can read the code and docs read-only — it never changes a file.",
  ];
}

/** The draft as the reviewer sees it: the goal first, then the evidence. */
export function formatSessionDraft(draft: SessionDraft): string {
  return [
    "Feature",
    draft.feature,
    "",
    `Ticket: ${draft.ticket ?? "(none)"}`,
    `Target branch: ${draft.baseRef ?? "(auto-detect)"}`,
    "",
    "Requirements",
    draft.requirements ??
      "(none found in the repository — add them as details)",
    "",
    "Sources",
    ...(draft.sources.length > 0
      ? draft.sources.map((source) =>
          source.why ? `- ${source.path} — ${source.why}` : `- ${source.path}`,
        )
      : ["- (none)"]),
    "",
    "Open questions",
    ...(draft.openQuestions.length > 0
      ? draft.openQuestions.map((question) => `- ${question}`)
      : ["- (none)"]),
  ].join("\n");
}

export function describeDraftMode(draft: SessionDraft): string {
  if (draft.mode === "single-shot") {
    return `single-shot — ${draft.fallbackReason ?? "no repository reading"}`;
  }

  return `read the repository read-only · ${draft.filesRead.length} file${draft.filesRead.length === 1 ? "" : "s"} opened`;
}

const FEEDBACK_PROMPTS: Record<
  FeedbackKind,
  { label: string; placeholder: string }
> = {
  goal: {
    label: "New direction — what should this session achieve instead?",
    placeholder:
      "e.g. Only the retry policy for now; the UI error message is a separate branch (multi-line ok, ctrl+d to submit)",
  },
  details: {
    label:
      "Details — answer the open questions or add what the repository does not say",
    placeholder:
      "e.g. Max 3 retries with exponential backoff; files over 2 GB are out of scope (multi-line ok, ctrl+d to submit)",
  },
  look: {
    label: "Where should the AI look again, and for what?",
    placeholder:
      "e.g. Read docs/reports/ for the incident write-up and the upload service tests (multi-line ok, ctrl+d to submit)",
  },
};

type SessionDraftFlowProps = {
  flags: GlobalFlags;
  /** The saved context when regenerating one; the draft revises it. */
  previous: SessionContext | null;
  isActive: boolean;
  onDone: (outcome: SessionDraftOutcome) => void;
};

/**
 * direction → (read the code?) → generate → review → refine → approve.
 * The author steers every round: the goal can change, details and answers
 * can be added, or the AI can be sent back into the repository. Nothing is
 * saved here — the approved context goes back to the host.
 */
export function SessionDraftFlow({
  flags,
  previous,
  isActive,
  onDone,
}: SessionDraftFlowProps) {
  const previewRows = useReviewPreviewRows(REVIEW_EXTRA_ROWS);
  // The exploration log grows one line per file read: window it, or a long
  // run makes the frame terminal-tall and Ink's full redraws freeze the CLI.
  const logRows = useReviewLogRows(4);
  const [phase, setPhase] = useState<Phase>({ phase: "loading" });
  const [log, setLog] = useState<LogItem[]>([]);
  const runRef = useRef<SessionDraftRun | null>(null);
  const cancelledRef = useRef(false);
  const doneRef = useRef(false);
  const nextLogId = useRef(1);

  function finish(outcome: SessionDraftOutcome): void {
    if (doneRef.current) {
      return;
    }

    doneRef.current = true;
    setTimeout(() => {
      onDone(outcome);
    }, 0);
  }

  async function load(): Promise<void> {
    setPhase({ phase: "loading" });

    try {
      runRef.current = await createSessionDraftRun(flags, process.cwd(), {
        previous,
      });

      if (!cancelledRef.current) {
        setPhase({ phase: "direction", meta: runRef.current.meta });
      }
    } catch (error) {
      if (!cancelledRef.current) {
        setPhase({
          phase: "error",
          message: getErrorMessage(error),
          request: null,
          draft: null,
        });
      }
    }
  }

  async function generate(
    request: SessionDraftRequest,
    current: SessionDraft | null,
  ): Promise<void> {
    const run = runRef.current;

    if (run === null) {
      return;
    }

    setLog([]);
    setPhase({
      phase: "generating",
      label:
        request.feedback === null
          ? request.explore
            ? "Reading the repository for evidence..."
            : "Drafting the session context..."
          : request.explore
            ? "Looking again in the repository..."
            : "Applying your feedback...",
    });

    try {
      const draft = await run.generate(request, {
        debug: isDebugMode(),
        onEvent: (event) => {
          if (event.type !== "debug" && event.type !== "status") {
            return;
          }

          setLog((items) =>
            appendEvent(items, event, () => nextLogId.current++),
          );
        },
      });

      if (!cancelledRef.current) {
        setPhase({ phase: "review", draft });
      }
    } catch (error) {
      if (!cancelledRef.current) {
        setPhase({
          phase: "error",
          message: getErrorMessage(error),
          request,
          draft: current,
        });
      }
    }
  }

  function submitFeedback(
    draft: SessionDraft,
    kind: FeedbackKind,
    text: string,
  ): void {
    if (kind === "goal") {
      void generate(
        {
          feedback: `The author changed the goal of this session to: ${text}`,
          direction: text,
          explore: false,
        },
        draft,
      );
      return;
    }

    void generate({ feedback: text, explore: kind === "look" }, draft);
  }

  useEffect(() => {
    void load();

    return () => {
      cancelledRef.current = true;
    };
    // Mount-only: the flow drives itself through phase transitions.
  }, []);

  if (phase.phase === "loading") {
    return <Spinner label="Reading the branch, its commits and documents..." />;
  }

  if (phase.phase === "direction") {
    return (
      <Box flexDirection="column">
        {describeSessionEvidence(phase.meta).map((line) => (
          <Text color={theme.dim} key={line} wrap="truncate-end">
            {line}
          </Text>
        ))}
        <MultilinePrompt
          initialValue={previous?.feature ?? ""}
          isActive={isActive}
          key="direction"
          label="Direction — what is this session for, and what should it achieve?"
          onCancel={() => {
            finish({ status: "cancelled" });
          }}
          onSubmit={(direction) => {
            if (phase.meta.exploreKind === "none") {
              void generate({ feedback: null, direction, explore: true }, null);
            } else {
              setPhase({ phase: "mode-pick", meta: phase.meta, direction });
            }
          }}
          placeholder="e.g. Retry failed uploads on flaky networks — see docs/uploader-report.md; paste the ticket text or rules if you have them (multi-line ok, ctrl+d to submit)"
        />
      </Box>
    );
  }

  if (phase.phase === "mode-pick") {
    return (
      <SelectList
        isActive={isActive}
        key="mode-pick"
        items={[
          {
            id: "explore",
            label: "Read the code and docs (read-only)",
            hint: "recommended — the AI looks for evidence and never changes a file",
          },
          {
            id: "quick",
            label: "Don't read the code",
            hint: "faster — git state, the repo brief and matching docs only",
          },
        ]}
        onCancel={() => {
          setPhase({ phase: "direction", meta: phase.meta });
        }}
        onSelect={(id) => {
          void generate(
            {
              feedback: null,
              direction: phase.direction,
              explore: id === "explore",
            },
            null,
          );
        }}
        title="How should the AI gather evidence?"
      />
    );
  }

  if (phase.phase === "generating") {
    return (
      <Box flexDirection="column">
        {log.length > 0 ? <RunLog log={log} maxRows={logRows} /> : null}
        <Spinner label={phase.label} />
      </Box>
    );
  }

  if (phase.phase === "review") {
    const { draft } = phase;

    return (
      <Box flexDirection="column">
        <Text color={theme.accent}>Proposed session context</Text>
        <Text color={theme.dim} wrap="truncate-end">
          {describeDraftMode(draft)}
        </Text>
        {previewRows !== null ? (
          <HeadPanel
            hiddenHint=" — pick “View full” to read it all"
            maxRows={previewRows}
            text={formatSessionDraft(draft)}
          />
        ) : (
          <Text dimColor>Draft ready — pick “View full” to read it.</Text>
        )}
        <SelectList
          isActive={isActive}
          key="review"
          items={[
            {
              id: "approve",
              label: "Approve and save",
              hint:
                draft.openQuestions.length > 0
                  ? `save it — ${draft.openQuestions.length} open question${draft.openQuestions.length === 1 ? "" : "s"} left`
                  : "save it as this branch's session context",
            },
            {
              id: "goal",
              label: "Refine the goal",
              hint: "change or narrow what this session is for",
            },
            {
              id: "details",
              label: "Add details / answer questions",
              hint: "enrich it with what the repository does not say",
            },
            {
              id: "look",
              label: "Look again in the repository",
              hint: "send the AI back to read, guided by your note",
            },
            {
              id: "edit",
              label: "Edit manually",
              hint: "open the context form pre-filled with this draft",
            },
            {
              id: "view",
              label: "View full",
              hint: "scroll the whole draft (j/k, wheel, esc back)",
            },
            {
              id: "cancel",
              label: "Cancel",
              hint: "discard it — nothing is saved",
            },
          ]}
          onCancel={() => {
            finish({ status: "cancelled" });
          }}
          onSelect={(id) => {
            if (id === "approve") {
              if (draft.openQuestions.length > 0) {
                setPhase({ phase: "questions-confirm", draft });
              } else {
                finish({
                  status: "approved",
                  context: toSessionContext(draft, {
                    keepOpenQuestions: false,
                  }),
                });
              }
            } else if (id === "goal" || id === "details" || id === "look") {
              setPhase({ phase: "feedback-input", draft, kind: id });
            } else if (id === "edit") {
              finish({
                status: "edit",
                context: toSessionContext(draft, { keepOpenQuestions: true }),
              });
            } else if (id === "view") {
              setPhase({ phase: "view-full", draft });
            } else {
              finish({ status: "cancelled" });
            }
          }}
          title="Does this capture the session?"
        />
      </Box>
    );
  }

  if (phase.phase === "feedback-input") {
    const prompt = FEEDBACK_PROMPTS[phase.kind];

    return (
      <MultilinePrompt
        isActive={isActive}
        key={`feedback-${phase.kind}`}
        label={prompt.label}
        onCancel={() => {
          setPhase({ phase: "review", draft: phase.draft });
        }}
        onSubmit={(text) => {
          submitFeedback(phase.draft, phase.kind, text);
        }}
        placeholder={prompt.placeholder}
      />
    );
  }

  if (phase.phase === "view-full") {
    return (
      <ScrollView
        isActive={isActive}
        onExit={() => {
          setPhase({ phase: "review", draft: phase.draft });
        }}
        text={`${describeDraftMode(phase.draft)}\n\n${formatSessionDraft(phase.draft)}`}
        title="Proposed session context — full text"
      />
    );
  }

  if (phase.phase === "questions-confirm") {
    const { draft } = phase;

    return (
      <SelectList
        isActive={isActive}
        key="questions-confirm"
        items={[
          {
            id: "answer",
            label: "Answer them first",
            hint: "add the answers as details and regenerate",
          },
          {
            id: "keep",
            label: "Save with the questions",
            hint: "they are kept under “Open questions” so the next step sees them",
          },
          {
            id: "back",
            label: "Back to the draft",
            hint: "nothing is saved yet",
          },
        ]}
        onCancel={() => {
          setPhase({ phase: "review", draft });
        }}
        onSelect={(id) => {
          if (id === "answer") {
            setPhase({ phase: "feedback-input", draft, kind: "details" });
          } else if (id === "keep") {
            finish({
              status: "approved",
              context: toSessionContext(draft, { keepOpenQuestions: true }),
            });
          } else {
            setPhase({ phase: "review", draft });
          }
        }}
        title={`${draft.openQuestions.length} open question${draft.openQuestions.length === 1 ? "" : "s"} still unanswered`}
      />
    );
  }

  const { request, draft } = phase;

  return (
    <Box flexDirection="column">
      {log.length > 0 ? (
        <RunLog log={log} maxRows={Math.max(1, logRows - 8)} />
      ) : null}
      <Text color={theme.error} wrap="truncate-end">
        Error: {phase.message.split("\n")[0]}
      </Text>
      {phase.message.includes("\n") ? (
        <Text color={theme.dim} wrap="truncate-end">
          {phase.message.split("\n").slice(1, 3).join(" · ")}
        </Text>
      ) : null}
      <SelectList
        isActive={isActive}
        key="error"
        items={[
          { id: "retry", label: "Retry", hint: "run the same step again" },
          ...(request?.explore
            ? [
                {
                  id: "no-explore",
                  label: "Retry without reading the code",
                  hint: "git state, the repo brief and matching docs only",
                },
              ]
            : []),
          ...(draft !== null
            ? [
                {
                  id: "back",
                  label: "Back to the draft",
                  hint: "keep the last draft",
                },
              ]
            : []),
          { id: "cancel", label: "Cancel", hint: "nothing is saved" },
        ]}
        onCancel={() => {
          finish({ status: "cancelled" });
        }}
        onSelect={(id) => {
          if (id === "retry") {
            if (request === null) {
              void load();
            } else {
              void generate(request, draft);
            }
          } else if (id === "no-explore" && request !== null) {
            void generate({ ...request, explore: false }, draft);
          } else if (id === "back" && draft !== null) {
            setPhase({ phase: "review", draft });
          } else {
            finish({ status: "cancelled" });
          }
        }}
        title="The session context could not be generated"
      />
    </Box>
  );
}
