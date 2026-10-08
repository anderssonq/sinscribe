import { useEffect, useRef, useState } from "react";
import { Box, Text } from "ink";
import type { RunCallbacks } from "../llm/events.js";
import { MultilinePrompt, ScrollView, SelectList } from "./menu-view.js";
import { TailPanel } from "./panel.js";
import { useReviewLogRows, useReviewPreviewRows } from "./review-shared.js";
import { appendEvent, RunLog, type LogItem } from "./run-view.js";
import { getErrorMessage, isDebugMode } from "./shared.js";
import { Spinner } from "./spinner.js";
import { theme } from "./theme.js";

/**
 * The generate → review → refine → approve cycle, generalised from the
 * handoff flow so every spec plan stage shares one state machine. The host
 * supplies the three actions; this component owns the phases, the windowed
 * preview, and the cancel/done bookkeeping.
 */

export type DocDraft = {
  content: string;
  /** "✗ …" lines block approval; the rest are advisory. */
  warnings: string[];
  /** One-line context, e.g. "explored the repo read-only · 12 file(s) read". */
  note: string;
};

export type DocReviewOutcome =
  | { status: "approved"; summary: string[] }
  | { status: "draft"; summary: string[] }
  | { status: "cancelled" };

type Phase =
  | { phase: "generating"; label: string }
  | { phase: "review"; draft: DocDraft }
  | { phase: "view-full"; draft: DocDraft }
  | { phase: "refine-input"; draft: DocDraft }
  | { phase: "saving"; draft: DocDraft; label: string }
  | {
      phase: "error";
      message: string;
      origin: "generate" | "approve" | "draft";
      draft: DocDraft | null;
      /** The feedback a failed generation was given, so Retry keeps it. */
      feedback: string | null;
    };

const MAX_WARNING_ROWS = 3;
/** Heading, stepper and note lines, plus the panel's borders and hidden note. */
const REVIEW_FIXED_ROWS = 6;
/** SelectList chrome: title, two borders, two scroll indicators, footer. */
const SELECT_CHROME_ROWS = 6;

export type DocReviewFlowProps = {
  title: string;
  /** One line above everything, e.g. "Stage 2/4 · ✓ Requirements ▸ Design". */
  stepper?: string;
  isActive: boolean;
  /** Start in review on an existing draft instead of generating. */
  initialDraft?: DocDraft | null;
  /** Feedback for the first generation (e.g. `--feedback` on the CLI). */
  initialFeedback?: string | null;
  generate: (
    feedback: string | null,
    callbacks: RunCallbacks,
  ) => Promise<DocDraft>;
  approve: () => Promise<string[]>;
  saveDraft?: () => Promise<string[]>;
  approveLabel: string;
  generatingLabel: string;
  /**
   * Shown on the error screen when set (an exploration can be skipped);
   * receives the failed generation's feedback so it is not lost.
   */
  onRetryWithoutExplore?: (feedback: string | null) => void;
  refinePlaceholder: string;
  onDone: (outcome: DocReviewOutcome) => void;
};

