import { useEffect, useRef, useState } from "react";
import { Box, Text } from "ink";
import type { GlobalFlags } from "../commands.js";
import { createHandoffRun, type HandoffInput } from "../domain/handoff.js";
import { HANDOFF_FILENAME } from "../domain/handoff-export.js";
import { MultilinePrompt, ScrollView, SelectList } from "./menu-view.js";
import { TailPanel } from "./panel.js";
import { useReviewPreviewRows } from "./review-shared.js";
import { appendEvent, RunLog, type LogItem } from "./run-view.js";
import { getErrorMessage, isDebugMode } from "./shared.js";
import { Spinner } from "./spinner.js";
import { theme } from "./theme.js";

type Phase =
  | { phase: "ask" }
  | { phase: "generating"; label: string }
  | { phase: "review"; content: string }
  | { phase: "view-full"; content: string }
  | { phase: "refine-input"; content: string }
  | { phase: "saving"; content: string }
  | {
      phase: "error";
      message: string;
      /** What Retry should redo: the generation, or the write. */
      origin: "generate" | "save";
      content: string | null;
    };

/**
 * Rows this flow renders around the tail-clamped draft during review: the
 * heading (1), the panel's borders and hidden-count note (3), and the select
 * list (10). A frame as tall as the terminal makes Ink redraw the whole
 * screen every render and the CLI reads as frozen, so the preview is windowed
 * to whatever is left over.
 */
const REVIEW_EXTRA_ROWS = 14;

type HandoffReviewFlowProps = {
  /**
   * The context the prompt run already gathered. Null outside a repo — the
   * flow then reports that and finishes without asking.
   */
  input: HandoffInput | null;
  flags: GlobalFlags;
  isActive: boolean;
  /** --handoff already answered the question: generate without asking. */
  autoStart: boolean;
  /** Summary lines to fold into the host's final screen. Empty when skipped. */
  onDone: (summary: string[]) => void;
};

/**
 * Offer → generate → review → refine → save cycle for HANDOFF.md, run after a
 * prompt is approved and exported. Every failure here is reported as a summary
 * line rather than an error: the agent prompt is already safely exported, so
 * nothing in this flow may turn a successful run into a failed one.
 */
