import { useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import type { GlobalFlags } from "../commands.js";
import { InitSetup, needsCredentialSetup } from "../credentials.js";
import { executeCommand } from "../domain/execute.js";
import { createThreadId } from "../llm/agent.js";
import { appendEvent, Header, RunLog, type LogItem } from "./run-view.js";
import { getErrorMessage, isDebugMode } from "./shared.js";
import { Spinner } from "./spinner.js";
import { theme } from "./theme.js";

type ChatTurn = {
  id: number;
  message: string;
  log: LogItem[];
  error: string | null;
  done: boolean;
};

/** Interactive chat session (bare `sinscribe`). */
export function ChatApp({
  flags,
  initialMessage,
}: {
  flags: GlobalFlags;
  initialMessage: string | null;
}) {
  const app = useApp();
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [setupDone, setSetupDone] = useState(
    !needsCredentialSetup(flags.provider, flags.apiKey),
  );
  const [fatal, setFatal] = useState<string | null>(null);
  const threadId = useRef(createThreadId(process.cwd()));
  const nextLogId = useRef(1);
  const nextTurnId = useRef(1);
  const startedInitial = useRef(false);

  function submit(message: string) {
    const trimmed = message.trim();

    if (trimmed.length === 0 || running) {
      return;
    }

    if (trimmed === "/exit" || trimmed === "/quit") {
      process.exitCode = 0;
      app.exit();
      return;
    }

    if (trimmed === "/clear") {
      threadId.current = createThreadId(process.cwd());
      setTurns([]);
      setInput("");
      return;
    }

    const turnId = nextTurnId.current++;

    setTurns((current) => [
      ...current,
      { id: turnId, message: trimmed, log: [], error: null, done: false },
    ]);
    setInput("");
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

  useInput((value, key) => {
    if (!setupDone || running) {
      return;
    }

    if (key.return) {
      submit(input);
      return;
    }

    if (key.backspace || key.delete || value === "") {
      setInput((current) => current.slice(0, -1));
      return;
    }

    if (value && !key.ctrl && !key.meta) {
      setInput((current) => current + value.replace(/[\r\n]/gu, ""));
    }
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

  return (
    <Box flexDirection="column">
      <Header subtitle="Interactive session — /exit to quit, /clear for a new thread" />
      {turns.map((turn) => (
        <Box flexDirection="column" key={turn.id} marginBottom={1}>
          <Text>
            <Text color={theme.accentAlt}>{"> "}</Text>
            {turn.message}
          </Text>
          <Box flexDirection="column" marginLeft={2}>
            <RunLog
              log={turn.log}
              waiting={!turn.done && turn.error === null}
            />
            {turn.error !== null ? (
              <Text color={theme.error}>Error: {turn.error}</Text>
            ) : null}
          </Box>
        </Box>
      ))}
      <Box borderStyle="round" borderColor={theme.border} paddingX={1}>
        <Text>
          <Text color={theme.accentAlt}>{">"}</Text>{" "}
          {running ? (
            <Spinner label="Working..." />
          ) : input.length > 0 ? (
            input
          ) : (
            <Text color={theme.dim}>Ask about the repo, or /exit</Text>
          )}
        </Text>
      </Box>
    </Box>
  );
}
