import type { ReactNode } from "react";
import { Box, Text } from "ink";
import { visibleTail } from "./text-buffer.js";
import { theme } from "./theme.js";

type PanelProps = {
  /** Renders a hand-drawn titled top border (the main-menu style). */
  title?: string;
  /** Fixed box width; required for the titled top line to align. */
  width?: number;
  children?: ReactNode;
};

/**
 * The shared content frame: a round border in theme.border with one column
 * of horizontal padding. Replaces the near-identical bordered <Box> each
 * screen used to declare inline. With `title`, the top border is drawn by
 * hand (`╭─ Title ────╮` + borderTop={false}) — Ink borders cannot embed a
 * label.
 */
export function Panel({ title, width, children }: PanelProps) {
  if (title === undefined) {
    return (
      <Box
        borderColor={theme.border}
        borderStyle="round"
        flexDirection="column"
        paddingX={1}
        width={width}
      >
        {children}
      </Box>
    );
  }

  const lineWidth = width ?? title.length + 8;
  const heading = `─ ${title} `;
  const topLine = `╭${heading}${"─".repeat(Math.max(0, lineWidth - 2 - heading.length))}╮`;

  return (
    <Box flexDirection="column">
      <Text color={theme.border} wrap="truncate-end">
        {topLine}
      </Text>
      <Box
        borderColor={theme.border}
        borderStyle="round"
        borderTop={false}
        flexDirection="column"
        paddingX={1}
        width={lineWidth}
      >
        {children}
      </Box>
    </Box>
  );
}

type TailPanelProps = {
  text: string;
  /** Max text rows shown; older lines collapse into the hidden-count note. */
  maxRows: number;
  /** Appended to the "… N more lines above" note (e.g. how to see it all). */
  hiddenHint?: string;
  title?: string;
  width?: number;
};

/**
 * A Panel showing the tail of a block of text — the review/done frames'
 * shared shape: an optional "… N more lines above" note, then the last
 * `maxRows` lines.
 */
export function TailPanel({
  text,
  maxRows,
  hiddenHint = "",
  title,
  width,
}: TailPanelProps) {
  const { lines, hidden } = visibleTail(text, maxRows);

  return (
    <Panel title={title} width={width}>
      {hidden > 0 ? (
        <Text color={theme.dim}>
          … {hidden} more line{hidden === 1 ? "" : "s"} above{hiddenHint}
        </Text>
      ) : null}
      {lines.map((line, index) => (
        <Text key={index} wrap="wrap">
          {line.length > 0 ? line : " "}
        </Text>
      ))}
    </Panel>
  );
}
