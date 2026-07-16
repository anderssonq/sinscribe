import { Box, Text } from "ink";
import {
  CLI_DISPLAY_NAME,
  SINSCRIBE_MODEL_ID_ENV_KEY,
  SINSCRIBE_VERSION,
  getDefaultModelId,
  getProviderLabel,
  resolveConfiguredProvider,
} from "../constants.js";
import type { ShortStat } from "../git/diff.js";
import type { RunEvent } from "../llm/events.js";
import { BRAND_TAGLINE } from "./branding.js";
import { Spinner } from "./spinner.js";
import { visibleTail, wrapLines } from "./text-buffer.js";
import { theme } from "./theme.js";
import { useTerminalSize } from "./viewport.js";

/** Git change figures shown in the header (menu view only). */
export type HeaderStats = {
  worktree: ShortStat | null;
  range: ShortStat | null;
};

export type LogItem = {
  id: number;
  type: "text" | "tool" | "status" | "debug";
  content: string;
  status?: "running" | "done" | "error";
};

/** Folds a stream event into the display log (openwiki's RunLogItem pattern). */
export function appendEvent(
  log: LogItem[],
  event: RunEvent,
  nextId: () => number,
): LogItem[] {
  if (event.type === "text") {
    const last = log.at(-1);

    if (last && last.type === "text") {
      return [
        ...log.slice(0, -1),
        { ...last, content: last.content + event.text },
      ];
    }

    return [...log, { id: nextId(), type: "text", content: event.text }];
  }

  if (event.type === "tool_start") {
    return [
      ...log,
      {
        id: nextId(),
        type: "tool",
        content: event.call,
        status: "running",
      },
    ];
  }

  if (event.type === "tool_end") {
    let updated = false;

    const next = log.map((item) => {
      if (!updated && item.type === "tool" && item.status === "running") {
        updated = true;

        return {
          ...item,
          status:
            event.status === "error" ? ("error" as const) : ("done" as const),
        };
      }

      return item;
    });

    return next;
  }

  if (event.type === "status") {
    const last = log.at(-1);

    // Consecutive statuses ("attempt 2/3" then "attempt 3/3") update in place.
    if (last && last.type === "status") {
      return [...log.slice(0, -1), { ...last, content: event.message }];
    }

    return [...log, { id: nextId(), type: "status", content: event.message }];
  }

  return [...log, { id: nextId(), type: "debug", content: event.message }];
}

export function Header({
  subtitle,
  branch,
  stats,
}: {
  subtitle?: string;
  branch?: string | null;
  stats?: HeaderStats;
}) {
  const provider = resolveConfiguredProvider();
  const modelId =
    process.env[SINSCRIBE_MODEL_ID_ENV_KEY]?.trim() ||
    getDefaultModelId(provider);
  // One figure: uncommitted worktree changes when present, else vs-base.
  const stat = stats ? (stats.worktree ?? stats.range) : null;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text bold color={theme.accent}>
          {CLI_DISPLAY_NAME}
        </Text>
        <Text color={theme.dim}>
          {" "}
          v{SINSCRIBE_VERSION} · {BRAND_TAGLINE}
        </Text>
      </Text>
      {/*
       * Stable child list: absent segments render "" — never null — because
       * toggling a middle child of a <Text> between null and a node corrupts
       * Ink 5's re-render reconciliation (see menu-view.tsx), and branch and
       * stats flip live on the menu's 2 s git poll.
       */}
      <Text wrap="truncate-end">
        <Text color={theme.dim}>{"⬢ "}</Text>
        <Text color={theme.body}>{getProviderLabel(provider)}</Text>
        <Text color={theme.dim}>{" · "}</Text>
        <Text color={theme.body}>{modelId}</Text>
        <Text color={theme.dim}>{branch ? " · ⎇ " : ""}</Text>
        <Text color={theme.body}>{branch ?? ""}</Text>
        <Text color={theme.dim}>{stat ? " · " : ""}</Text>
        <Text color={theme.ok}>{stat ? `+${stat.insertions}` : ""}</Text>
        <Text color={theme.error}>{stat ? ` -${stat.deletions}` : ""}</Text>
        <Text color={theme.dim}>
          {stat
            ? ` (${stat.files} ${stat.files === 1 ? "file" : "files"})`
            : ""}
        </Text>
      </Text>
      <Text color={theme.faint} wrap="truncate-end">
        {process.cwd()}
      </Text>
      {subtitle ? <Text color={theme.accent}>{subtitle}</Text> : null}
    </Box>
  );
}

