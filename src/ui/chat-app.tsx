import { useEffect, useRef, useState } from "react";
import { Box, Text, useApp } from "ink";
import type { GlobalFlags } from "../commands.js";
import { InitSetup, needsCredentialSetup } from "../credentials.js";
import { executeCommand } from "../domain/execute.js";
import { createThreadId } from "../llm/agent.js";
import {
  caretSplit,
  handleEditingKey,
  insertAt,
  makeEditorState,
} from "./editor.js";
import { Panel } from "./panel.js";
import { appendEvent, Header, RunLog, type LogItem } from "./run-view.js";
import { getErrorMessage, isDebugMode } from "./shared.js";
import { Spinner } from "./spinner.js";
import { visibleRowWindow } from "./text-buffer.js";
import { theme } from "./theme.js";
import { useTextInput } from "./use-text-input.js";
import { computePromptRows, useViewport } from "./viewport.js";

/**
 * Rows the chat's own frame spends outside the history: the input box's two
 * borders, the one-row echo of the current message and its trailing margin,
 * the one-row error line, and the "… N earlier turns" note. All are forced to
 * one row by truncate-end so the budget below is exact.
 */
const INPUT_BORDER_ROWS = 2;
const MESSAGE_ROWS = 1;
const CURRENT_MARGIN_ROWS = 1;
const ERROR_ROWS = 1;
const DROPPED_ROWS = 1;
/** Floor for the streamed run log, so the input can never squeeze it out. */
const MIN_LOG_ROWS = 3;
/**
 * Ceiling on the input box. It grows with the terminal so a long message (or
 * a paste) is visible while it is written, but the history is what the rest of
 * the window is for — hence the third-of-the-viewport cap as well.
 */
const INPUT_MAX_ROWS = 8;

type ChatTurn = {
  id: number;
  message: string;
  log: LogItem[];
  error: string | null;
  done: boolean;
};

/**
 * The input value as pre-wrapped rows: "> " leads the first, the rest align
 * under it. Every row is emitted with the same child shape (Ink 5 miscounts a
 * <Text> whose middle child flips between a node and nothing), and rows
 * already fit the width — truncate-end only guards a double-width glyph the
 * code-point measure cannot see.
 */
function ChatInputRows({
  view,
}: {
  view: ReturnType<typeof visibleRowWindow>;
}) {
  return (
    <>
      {view.hiddenAbove > 0 ? (
        <Text color={theme.dim} wrap="truncate-end">
          … {view.hiddenAbove} more row{view.hiddenAbove === 1 ? "" : "s"} above
        </Text>
      ) : null}
      {view.rows.map((row, index) => {
        const split =
          index === view.cursorRow
            ? caretSplit(row, view.cursorCol)
            : { before: row === "" ? " " : row, at: "", after: "" };

        return (
          <Text key={index} wrap="truncate-end">
            <Text color={theme.accentAlt}>{index === 0 ? "> " : "  "}</Text>
            {split.before}
            <Text inverse>{split.at}</Text>
            {split.after}
          </Text>
        );
      })}
    </>
  );
}

