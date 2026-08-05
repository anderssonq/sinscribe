import { writeFile } from "node:fs/promises";
import { useEffect, useRef, useState } from "react";
import { Box, Text } from "ink";
import type { GlobalFlags } from "../commands.js";
import { runDocs } from "../domain/docs.js";
import {
  buildDocsExportMarkdown,
  DOCS_EXPORT_FILENAME,
  getDocsExportPath,
} from "../domain/docs-export.js";
import { getRepoRoot } from "../git/repo.js";
import { copyToClipboard } from "../util/clipboard.js";
import { SelectList } from "./menu-view.js";
import { TailPanel } from "./panel.js";
import {
  fileExists,
  isWarningLine,
  useReviewLogRows,
  useReviewPreviewRows,
} from "./review-shared.js";
import { appendEvent, RunLog, type LogItem } from "./run-view.js";
import { getErrorMessage, isDebugMode } from "./shared.js";
import { Spinner } from "./spinner.js";
import { theme } from "./theme.js";

export type DocsReviewOutcome =
  | { status: "completed"; content: string; summary: string[] }
  | { status: "cancelled" }
  | { status: "failed"; message: string };

type Phase =
  | { phase: "generating" }
  | { phase: "error"; message: string }
  | { phase: "export-pick"; content: string }
  | { phase: "overwrite-confirm"; content: string; wantClipboard: boolean }
  | { phase: "exporting"; content: string }
  | { phase: "done"; content: string; summary: string[] };

/**
 * Rows this flow renders around the tail-clamped document on the final
 * screen: the heading, panel borders, the hidden-count note, and the
 * summary lines. Passed to useReviewPreviewRows so the clamp adapts to
 * terminal height, and the panel is dropped entirely when there is no room.
 */
const DONE_EXTRA_ROWS = 8;

type DocsReviewFlowProps = {
  flags: GlobalFlags;
  isActive: boolean;
  onDone: (outcome: DocsReviewOutcome) => void;
};

/**
 * Generate → export flow for project documentation (a lighter PrReviewFlow:
 * no approve/refine cycle). Generation streams the agent's tool activity
 * live; on success the user picks how to export the markdown.
 */
export function DocsReviewFlow({
  flags,
  isActive,
  onDone,
}: DocsReviewFlowProps) {
  const doneRows = useReviewPreviewRows(DONE_EXTRA_ROWS);
  const logRows = useReviewLogRows(DONE_EXTRA_ROWS);
  const [phase, setPhase] = useState<Phase>({ phase: "generating" });
  const [log, setLog] = useState<LogItem[]>([]);
  const cancelledRef = useRef(false);
  const startedRef = useRef(false);
  const doneRef = useRef(false);
  const nextLogId = useRef(1);

  function finish(outcome: DocsReviewOutcome): void {
    if (doneRef.current) {
      return;
    }

    doneRef.current = true;
    // Deferred a tick so the final frame renders before a host reacts
    // with app.exit() (same pattern as PrReviewFlow).
    setTimeout(() => {
      onDone(outcome);
    }, 0);
  }

  async function generate(): Promise<void> {
    setLog([]);
    setPhase({ phase: "generating" });

    try {
      const content = await runDocs(
        { name: "docs", out: null },
        flags,
        process.cwd(),
        {
          debug: isDebugMode(),
          onEvent: (event) => {
            setLog((current) =>
              appendEvent(current, event, () => nextLogId.current++),
            );
          },
        },
      );

      if (cancelledRef.current) {
        return;
      }

      setPhase({ phase: "export-pick", content });
    } catch (error) {
      if (cancelledRef.current) {
        return;
      }

      setPhase({ phase: "error", message: getErrorMessage(error) });
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
      const repoRoot = await getRepoRoot(process.cwd());

      if (repoRoot === null) {
        await runExport(content, false, wantClipboard, [
          `Skipped ${DOCS_EXPORT_FILENAME}: no repository root found.`,
        ]);
        return;
      }

      if (await fileExists(getDocsExportPath(repoRoot))) {
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

    if (wantFile) {
      const repoRoot = await getRepoRoot(process.cwd());

      if (repoRoot === null) {
        summary.push(`Skipped ${DOCS_EXPORT_FILENAME}: no repository root.`);
      } else {
        const exportPath = getDocsExportPath(repoRoot);

        try {
          await writeFile(
            exportPath,
            buildDocsExportMarkdown({ content }),
            "utf8",
          );
          summary.push(`Saved ${exportPath}`);
        } catch (error) {
          summary.push(
            `Could not save ${DOCS_EXPORT_FILENAME}: ${getErrorMessage(error)}`,
          );
        }
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

    setPhase({ phase: "done", content, summary });
    finish({ status: "completed", content, summary });
  }

  useEffect(() => {
    if (startedRef.current) {
      return;
    }

    startedRef.current = true;
    void generate();

    return () => {
      cancelledRef.current = true;
    };
    // Mount-only: the flow drives itself through phase transitions.
  }, []);

  if (phase.phase === "generating") {
    return (
      <Box flexDirection="column">
        {/* Bounded: the log grows by a row per streamed chunk, and a frame
            that reaches the terminal's height makes Ink clear and repaint the
            whole screen for every chunk after that. */}
        <RunLog log={log} maxRows={logRows} waiting />
      </Box>
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
              hint: "run the documentation generation again",
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
            if (id === "retry") {
              void generate();
            } else {
              finish({ status: "failed", message: phase.message });
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
            label: `Save ${DOCS_EXPORT_FILENAME} + copy`,
            hint: "write the file at the repo root and copy to the clipboard",
          },
          {
            id: "md",
            label: `Save ${DOCS_EXPORT_FILENAME}`,
            hint: "write the file at the repo root",
          },
          {
            id: "clip",
            label: "Copy to clipboard",
            hint: "copy the documentation without writing a file",
          },
          {
            id: "skip",
            label: "Skip",
            hint: "just show the documentation without exporting",
          },
        ]}
        onCancel={() => {
          completeExport(phase.content, []);
        }}
        onSelect={(choice) => {
          void handleExportChoice(choice, phase.content);
        }}
        title="Documentation generated — export the markdown?"
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
            `Kept the existing ${DOCS_EXPORT_FILENAME}.`,
          ]);
        }}
        onSelect={(choice) => {
          if (choice === "overwrite") {
            void runExport(phase.content, true, phase.wantClipboard, []);
          } else {
            void runExport(phase.content, false, phase.wantClipboard, [
              `Kept the existing ${DOCS_EXPORT_FILENAME}.`,
            ]);
          }
        }}
        title={`${DOCS_EXPORT_FILENAME} already exists — overwrite?`}
      />
    );
  }

  if (phase.phase === "exporting") {
    return <Spinner label="Exporting..." />;
  }

  return (
    <Box flexDirection="column">
      <Text color={theme.accent}>Project documentation</Text>
      {doneRows !== null ? (
        <TailPanel
          hiddenHint=" (the full document is printed after exiting)"
          maxRows={doneRows}
          text={phase.content}
        />
      ) : (
        <Text dimColor>The full document is printed after exiting.</Text>
      )}
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