/**
 * Bottom-anchored window over a log: the newest items that fit `maxRows`
 * visual rows (text items cost their wrapped row count; tool/status/debug
 * lines cost one). The oldest surviving text item is tail-trimmed when it
 * straddles the budget. Pure, so extreme sizes are unit-testable.
 */
export function tailWindowLog(
  log: LogItem[],
  columns: number,
  maxRows: number,
): { items: LogItem[]; hiddenRows: number } {
  const width = Math.max(20, columns - 2);
  const items: LogItem[] = [];
  let budget = Math.max(1, maxRows);
  let hiddenRows = 0;

  for (let index = log.length - 1; index >= 0; index--) {
    const item = log[index];
    const wrapped =
      item.type === "text" ? wrapLines(item.content, width) : null;
    const rows = wrapped === null ? 1 : wrapped.length;

    if (budget === 0) {
      hiddenRows += rows;
      continue;
    }

    if (rows <= budget) {
      items.unshift(item);
      budget -= rows;
      continue;
    }

    // Only a text item can straddle the budget (non-text costs exactly one
    // row, which always fits a budget ≥ 1). Keep its last `budget` wrapped
    // rows — already ≤ width, so joining with newlines cannot re-wrap.
    if (wrapped !== null) {
      const { lines, hidden } = visibleTail(wrapped.join("\n"), budget);

      items.unshift({ ...item, content: lines.join("\n") });
      hiddenRows += hidden;
    }

    budget = 0;
  }

  return { items, hiddenRows };
}

export function RunLog({
  log,
  waiting = false,
  maxRows,
}: {
  log: LogItem[];
  /** Animates the empty state while a run is still in flight. */
  waiting?: boolean;
  /** Bounds the log to this many visual rows (alt-screen residue guard). */
  maxRows?: number;
}) {
  const { columns } = useTerminalSize();

  if (log.length === 0) {
    return waiting ? (
      <Spinner label="Waiting for model output..." />
    ) : (
      <Text color={theme.dim}>Waiting for model output...</Text>
    );
  }

  let windowed =
    maxRows === undefined
      ? { items: log, hiddenRows: 0 }
      : tailWindowLog(log, columns, maxRows);

  // The "… N earlier lines" indicator occupies a row of its own; when it
  // will render, re-window with one less row so the total stays in budget.
  if (maxRows !== undefined && maxRows > 1 && windowed.hiddenRows > 0) {
    windowed = tailWindowLog(log, columns, maxRows - 1);
  }

  return (
    <Box flexDirection="column">
      {windowed.hiddenRows > 0 ? (
        <Text color={theme.dim}>… {windowed.hiddenRows} earlier lines</Text>
      ) : null}
      {windowed.items.map((item) => (
        <LogLine item={item} key={item.id} />
      ))}
    </Box>
  );
}

function LogLine({ item }: { item: LogItem }) {
  if (item.type === "tool") {
    const color =
      item.status === "error"
        ? theme.error
        : item.status === "running"
          ? theme.accent
          : theme.dim;

    return (
      <Text>
        <Text color={color}>
          {item.status === "running"
            ? "~ "
            : item.status === "error"
              ? "! "
              : "* "}
        </Text>
        <Text color={color}>{item.content}</Text>
      </Text>
    );
  }

  if (item.type === "status") {
    return <Text color={theme.dim}>~ {item.content}</Text>;
  }

  if (item.type === "debug") {
    return <Text color={theme.dim}>- {item.content}</Text>;
  }

  return <Text wrap="wrap">{item.content}</Text>;
}