export function HandoffReviewFlow({
  input,
  flags,
  isActive,
  autoStart,
  onDone,
}: HandoffReviewFlowProps) {
  const previewRows = useReviewPreviewRows(REVIEW_EXTRA_ROWS);
  const [phase, setPhase] = useState<Phase>({ phase: "ask" });
  const [log, setLog] = useState<LogItem[]>([]);
  const runRef = useRef<ReturnType<typeof createHandoffRun> | null>(null);
  const cancelledRef = useRef(false);
  const doneRef = useRef(false);
  const nextLogId = useRef(1);

  function finish(summary: string[]): void {
    if (doneRef.current) {
      return;
    }

    doneRef.current = true;
    // Deferred a tick so the host's final frame renders before it reacts
    // with app.exit() (same pattern as the prompt and PR flows).
    setTimeout(() => {
      onDone(summary);
    }, 0);
  }

  async function generate(feedback: string | null): Promise<void> {
    setLog([]);
    setPhase({
      phase: "generating",
      label:
        feedback !== null
          ? "Regenerating the handoff with your feedback..."
          : `Writing the ${HANDOFF_FILENAME} draft...`,
    });

    try {
      runRef.current ??= createHandoffRun(input as HandoffInput, flags);

      const content = await runRef.current.generate(feedback, {
        debug: isDebugMode(),
        onEvent: (event) => {
          if (event.type !== "debug" && event.type !== "status") {
            return;
          }

          setLog((current) =>
            appendEvent(current, event, () => nextLogId.current++),
          );
        },
      });

      if (cancelledRef.current) {
        return;
      }

      setPhase({ phase: "review", content });
    } catch (error) {
      if (cancelledRef.current) {
        return;
      }

      setPhase({
        phase: "error",
        message: getErrorMessage(error),
        origin: "generate",
        content: null,
      });
    }
  }

  async function save(content: string): Promise<void> {
    setPhase({ phase: "saving", content });

    try {
      const handoffPath = await (
        runRef.current as ReturnType<typeof createHandoffRun>
      ).save();

      finish([`Saved ${handoffPath}`]);
    } catch (error) {
      if (cancelledRef.current) {
        return;
      }

      setPhase({
        phase: "error",
        message: getErrorMessage(error),
        origin: "save",
        content,
      });
    }
  }

  useEffect(() => {
    // Outside a repo there is nowhere to write, so never ask the question.
    if (input === null) {
      finish([`Skipped ${HANDOFF_FILENAME}: no repository root found.`]);
    } else if (autoStart) {
      void generate(null);
    }

    return () => {
      cancelledRef.current = true;
    };
    // Mount-only: the flow drives itself through phase transitions.
  }, []);

  if (input === null) {
    return <Spinner label="Finishing..." />;
  }

  if (phase.phase === "ask") {
    return (
      <SelectList
        isActive={isActive}
        key="handoff-ask"
        items={[
          {
            id: "update",
            label:
              input.previousHandoff !== null
                ? `Update ${HANDOFF_FILENAME}`
                : `Create ${HANDOFF_FILENAME}`,
            hint: "record where this branch stands, so the next session starts warm",
          },
          {
            id: "skip",
            label: "Skip",
            hint:
              input.previousHandoff !== null
                ? "leave the existing file untouched"
                : "no handoff for this session",
          },
        ]}
        onCancel={() => {
          finish([]);
        }}
        onSelect={(id) => {
          if (id === "update") {
            void generate(null);
          } else {
            finish([]);
          }
        }}
        title={`Update the session handoff (${HANDOFF_FILENAME})?`}
      />
    );
  }

  if (phase.phase === "generating") {
    return (
      <Box flexDirection="column">
        {log.length > 0 ? <RunLog log={log} /> : null}
        <Spinner label={phase.label} />
      </Box>
    );
  }

  if (phase.phase === "review") {
    return (
      <Box flexDirection="column">
        <Text color={theme.accent}>Session handoff</Text>
        {previewRows !== null ? (
          <TailPanel
            hiddenHint=" — pick “View full” to scroll it all"
            maxRows={previewRows}
            text={phase.content}
          />
        ) : (
          <Text dimColor>Draft ready — pick “View full” to read it.</Text>
        )}
        <SelectList
          isActive={isActive}
          key="handoff-review"
          items={[
            {
              id: "save",
              label: `Save ${HANDOFF_FILENAME}`,
              hint: "write it at the repo root",
            },
            {
              id: "modify",
              label: "Modify",
              hint: "describe what to change and regenerate",
            },
            {
              id: "view",
              label: "View full",
              hint: "scroll the entire handoff (j/k, wheel, esc back)",
            },
            {
              id: "skip",
              label: "Skip",
              hint: "discard the draft — nothing is written",
            },
          ]}
          onCancel={() => {
            finish([`Skipped ${HANDOFF_FILENAME}.`]);
          }}
          onSelect={(id) => {
            if (id === "save") {
              void save(phase.content);
            } else if (id === "modify") {
              setPhase({ phase: "refine-input", content: phase.content });
            } else if (id === "view") {
              setPhase({ phase: "view-full", content: phase.content });
            } else {
              finish([`Skipped ${HANDOFF_FILENAME}.`]);
            }
          }}
          title="Does this reflect where things stand?"
        />
      </Box>
    );
  }

  if (phase.phase === "view-full") {
    return (
      <ScrollView
        isActive={isActive}
        onExit={() => {
          setPhase({ phase: "review", content: phase.content });
        }}
        text={phase.content}
        title="Session handoff — full text"
      />
    );
  }

  if (phase.phase === "refine-input") {
    return (
      <MultilinePrompt
        isActive={isActive}
        label="What should change?"
        onCancel={() => {
          setPhase({ phase: "review", content: phase.content });
        }}
        onSubmit={(feedback) => {
          void generate(feedback);
        }}
        placeholder="e.g. The retry work is not started yet; add the rate-limit question under Open questions (multi-line ok)"
      />
    );
  }

  if (phase.phase === "error") {
    return (
      <Box flexDirection="column">
        {log.length > 0 ? <RunLog log={log} /> : null}
        <Text color={theme.error}>Error: {phase.message}</Text>
        <SelectList
          isActive={isActive}
          key="handoff-error"
          items={[
            {
              id: "retry",
              label: "Retry",
              hint:
                phase.origin === "save"
                  ? `try writing ${HANDOFF_FILENAME} again`
                  : "run the generation again",
            },
            {
              id: "skip",
              label: "Skip",
              hint: "move on — the agent prompt is already exported",
            },
          ]}
          onCancel={() => {
            finish([`Could not write ${HANDOFF_FILENAME}: ${phase.message}`]);
          }}
          onSelect={(id) => {
            if (id !== "retry") {
              finish([`Could not write ${HANDOFF_FILENAME}: ${phase.message}`]);
              return;
            }

            if (phase.origin === "save" && phase.content !== null) {
              void save(phase.content);
            } else {
              void generate(null);
            }
          }}
          title={`The ${HANDOFF_FILENAME} step failed`}
        />
      </Box>
    );
  }

  return <Spinner label={`Saving ${HANDOFF_FILENAME}...`} />;
}
