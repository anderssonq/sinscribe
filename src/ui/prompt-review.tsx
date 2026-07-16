import { writeFile } from "node:fs/promises";
import { useEffect, useRef, useState } from "react";
import { Box, Text } from "ink";
import type { CommandSpec, GlobalFlags } from "../commands.js";
import {
  createPromptRun,
  type PromptKind,
  type PromptRun,
} from "../domain/prompt.js";
import {
  buildPromptExportMarkdown,
  getPromptExportPath,
  PROMPT_EXPORT_FILENAME,
} from "../domain/prompt-export.js";
import { copyToClipboard } from "../util/clipboard.js";
import { MultilinePrompt, ScrollView, SelectList } from "./menu-view.js";
import { Panel, TailPanel } from "./panel.js";
import {
  fileExists,
  isWarningLine,
  useReviewVisibleLines,
} from "./review-shared.js";
import { appendEvent, RunLog, type LogItem } from "./run-view.js";
import { getErrorMessage, isDebugMode } from "./shared.js";
import { Spinner } from "./spinner.js";
import { theme } from "./theme.js";

type PromptSpec = Extract<CommandSpec, { name: "prompt" }>;

export type PromptReviewOutcome =
  | { status: "approved"; content: string; summary: string[] }
  | { status: "cancelled" }
  | { status: "failed"; message: string };

type Phase =
  | { phase: "type-pick" }
  | { phase: "describe-input" }
  | { phase: "generating"; feedback: string | null; label: string }
  | { phase: "review"; content: string }
  | { phase: "view-full"; content: string }
  | { phase: "refine-input"; content: string }
  | {
      phase: "error";
      message: string;
      feedback: string | null;
      /** What Retry should redo: the generation, or the approve persistence. */
      origin: "generate" | "approve";
      content: string | null;
    }
  | { phase: "export-pick"; content: string }
  | { phase: "overwrite-confirm"; content: string; wantClipboard: boolean }
  | { phase: "exporting"; content: string }
  | { phase: "done"; content: string; summary: string[] };

/**
 * Rows this flow renders around the tail-clamped prompt during review: the
 * heading, panel borders, the hidden-count note, and the select list.
 * Passed to useReviewVisibleLines so the clamp adapts to terminal height.
 */
const REVIEW_EXTRA_ROWS = 12;

type PromptReviewFlowProps = {
  spec: PromptSpec;
  flags: GlobalFlags;
  isActive: boolean;
  onDone: (outcome: PromptReviewOutcome) => void;
};

/**
 * Interactive type-pick → describe → generate → review → refine → export
 * cycle for agent task prompts, shared by RunApp and MenuApp. The two leading
 * steps only render when --type/description were not already provided. Each
 * regeneration is one single-shot model call driven by createPromptRun;
 * nothing is persisted unless the user exports (or passed --out).
 */