export function DocReviewFlow({
  title,
  stepper,
  isActive,
  initialDraft = null,
  initialFeedback = null,
  generate,
  approve,
  saveDraft,
  approveLabel,
  generatingLabel,
  onRetryWithoutExplore,
  refinePlaceholder,
  onDone,
}: DocReviewFlowProps) {
  const [phase, setPhase] = useState<Phase>(
    initialDraft !== null
      ? { phase: "review", draft: initialDraft }
      : { phase: "generating", label: generatingLabel },
  );
  const [log, setLog] = useState<LogItem[]>([]);
  const cancelledRef = useRef(false);
  const doneRef = useRef(false);
  const nextLogId = useRef(1);

  const reviewItems = buildReviewItems(
    phase,
    approveLabel,
    saveDraft !== undefined,
  );
  const warnings = phase.phase === "review" ? phase.draft.warnings : [];
  const warningRows =
    Math.min(warnings.length, MAX_WARNING_ROWS) +
    (warnings.length > MAX_WARNING_ROWS ? 1 : 0);
  const previewRows = useReviewPreviewRows(
    REVIEW_FIXED_ROWS +
      (stepper ? 1 : 0) +
      warningRows +
      reviewItems.length +
      SELECT_CHROME_ROWS,
  );
  // Explore runs stream dozens of tool lines: the log must be windowed.
  const logRows = useReviewLogRows((stepper ? 1 : 0) + 4);

  function finish(outcome: DocReviewOutcome): void {
    if (doneRef.current) {
      return;
    }

    doneRef.current = true;
    setTimeout(() => {
      onDone(outcome);
    }, 0);
  }

  /** `from` is the draft under review, kept so a failure can return to it. */
  async function runGenerate(
    feedback: string | null,
    from: DocDraft | null,
  ): Promise<void> {
    setLog([]);
    setPhase({
      phase: "generating",
      label:
        feedback !== null
          ? "Regenerating with your feedback..."
          : generatingLabel,
    });

    try {
      const draft = await generate(feedback, {
        debug: isDebugMode(),
        onEvent: (event) => {
          if (event.type === "text") {
            return;
          }

          setLog((current) =>
            appendEvent(current, event, () => nextLogId.current++),
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
          origin: "generate",
          draft: from,
          feedback,
        });
      }
    }
  }

  async function runWrite(
    draft: DocDraft,
    kind: "approve" | "draft",
  ): Promise<void> {
    setPhase({
      phase: "saving",
      draft,
      label: kind === "approve" ? "Approving..." : "Saving draft...",
    });

    try {
      const summary =
        kind === "approve"
          ? await approve()
          : await (saveDraft as () => Promise<string[]>)();

      finish({ status: kind === "approve" ? "approved" : "draft", summary });
    } catch (error) {
      if (!cancelledRef.current) {
        setPhase({
          phase: "error",
          message: getErrorMessage(error),
          origin: kind,
          draft,
          feedback: null,
        });
      }
    }
  }

  useEffect(() => {
    if (initialDraft === null) {
      void runGenerate(initialFeedback, null);
    }

    return () => {
      cancelledRef.current = true;
    };
    // Mount-only: the flow drives itself through phase transitions.
  }, []);

  const header = (
    <>
      {stepper ? (
        <Text color={theme.dim} wrap="truncate-end">
          {stepper}
        </Text>
      ) : null}
      <Text color={theme.accent} wrap="truncate-end">
        {title}
      </Text>
    </>
  );

  if (phase.phase === "generating" || phase.phase === "saving") {
    return (
      <Box flexDirection="column">
        {stepper ? (
          <Text color={theme.dim} wrap="truncate-end">
            {stepper}
          </Text>
        ) : null}
        {log.length > 0 ? <RunLog log={log} maxRows={logRows} /> : null}
        <Spinner label={phase.label} />
      </Box>
    );
  }

  if (phase.phase === "review") {
    const { draft } = phase;
    const errors = draft.warnings.filter((line) => line.startsWith("✗"));
    const blocked = errors.length > 0;
    // No room for a preview: drop the stepper and note too, and fold the
    // validator lines into one, so the select list still fits.
    const compact = previewRows === null;

    return (
      <Box flexDirection="column">
        {compact ? (
          <Text color={theme.accent} wrap="truncate-end">
            {title}
          </Text>
        ) : (
          header
        )}
        {compact ? null : (
          <Text color={theme.dim} wrap="truncate-end">
            {draft.note}
          </Text>
        )}
        {previewRows !== null ? (
          <TailPanel
            hiddenHint=" — pick “View full” to scroll it all"
            maxRows={previewRows}
            text={draft.content}
          />
        ) : (
          <Text dimColor wrap="truncate-end">
            Draft ready — pick “View full” to read it.
          </Text>
        )}
        {compact && draft.warnings.length > 0 ? (
          <Text
            color={blocked ? theme.error : theme.accentAlt}
            wrap="truncate-end"
          >
            {blocked ? "✗" : "⚠"} {errors.length} error(s),{" "}
            {draft.warnings.length - errors.length} warning(s) — View full
          </Text>
        ) : null}
        {compact
          ? null
          : draft.warnings.slice(0, MAX_WARNING_ROWS).map((line, index) => (
              <Text
                color={line.startsWith("✗") ? theme.error : theme.accentAlt}
                key={index}
                wrap="truncate-end"
              >
                {line.startsWith("✗") ? line : `⚠ ${line}`}
              </Text>
            ))}
        {!compact && draft.warnings.length > MAX_WARNING_ROWS ? (
          <Text color={theme.dim} wrap="truncate-end">
            +{draft.warnings.length - MAX_WARNING_ROWS} more (View full)
          </Text>
        ) : null}
        <SelectList
          isActive={isActive}
          items={reviewItems}
          key="doc-review"
          onCancel={() => {
            finish({ status: "cancelled" });
          }}
          onSelect={(id) => {
            if (id === "approve") {
              void runWrite(draft, "approve");
            } else if (id === "fix") {
              void runGenerate(
                `Fix every problem the plan validator reported:\n${draft.warnings.join("\n")}`,
                draft,
              );
            } else if (id === "modify") {
              setPhase({ phase: "refine-input", draft });
            } else if (id === "view") {
              setPhase({ phase: "view-full", draft });
            } else if (id === "draft") {
              void runWrite(draft, "draft");
            } else {
              finish({ status: "cancelled" });
            }
          }}
          title={
            blocked
              ? "Fix the ✗ problems before approving"
              : "Approve this document?"
          }
        />
      </Box>
    );
  }

  if (phase.phase === "view-full") {
    const { draft } = phase;
    const text =
      draft.warnings.length > 0
        ? `${draft.content}\n\n---\nValidator:\n${draft.warnings.join("\n")}`
        : draft.content;

    return (
      <ScrollView
        isActive={isActive}
        onExit={() => {
          setPhase({ phase: "review", draft });
        }}
        text={text}
        title={`${title} — full text`}
      />
    );
  }

  if (phase.phase === "refine-input") {
    const { draft } = phase;

    return (
      <MultilinePrompt
        isActive={isActive}
        label="What should change?"
        onCancel={() => {
          setPhase({ phase: "review", draft });
        }}
        onSubmit={(feedback) => {
          void runGenerate(feedback, draft);
        }}
        placeholder={refinePlaceholder}
      />
    );
  }

  const { message, origin, draft, feedback } = phase;

  return (
    <Box flexDirection="column">
      {log.length > 0 ? (
        <RunLog log={log} maxRows={Math.max(1, logRows - 8)} />
      ) : null}
      <Text color={theme.error} wrap="truncate-end">
        Error: {message.split("\n")[0]}
      </Text>
      {message.includes("\n") ? (
        <Text color={theme.dim} wrap="truncate-end">
          {message.split("\n").slice(1, 3).join(" · ")}
        </Text>
      ) : null}
      <SelectList
        isActive={isActive}
        items={[
          {
            id: "retry",
            label: "Retry",
            hint:
              origin === "generate"
                ? feedback !== null
                  ? "run it again with the same feedback"
                  : "run the generation again"
                : "try writing again",
          },
          ...(origin === "generate" && onRetryWithoutExplore
            ? [
                {
                  id: "no-explore",
                  label: "Retry without exploring",
                  hint: "single-shot with the repo brief — faster, no file reads",
                },
              ]
            : []),
          ...(draft !== null
            ? [
                {
                  id: "back",
                  label: "Back to the draft",
                  hint: "keep reviewing it",
                },
              ]
            : []),
          { id: "cancel", label: "Cancel", hint: "leave this stage" },
        ]}
        key="doc-error"
        onCancel={() => {
          finish({ status: "cancelled" });
        }}
        onSelect={(id) => {
          if (id === "retry") {
            if (origin === "generate" || draft === null) {
              void runGenerate(feedback, draft);
            } else {
              void runWrite(draft, origin);
            }
          } else if (id === "no-explore") {
            onRetryWithoutExplore?.(feedback);
          } else if (id === "back" && draft !== null) {
            setPhase({ phase: "review", draft });
          } else {
            finish({ status: "cancelled" });
          }
        }}
        title="This step failed"
      />
    </Box>
  );
}

function buildReviewItems(
  phase: Phase,
  approveLabel: string,
  canSaveDraft: boolean,
): { id: string; label: string; hint: string }[] {
  const warnings = phase.phase === "review" ? phase.draft.warnings : [];
  const blocked = warnings.some((line) => line.startsWith("✗"));

  return [
    ...(blocked
      ? []
      : [
          {
            id: "approve",
            label: approveLabel,
            hint: "write it and move to the next stage",
          },
        ]),
    ...(warnings.length > 0
      ? [
          {
            id: "fix",
            label: "Fix validator issues",
            hint: "regenerate with the reported problems as feedback",
          },
        ]
      : []),
    {
      id: "modify",
      label: "Modify",
      hint: "describe what to change and regenerate",
    },
    {
      id: "view",
      label: "View full",
      hint: "scroll the whole document (j/k, wheel, esc back)",
    },
    ...(canSaveDraft
      ? [
          {
            id: "draft",
            label: "Save as draft",
            hint: "write it unapproved — approve later from the menu or with --approve",
          },
        ]
      : []),
    {
      id: "cancel",
      label: "Cancel",
      hint: "discard this draft — nothing is written",
    },
  ];
}
