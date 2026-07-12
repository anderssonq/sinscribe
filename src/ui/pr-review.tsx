import { access, writeFile } from "node:fs/promises";
import { useEffect, useRef, useState } from "react";
import { Box, Text } from "ink";
import type { CommandSpec, GlobalFlags } from "../commands.js";
import { createPrRun, type PrRun } from "../domain/pr.js";
import {
  buildPrExportMarkdown,
  getPrExportPath,
  PR_EXPORT_FILENAME,
} from "../domain/pr-export.js";
import { copyToClipboard } from "../util/clipboard.js";
import { MultilinePrompt, ScrollView, SelectList } from "./menu-view.js";
import { appendEvent, RunLog, type LogItem } from "./run-view.js";
import { getErrorMessage, isDebugMode } from "./shared.js";
import { Spinner } from "./spinner.js";
import { visibleTail } from "./text-buffer.js";
import { theme } from "./theme.js";

type PrSpec = Extract<CommandSpec, { name: "pr" }>;

export type PrReviewOutcome =
  | { status: "approved"; description: string; summary: string[] }
  | { status: "cancelled" }
  | { status: "failed"; message: string };

type Phase =
  | { phase: "generating"; feedback: string | null; label: string }
  | { phase: "review"; description: string }
  | { phase: "view-full"; description: string }
  | { phase: "refine-input"; description: string }
  | {
      phase: "error";
      message: string;
      feedback: string | null;
      /** What Retry should redo: the generation, or the approve persistence. */
      origin: "generate" | "approve";
      description: string | null;
    }
  | { phase: "export-pick"; description: string }
  | { phase: "overwrite-confirm"; description: string; wantClipboard: boolean }
  | { phase: "exporting"; description: string }
  | { phase: "done"; description: string; summary: string[] };

/** Lines of the candidate description shown during review (tail-clamped). */
const REVIEW_VISIBLE_LINES = 16;

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Export steps report failures as summary lines instead of aborting. */
function isWarningLine(line: string): boolean {
  return /failed|could not|skipped/iu.test(line);
}

type PrReviewFlowProps = {
  spec: PrSpec;
  flags: GlobalFlags;
  isActive: boolean;
  onDone: (outcome: PrReviewOutcome) => void;
};

/**
 * Interactive generate → review → refine → approve → export cycle for PR
 * descriptions, shared by RunApp and MenuApp. Each regeneration is one
 * single-shot model call driven by createPrRun; the session is only
 * persisted when the user approves.
 */
