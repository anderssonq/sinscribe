import { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { useOnWheel } from "./mouse.js";
import { wrapLines } from "./text-buffer.js";
import { theme } from "./theme.js";
import { useViewport } from "./viewport.js";

/** Rows this view adds around its window beyond the shared logo/header
 * chrome (already in useViewport's contentRows): its two status lines and a
 * one-row cushion. */
const HELP_EXTRA_ROWS = 3;

/** Wheel notches move a few rows at a time; keys move one row / one page. */
const WHEEL_STEP = 3;

/**
 * Scrollable help viewport. The full help text is pre-wrapped to the terminal
 * width so every row is exactly one visual line, then windowed to the rows that
 * fit under the logo/header. Arrow keys and the wheel scroll one row, PageUp/
 * PageDown a page, g/G jump to the ends, and esc/q returns to the menu.
 */
export function HelpView({
  text,
  onExit,
}: {
  text: string;
  onExit: () => void;
}) {
  const { contentColumns, contentRows } = useViewport();
  const [offset, setOffset] = useState(0);

  const width = Math.max(20, contentColumns - 2);
  const lines = useMemo(() => wrapLines(text, width), [text, width]);

  const visible = Math.max(4, contentRows - HELP_EXTRA_ROWS);

  const maxOffset = Math.max(0, lines.length - visible);
  const clamped = Math.min(offset, maxOffset);
  const window = lines.slice(clamped, clamped + visible);
  const above = clamped;
  const below = Math.max(0, lines.length - (clamped + visible));

  function scrollBy(delta: number) {
    setOffset((current) => Math.min(maxOffset, Math.max(0, current + delta)));
  }

  useInput((value, key) => {
    if (key.escape || value === "q") {
      onExit();
      return;
    }

    if (key.upArrow || value === "k") {
      scrollBy(-1);
      return;
    }

    if (key.downArrow || value === "j") {
      scrollBy(1);
      return;
    }

    if (key.pageUp || value === "b") {
      scrollBy(-visible);
      return;
    }

    if (key.pageDown || value === "f" || value === " ") {
      scrollBy(visible);
      return;
    }

    if (value === "g") {
      setOffset(0);
      return;
    }

    if (value === "G") {
      setOffset(maxOffset);
    }
  });

  useOnWheel((direction) => {
    scrollBy(direction === "up" ? -WHEEL_STEP : WHEEL_STEP);
  });

  return (
    <Box flexDirection="column">
      <Text color={theme.dim}>
        {above > 0
          ? `↑ ${above} more line${above === 1 ? "" : "s"} above`
          : " "}
      </Text>
      <Box flexDirection="column">
        {window.map((line, index) => (
          // Pre-wrapped rows already fit; truncate-end guards any off-by-one so
          // each row stays a single visual line and the scroll math holds.
          <Text key={index} wrap="truncate-end">
            {line === "" ? " " : line}
          </Text>
        ))}
      </Box>
      <Text color={theme.dim}>
        {below > 0
          ? `↓ ${below} more — ↑/↓ or wheel to scroll · PgUp/PgDn · esc to return`
          : "end — ↑/↓ or wheel to scroll · esc to return to the menu"}
      </Text>
    </Box>
  );
}