/** Interactive chat session (bare `sinscribe`). */
export function ChatApp({
  flags,
  initialMessage,
  onExitToMenu,
}: {
  flags: GlobalFlags;
  initialMessage: string | null;
  /**
   * Set when chat was launched from the main menu: /exit hands control back
   * to the caller's menu loop instead of ending the process. Direct-entry
   * chat leaves it unset, so /exit keeps quitting the app.
   */
  onExitToMenu?: () => void;
}) {
  const app = useApp();
  const { columns, contentRows } = useViewport();
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState(() => makeEditorState(""));
  const [running, setRunning] = useState(false);
  const [setupDone, setSetupDone] = useState(
    !needsCredentialSetup(flags.provider, flags.apiKey),
  );
  const [fatal, setFatal] = useState<string | null>(null);
  const threadId = useRef(createThreadId(process.cwd()));
  const nextLogId = useRef(1);
  const nextTurnId = useRef(1);
  const startedInitial = useRef(false);
  // Scroll offset of the input's row window (see MultilinePrompt's startRef).
  const inputStart = useRef(Infinity);

  function submit(message: string) {
    const trimmed = message.trim();

    if (trimmed.length === 0 || running) {
      return;
    }

    if (trimmed === "/exit" || trimmed === "/quit") {
      process.exitCode = 0;
      onExitToMenu?.();
      app.exit();
      return;
    }

    if (trimmed === "/clear") {
      threadId.current = createThreadId(process.cwd());
      setTurns([]);
      setInput(makeEditorState(""));
      return;
    }

    const turnId = nextTurnId.current++;

    setTurns((current) => [
      ...current,
      { id: turnId, message: trimmed, log: [], error: null, done: false },
    ]);
    setInput(makeEditorState(""));
    setRunning(true);

    executeCommand(
      { name: "chat", message: trimmed },
      flags,
      process.cwd(),
      {
        debug: isDebugMode(),
        onEvent: (event) => {
          setTurns((current) =>
            current.map((turn) =>
              turn.id === turnId
                ? {
                    ...turn,
                    log: appendEvent(
                      turn.log,
                      event,
                      () => nextLogId.current++,
                    ),
                  }
                : turn,
            ),
          );
        },
      },
      threadId.current,
    )
      .then(() => {
        setTurns((current) =>
          current.map((turn) =>
            turn.id === turnId ? { ...turn, done: true } : turn,
          ),
        );
      })
      .catch((error: unknown) => {
        setTurns((current) =>
          current.map((turn) =>
            turn.id === turnId
              ? { ...turn, done: true, error: getErrorMessage(error) }
              : turn,
          ),
        );
      })
      .finally(() => {
        setRunning(false);
      });
  }

  useEffect(() => {
    if (setupDone && initialMessage && !startedInitial.current) {
      startedInitial.current = true;
      submit(initialMessage);
    }
    // submit is stable enough here; startedInitial guards re-entry.
  });

  useTextInput((value, key, pasted) => {
    if (!setupDone || running) {
      return;
    }

    if (key.return) {
      submit(input.text);
      return;
    }

    // Pasted text keeps its line breaks — what lands here is usually a spec or
    // a stack trace on its way to the model, and flattening it glued words
    // together. Typing enter still submits: the editor is only ever asked to
    // insert a newline by a paste.
    if (pasted) {
      setInput((current) => insertAt(current, value, true));
      return;
    }

    setInput(
      (current) =>
        handleEditingKey(current, value, key, { multiline: true }).state,
    );
  });

  if (fatal !== null) {
    return <Text color={theme.error}>Error: {fatal}</Text>;
  }

  if (!setupDone) {
    return (
      <InitSetup
        onComplete={() => {
          setSetupDone(true);
        }}
        onError={(message) => {
          setFatal(message);
          process.exitCode = 1;
          app.exit();
        }}
        overrideProvider={flags.provider}
      />
    );
  }

  // Window the input over VISUAL rows: a pasted block is one logical line of
  // thousands of characters, and rendering it whole grew the frame past the
  // terminal's height — the point where Ink stops diffing and clears the
  // screen on every render, which is what read as a freeze.
  const inputMax = computePromptRows(contentRows, 0, {
    min: 1,
    max: Math.min(INPUT_MAX_ROWS, Math.ceil(contentRows / 3)),
  });
  // Two borders, two columns of padding, the "> " prefix, and the caret cell.
  const inputWidth = Math.max(8, columns - 7);
  let inputView = visibleRowWindow(
    input.text,
    input.cursor,
    inputWidth,
    inputMax,
    inputStart.current,
  );

  // The "… N rows above" note costs a row of the same budget.
  if (inputView.hiddenAbove > 0 && inputMax > 1) {
    inputView = visibleRowWindow(
      input.text,
      input.cursor,
      inputWidth,
      inputMax - 1,
      inputStart.current,
    );
  }

  inputStart.current = inputView.start;

  const inputRows = running
    ? 1
    : inputView.rows.length + (inputView.hiddenAbove > 0 ? 1 : 0);

  // Window the history so the frame never outgrows the terminal: earlier turns
  // collapse to their "> message" line — capped to what fits, oldest dropped
  // first — and the latest turn's log gets whatever the input leaves.
  const historyRows = Math.max(
    MIN_LOG_ROWS + MESSAGE_ROWS + CURRENT_MARGIN_ROWS,
    contentRows - (inputRows + INPUT_BORDER_ROWS) - DROPPED_ROWS,
  );
  const allEarlier = turns.slice(0, -1);
  const current = turns.at(-1);
  const currentChrome =
    (current ? MESSAGE_ROWS + CURRENT_MARGIN_ROWS : 0) +
    (current?.error != null ? ERROR_ROWS : 0);
  const maxEarlier = Math.max(0, historyRows - currentChrome - MIN_LOG_ROWS);
  const earlier = allEarlier.slice(Math.max(0, allEarlier.length - maxEarlier));
  const droppedTurns = allEarlier.length - earlier.length;
  const currentLogRows = Math.max(
    MIN_LOG_ROWS,
    historyRows - earlier.length - currentChrome,
  );

  return (
    <Box flexDirection="column">
      <Header subtitle="Interactive session — /exit to quit, /clear for a new thread" />
      {droppedTurns > 0 ? (
        <Text color={theme.dim}>… {droppedTurns} earlier turns</Text>
      ) : null}
      {earlier.map((turn) => (
        <Text key={turn.id} wrap="truncate-end">
          <Text color={theme.accentAlt}>{"> "}</Text>
          {turn.message}
          <Text color={turn.error !== null ? theme.error : theme.dim}>
            {turn.error !== null ? "  ! error" : "  ✓"}
          </Text>
        </Text>
      ))}
      {current ? (
        <Box flexDirection="column" key={current.id} marginBottom={1}>
          <Text wrap="truncate-end">
            <Text color={theme.accentAlt}>{"> "}</Text>
            {current.message}
          </Text>
          <Box flexDirection="column" marginLeft={2}>
            <RunLog
              log={current.log}
              maxRows={currentLogRows}
              waiting={!current.done && current.error === null}
            />
            {current.error !== null ? (
              <Text color={theme.error} wrap="truncate-end">
                Error: {current.error}
              </Text>
            ) : null}
          </Box>
        </Box>
      ) : null}
      <Panel>
        {running ? (
          <Text wrap="truncate-end">
            <Text color={theme.accentAlt}>{">"}</Text>{" "}
            <Spinner label="Working..." />
          </Text>
        ) : input.text.length === 0 ? (
          <Text wrap="truncate-end">
            <Text color={theme.accentAlt}>{">"}</Text> <Text inverse> </Text>{" "}
            <Text color={theme.dim}>Ask about the repo, or /exit</Text>
          </Text>
        ) : (
          <ChatInputRows view={inputView} />
        )}
      </Panel>
    </Box>
  );
}