export function PrReviewFlow({
  spec,
  flags,
  isActive,
  onDone,
}: PrReviewFlowProps) {
  const [phase, setPhase] = useState<Phase>({
    phase: "generating",
    feedback: null,
    label: "Generating PR description...",
  });
  const [log, setLog] = useState<LogItem[]>([]);
  const runRef = useRef<PrRun | null>(null);
  const cancelledRef = useRef(false);
  const startedRef = useRef(false);
  const doneRef = useRef(false);
  const approveNotesRef = useRef<string[]>([]);
  const nextLogId = useRef(1);

  function finish(outcome: PrReviewOutcome): void {
    if (doneRef.current) {
      return;
    }

    doneRef.current = true;
    // Deferred a tick so the final frame (summary/description) renders
    // before a host like RunApp reacts with app.exit().
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
          : runRef.current?.meta.updating
            ? "Updating PR description..."
            : "Generating PR description...",
    });

    try {
      runRef.current ??= await createPrRun(spec, flags, process.cwd());

      const description = await runRef.current.generate(feedback, {
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

      setPhase({ phase: "review", description });
    } catch (error) {
      if (cancelledRef.current) {
        return;
      }

      setPhase({
        phase: "error",
        message: getErrorMessage(error),
        feedback,
        origin: "generate",
        description: null,
      });
    }
  }

  async function approve(description: string): Promise<void> {
    try {
      const { outPath } = await (runRef.current as PrRun).approve();

      approveNotesRef.current = outPath
        ? [`Wrote PR description to ${outPath}`]
        : [];

      if (cancelledRef.current) {
        return;
      }

      setPhase({ phase: "export-pick", description });
    } catch (error) {
      if (cancelledRef.current) {
        return;
      }

      setPhase({
        phase: "error",
        message: getErrorMessage(error),
        feedback: null,
        origin: "approve",
        description,
      });
    }
  }

  async function handleExportChoice(
    choice: string,
    description: string,
  ): Promise<void> {
    const wantFile = choice === "both" || choice === "md";
    const wantClipboard = choice === "both" || choice === "clip";

    if (!wantFile && !wantClipboard) {
      completeExport(description, []);
      return;
    }

    if (wantFile) {
      const repoRoot = runRef.current?.meta.repoRoot ?? null;

      if (repoRoot === null) {
        await runExport(description, false, wantClipboard, [
          `Skipped ${PR_EXPORT_FILENAME}: no repository root found.`,
        ]);
        return;
      }

      if (await fileExists(getPrExportPath(repoRoot))) {
        setPhase({ phase: "overwrite-confirm", description, wantClipboard });
        return;
      }
    }

    await runExport(description, wantFile, wantClipboard, []);
  }

  async function runExport(
    description: string,
    wantFile: boolean,
    wantClipboard: boolean,
    notes: string[],
  ): Promise<void> {
    setPhase({ phase: "exporting", description });

    const summary = [...notes];
    const meta = (runRef.current as PrRun).meta;

    if (wantFile && meta.repoRoot !== null) {
      const exportPath = getPrExportPath(meta.repoRoot);

      try {
        await writeFile(
          exportPath,
          buildPrExportMarkdown({
            branch: meta.branch,
            baseRef: meta.baseRef,
            ticket: meta.ticket,
            templateName: meta.templateName,
            description,
          }),
          "utf8",
        );
        summary.push(`Saved ${exportPath}`);
      } catch (error) {
        summary.push(
          `Could not save ${PR_EXPORT_FILENAME}: ${getErrorMessage(error)}`,
        );
      }
    }

    if (wantClipboard) {
      try {
        await copyToClipboard(description);
        summary.push("Copied to clipboard.");
      } catch (error) {
        summary.push(`Clipboard copy failed: ${getErrorMessage(error)}`);
      }
    }

    completeExport(description, summary);
  }

  function completeExport(description: string, summary: string[]): void {
    if (cancelledRef.current) {
      return;
    }

    const fullSummary = [...approveNotesRef.current, ...summary];

    setPhase({ phase: "done", description, summary: fullSummary });
    finish({ status: "approved", description, summary: fullSummary });
  }

  useEffect(() => {
    if (startedRef.current) {
      return;
    }

    startedRef.current = true;
    void generate(null);

    return () => {
      cancelledRef.current = true;
    };
    // Mount-only: the flow drives itself through phase transitions.
  }, []);

  if (phase.phase === "generating") {
    return (
      <Box flexDirection="column">
        {log.length > 0 ? <RunLog log={log} /> : null}
        <Spinner label={phase.label} />
      </Box>
    );
  }

  if (phase.phase === "review") {
    const { lines, hidden } = visibleTail(
      phase.description,
      REVIEW_VISIBLE_LINES,
    );

    return (
      <Box flexDirection="column">
        <Text color={theme.accent}>Generated PR description</Text>
        <Box
          borderColor={theme.border}
          borderStyle="round"
          flexDirection="column"
          paddingX={1}
        >
          {hidden > 0 ? (
            <Text color={theme.dim}>
              … {hidden} more line{hidden === 1 ? "" : "s"} above — pick “View
              full” to scroll it all
            </Text>
          ) : null}
          {lines.map((line, index) => (
            <Text key={index} wrap="wrap">
              {line.length > 0 ? line : " "}
            </Text>
          ))}
        </Box>
        <SelectList
          isActive={isActive}
          key="review"
          items={[
            {
              id: "approve",
              label: "Approve",
              hint: "use this description",
            },
            {
              id: "modify",
              label: "Modify",
              hint: "describe what to change and regenerate",
            },
            {
              id: "view",
              label: "View full",
              hint: "scroll the entire description (j/k, wheel, esc back)",
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
              void approve(phase.description);
            } else if (id === "modify") {
              setPhase({
                phase: "refine-input",
                description: phase.description,
              });
            } else if (id === "view") {
              setPhase({ phase: "view-full", description: phase.description });
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
          setPhase({ phase: "review", description: phase.description });
        }}
        text={phase.description}
        title="Generated PR description — full text"
      />
    );
  }

  if (phase.phase === "refine-input") {
    return (
      <MultilinePrompt
        isActive={isActive}
        label="What should change?"
        onCancel={() => {
          setPhase({ phase: "review", description: phase.description });
        }}
        onSubmit={(feedback) => {
          void generate(feedback);
        }}
        placeholder="e.g. Shorten the summary; mention the migration script; bullet the risks (multi-line ok)"
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
                  ? "try saving the approved description again"
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

            if (phase.origin === "approve" && phase.description !== null) {
              void approve(phase.description);
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
            label: `Save ${PR_EXPORT_FILENAME} + copy`,
            hint: "write the file at the repo root and copy to the clipboard",
          },
          {
            id: "md",
            label: `Save ${PR_EXPORT_FILENAME}`,
            hint: "write the file at the repo root",
          },
          {
            id: "clip",
            label: "Copy to clipboard",
            hint: "copy the description without writing a file",
          },
          {
            id: "skip",
            label: "Skip",
            hint: "the description is already saved in the session",
          },
        ]}
        onCancel={() => {
          completeExport(phase.description, []);
        }}
        onSelect={(choice) => {
          void handleExportChoice(choice, phase.description);
        }}
        title="Approved — export the description?"
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
          void runExport(phase.description, false, phase.wantClipboard, [
            `Kept the existing ${PR_EXPORT_FILENAME}.`,
          ]);
        }}
        onSelect={(choice) => {
          if (choice === "overwrite") {
            void runExport(phase.description, true, phase.wantClipboard, []);
          } else {
            void runExport(phase.description, false, phase.wantClipboard, [
              `Kept the existing ${PR_EXPORT_FILENAME}.`,
            ]);
          }
        }}
        title={`${PR_EXPORT_FILENAME} already exists — overwrite?`}
      />
    );
  }

  if (phase.phase === "exporting") {
    return <Spinner label="Exporting..." />;
  }

  return (
    <Box flexDirection="column">
      <Text color={theme.accent}>Approved PR description</Text>
      <Box
        borderColor={theme.border}
        borderStyle="round"
        flexDirection="column"
        paddingX={1}
      >
        <Text wrap="wrap">{phase.description}</Text>
      </Box>
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
