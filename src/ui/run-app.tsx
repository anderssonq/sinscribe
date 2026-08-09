import { useEffect, useRef, useState } from "react";
import { Box, Text, useApp } from "ink";
import type { CommandSpec, GlobalFlags } from "../commands.js";
import { InitSetup, needsCredentialSetup } from "../credentials.js";
import { executeCommand, isAgenticCommand } from "../domain/execute.js";
import { AgentSetupFlow } from "./agent-setup.js";
import { AppShell } from "./app-shell.js";
import { DocsReviewFlow } from "./docs-review.js";
import { PrReviewFlow } from "./pr-review.js";
import { PromptReviewFlow } from "./prompt-review.js";
import { appendEvent, Header, RunLog, type LogItem } from "./run-view.js";
import { getErrorMessage, isDebugMode } from "./shared.js";
import { Spinner } from "./spinner.js";
import { theme } from "./theme.js";
import { useViewport } from "./viewport.js";

type RunAppProps = {
  command: CommandSpec;
  flags: GlobalFlags;
  /**
   * Receives the full generated document (docs review clamps its final
   * frame) so the host can re-print it after the app exits.
   */
  onResult?: (text: string) => void;
};

/** Runs a single command in the terminal UI, streaming agent activity. */
export function RunApp({ command, flags, onResult }: RunAppProps) {
  const app = useApp();
  const { contentRows } = useViewport();
  const [log, setLog] = useState<LogItem[]>([]);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [setupDone, setSetupDone] = useState(
    !needsCredentialSetup(flags.provider, flags.apiKey),
  );
  const nextId = useRef(1);
  const started = useRef(false);
  const showStream = isAgenticCommand(command);
  // pr runs the interactive review loop instead of the fire-once effect.
  const isPrReview = command.name === "pr";
  // prompt runs the same review loop, plus its own type/description steps.
  const isPromptReview = command.name === "prompt";
  // docs without --out runs the interactive export flow; --out keeps the
  // plain fire-once path (the file is written by runDocs itself).
  const isDocsReview = command.name === "docs" && command.out === null;
  // agent-setup is interactive by nature (it interviews the author); off a
  // TTY, executeCommand's print path runs it without the questions instead.
  const isAgentSetup = command.name === "agent-setup";

  useEffect(() => {
    if (
      !setupDone ||
      started.current ||
      isPrReview ||
      isPromptReview ||
      isDocsReview ||
      isAgentSetup
    ) {
      return;
    }

    started.current = true;
    executeCommand(command, flags, process.cwd(), {
      debug: isDebugMode(),
      onEvent: (event) => {
        if (!showStream && event.type !== "debug" && event.type !== "status") {
          return;
        }

        setLog((current) =>
          appendEvent(current, event, () => nextId.current++),
        );
      },
    })
      .then((text) => {
        setResult(text);
        process.exitCode = 0;
        app.exit();
      })
      .catch((runError: unknown) => {
        setError(getErrorMessage(runError));
        process.exitCode = 1;
        app.exit();
      });
  }, [
    app,
    command,
    flags,
    setupDone,
    showStream,
    isPrReview,
    isPromptReview,
    isDocsReview,
    isAgentSetup,
  ]);

  if (!setupDone) {
    return (
      <InitSetup
        onComplete={() => {
          setSetupDone(true);
        }}
        onError={(message) => {
          setError(message);
          process.exitCode = 1;
          app.exit();
        }}
        overrideProvider={flags.provider}
      />
    );
  }

  if (isPrReview) {
    return (
      <AppShell>
        <Header subtitle="PR description — review before approving" />
        <PrReviewFlow
          flags={flags}
          isActive
          onDone={(outcome) => {
            process.exitCode = outcome.status === "failed" ? 1 : 0;
            app.exit();
          }}
          spec={command}
        />
      </AppShell>
    );
  }

  if (isPromptReview) {
    return (
      <AppShell>
        <Header subtitle="Agent prompt — review before approving" />
        <PromptReviewFlow
          flags={flags}
          isActive
          onDone={(outcome) => {
            process.exitCode = outcome.status === "failed" ? 1 : 0;
            app.exit();
          }}
          spec={command}
        />
      </AppShell>
    );
  }

  if (isAgentSetup) {
    return (
      <AppShell>
        <Header subtitle="Set up project agents — analyze, answer, generate" />
        <AgentSetupFlow
          flags={flags}
          isActive
          onDone={(outcome) => {
            // No onResult re-print: RunApp is not alt-screen, and the done
            // frame is a short summary that is never clamped away.
            process.exitCode = outcome.status === "failed" ? 1 : 0;
            app.exit();
          }}
        />
      </AppShell>
    );
  }

  if (isDocsReview) {
    return (
      <AppShell>
        <Header subtitle="Project documentation — export when ready" />
        <DocsReviewFlow
          flags={flags}
          isActive
          onDone={(outcome) => {
            if (outcome.status === "completed") {
              onResult?.(
                [outcome.content, "", ...outcome.summary].join("\n").trimEnd(),
              );
            }

            process.exitCode = outcome.status === "failed" ? 1 : 0;
            app.exit();
          }}
        />
      </AppShell>
    );
  }

  return (
    <AppShell>
      <Header
        subtitle={
          result !== null || error !== null
            ? "Done"
            : `Running sinscribe ${command.name}...`
        }
      />
      {showStream || log.length > 0 ? (
        // Bounded: the log grows by a row per streamed chunk, and once the
        // frame reaches the terminal's height Ink clears and repaints the
        // whole screen for every chunk that follows.
        <RunLog
          log={log}
          maxRows={contentRows - 2}
          waiting={result === null && error === null}
        />
      ) : null}
      {result === null && error === null && !showStream ? (
        <Spinner label="Generating..." />
      ) : null}
      {result !== null && !showStream ? (
        <Box flexDirection="column" marginTop={1}>
          <Text wrap="wrap">{result}</Text>
        </Box>
      ) : null}
      {error !== null ? <Text color={theme.error}>Error: {error}</Text> : null}
    </AppShell>
  );
}