export function PromptReviewFlow({
  spec,
  flags,
  isActive,
  onDone,
}: PromptReviewFlowProps) {
  const reviewRows = useReviewVisibleLines(REVIEW_EXTRA_ROWS);
  const [phase, setPhase] = useState<Phase>(
    spec.type === null
      ? { phase: "type-pick" }
      : spec.description === null
        ? { phase: "describe-input" }
        : {
            phase: "generating",
            feedback: null,
            label: "Generating agent prompt...",
          },
  );
  const [log, setLog] = useState<LogItem[]>([]);
  const runRef = useRef<PromptRun | null>(null);
  const kindRef = useRef<PromptKind | null>(spec.type);
  const descriptionRef = useRef<string | null>(spec.description);
  const cancelledRef = useRef(false);
  const startedRef = useRef(false);
  const doneRef = useRef(false);
  const approveNotesRef = useRef<string[]>([]);
  const nextLogId = useRef(1);

  function finish(outcome: PromptReviewOutcome): void {
    if (doneRef.current) {
      return;
    }

    doneRef.current = true;
    // Deferred a tick so the final frame (summary/prompt) renders before a
    // host like RunApp reacts with app.exit().
    setTimeout(() => {
      onDone(outcome);
    }, 0);
  }

  async function generate(feedback: string | null): Promise<void> {
    setLog([]);
    setPhase({
      phase: "generating",
      feedback,
      label:
        feedback !== null
          ? "Regenerating with your feedback..."
          : `Generating ${kindRef.current ?? "agent"} prompt...`,
    });

    try {
      runRef.current ??= await createPromptRun(
        { ...spec, type: kindRef.current, description: descriptionRef.current },
        flags,
        process.cwd(),
      );

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
        feedback,
        origin: "generate",
        content: null,
      });
    }
  }

  async function approve(content: string): Promise<void> {
    try {
      const { outPath } = await (runRef.current as PromptRun).approve();

      approveNotesRef.current = outPath
        ? [`Wrote agent prompt to ${outPath}`]
        : [];

      if (cancelledRef.current) {
        return;
      }

      setPhase({ phase: "export-pick", content });
    } catch (error) {
      if (cancelledRef.current) {
        return;
      }

      setPhase({
        phase: "error",
        message: getErrorMessage(error),
        feedback: null,
        origin: "approve",
        content,
      });
    }
  }

  async function handleExportChoice(
    choice: string,
    content: string,
  ): Promise<void> {
    const wantFile = choice === "both" || choice === "md";
    const wantClipboard = choice === "both" || choice === "clip";

    if (!wantFile && !wantClipboard) {
      completeExport(content, []);
      return;
    }

    if (wantFile) {
      const repoRoot = runRef.current?.meta.repoRoot ?? null;

      if (repoRoot === null) {
        await runExport(content, false, wantClipboard, [
          `Skipped ${PROMPT_EXPORT_FILENAME}: no repository root found.`,
        ]);
        return;
      }

      if (await fileExists(getPromptExportPath(repoRoot))) {
        setPhase({ phase: "overwrite-confirm", content, wantClipboard });
        return;
      }
    }

    await runExport(content, wantFile, wantClipboard, []);
  }

  async function runExport(
    content: string,
    wantFile: boolean,
    wantClipboard: boolean,
    notes: string[],
  ): Promise<void> {
    setPhase({ phase: "exporting", content });

    const summary = [...notes];
    const meta = (runRef.current as PromptRun).meta;

    if (wantFile && meta.repoRoot !== null) {
      const exportPath = getPromptExportPath(meta.repoRoot);

      try {
        await writeFile(
          exportPath,
          buildPromptExportMarkdown({
            kind: meta.kind,
            branch: meta.branch,
            ticket: meta.ticket,
            content,
          }),
          "utf8",
        );
        summary.push(`Saved ${exportPath}`);
      } catch (error) {
        summary.push(
          `Could not save ${PROMPT_EXPORT_FILENAME}: ${getErrorMessage(error)}`,
        );
      }
    }

    if (wantClipboard) {
      try {
        await copyToClipboard(content);
        summary.push("Copied to clipboard.");
      } catch (error) {
        summary.push(`Clipboard copy failed: ${getErrorMessage(error)}`);
      }
    }

    completeExport(content, summary);
  }

  function completeExport(content: string, summary: string[]): void {
    if (cancelledRef.current) {
      return;
    }

    const fullSummary = [...approveNotesRef.current, ...summary];

    setPhase({ phase: "done", content, summary: fullSummary });
    finish({ status: "approved", content, summary: fullSummary });
  }

  useEffect(() => {
    if (startedRef.current) {
      return;
    }

    startedRef.current = true;

    // Only auto-start when both leading questions were answered via flags;
    // otherwise the type-pick/describe-input phases drive the flow.
    if (spec.type !== null && spec.description !== null) {
      void generate(null);
    }

    return () => {
      cancelledRef.current = true;
    };
    // Mount-only: the flow drives itself through phase transitions.
  }, []);

  if (phase.phase === "type-pick") {
    return (
      <SelectList
        isActive={isActive}
        key="type-pick"
        items={[
          {
            id: "feature",
            label: "Feature",
            hint: "new capability or enhancement",
          },
          {
            id: "bugfix",
            label: "Bugfix",
            hint: "something is broken and needs fixing",
          },
        ]}
        onCancel={() => {
          finish({ status: "cancelled" });
        }}
        onSelect={(id) => {
          kindRef.current = id === "bugfix" ? "bugfix" : "feature";

          if (descriptionRef.current === null) {
            setPhase({ phase: "describe-input" });
          } else {
            void generate(null);
          }
        }}
        title="What kind of prompt do you need?"
      />
    );
  }

  if (phase.phase === "describe-input") {
    // The kind is always resolved before this step (flag or type-pick), and
    // a good bug description is shaped differently from a good feature one.
    const isBugfix = kindRef.current === "bugfix";

    return (
      <MultilinePrompt
        allowEmpty
        isActive={isActive}
        key={isBugfix ? "describe-bugfix" : "describe-feature"}
        label={
          isBugfix
            ? "Bug — what is broken? Include the symptom, the expected behavior, and how to reproduce it (empty = use the saved session context)"
            : "Feature — what should the agent build, and why? (empty = use the saved session context)"
        }
        onCancel={() => {
          if (spec.type === null) {
            setPhase({ phase: "type-pick" });
          } else {
            finish({ status: "cancelled" });
          }
        }}
        onSubmit={(description) => {
          // Empty submit = one-shot prompt for the whole task: the run falls
          // back to the saved session context (feature + requirements).
          descriptionRef.current =
            description.trim().length > 0 ? description : null;
          void generate(null);
        }}
        placeholder={
          isBugfix
            ? "e.g. Uploader crashes on empty files — expected a validation message instead; reproduces every time via drag & drop (multi-line ok, ctrl+d to submit)"
            : "e.g. Retry failed uploads up to 3 times with backoff; surface the final error in the UI (multi-line ok, ctrl+d to submit)"
        }
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
        <Text color={theme.accent}>Generated agent prompt</Text>
        <TailPanel
          hiddenHint=" — pick “View full” to scroll it all"
          maxRows={reviewRows}
          text={phase.content}
        />
        <SelectList
          isActive={isActive}
          key="review"
          items={[
            {
              id: "approve",
              label: "Approve",
              hint: "use this prompt",
            },
            {
              id: "modify",
              label: "Modify",
              hint: "describe what to change and regenerate",
            },
            {
              id: "view",
              label: "View full",
              hint: "scroll the entire prompt (j/k, wheel, esc back)",
            },
            {
              id: "cancel",
              label: "Cancel",
              hint: "discard and exit — nothing is saved",
            },
          ]}
          onCancel={() => {
            finish({ status: "cancelled" });
          }}
          onSelect={(id) => {
            if (id === "approve") {
              void approve(phase.content);
            } else if (id === "modify") {
              setPhase({ phase: "refine-input", content: phase.content });
            } else if (id === "view") {
              setPhase({ phase: "view-full", content: phase.content });
            } else {
              finish({ status: "cancelled" });
            }
          }}
          title="Does this look good?"
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
        title="Generated agent prompt — full text"
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
        placeholder="e.g. Name the uploader module; add a rollout constraint; tighten the scope (multi-line ok)"
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
          key="error"
          items={[
            {
              id: "retry",
              label: "Retry",
              hint:
                phase.origin === "approve"
                  ? "try saving the approved prompt again"
                  : "run the generation again",
            },
            {
              id: "cancel",
              label: "Cancel",
              hint: "give up and exit",
            },
          ]}
          onCancel={() => {
            finish({ status: "failed", message: phase.message });
          }}
          onSelect={(id) => {
            if (id !== "retry") {
              finish({ status: "failed", message: phase.message });
              return;
            }

            if (phase.origin === "approve" && phase.content !== null) {
              void approve(phase.content);
            } else {
              void generate(phase.feedback);
            }
          }}
          title="The request failed"
        />
      </Box>
    );
  }

  if (phase.phase === "export-pick") {
    return (
      <SelectList
        isActive={isActive}
        key="export-pick"
        items={[
          {
            id: "both",
            label: `Save ${PROMPT_EXPORT_FILENAME} + copy`,
            hint: "write the file at the repo root and copy to the clipboard",
          },
          {
            id: "md",
            label: `Save ${PROMPT_EXPORT_FILENAME}`,
            hint: "write the file at the repo root",
          },
          {
            id: "clip",
            label: "Copy to clipboard",
            hint: "copy the prompt without writing a file",
          },
          {
            id: "skip",
            label: "Skip",
            hint: "discard — nothing is written",
          },
        ]}
        onCancel={() => {
          completeExport(phase.content, []);
        }}
        onSelect={(choice) => {
          void handleExportChoice(choice, phase.content);
        }}
        title="Approved — export the prompt?"
      />
    );
  }

  if (phase.phase === "overwrite-confirm") {
    return (
      <SelectList
        isActive={isActive}
        key="overwrite-confirm"
        items={[
          {
            id: "overwrite",
            label: "Overwrite",
            hint: "replace the existing file",
          },
          {
            id: "skip-file",
            label: "Skip the file",
            hint: phase.wantClipboard
              ? "keep the existing file; still copy to the clipboard"
              : "keep the existing file",
          },
        ]}
        onCancel={() => {
          void runExport(phase.content, false, phase.wantClipboard, [
            `Kept the existing ${PROMPT_EXPORT_FILENAME}.`,
          ]);
        }}
        onSelect={(choice) => {
          if (choice === "overwrite") {
            void runExport(phase.content, true, phase.wantClipboard, []);
          } else {
            void runExport(phase.content, false, phase.wantClipboard, [
              `Kept the existing ${PROMPT_EXPORT_FILENAME}.`,
            ]);
          }
        }}
        title={`${PROMPT_EXPORT_FILENAME} already exists — overwrite?`}
      />
    );
  }

  if (phase.phase === "exporting") {
    return <Spinner label="Exporting..." />;
  }

  return (
    <Box flexDirection="column">
      <Text color={theme.accent}>Approved agent prompt</Text>
      <Panel>
        <Text wrap="wrap">{phase.content}</Text>
      </Panel>
      {phase.summary.map((line, index) =>
        isWarningLine(line) ? (
          <Text color={theme.accent} key={index}>
            ! {line}
          </Text>
        ) : (
          <Text color={theme.ok} key={index}>
            ✓ {line}
          </Text>
        ),
      )}
    </Box>
  );
}
