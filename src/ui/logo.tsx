import { useEffect, useState } from "react";
import { Box, Text, useStdout } from "ink";
import { theme } from "./theme.js";

/** The README figlet banner, right-trimmed (double quotes: lines hold ` and "). */
export const LOGO_LINES: string[] = [
  "         oo                                     oo dP",
  "                                                   88",
  ".d8888b. dP 88d888b. .d8888b. .d8888b. 88d888b. dP 88d888b. .d8888b.",
  "Y8ooooo. 88 88'  `88 Y8ooooo. 88'  `\"\" 88'  `88 88 88'  `88 88ooood8",
  "      88 88 88    88       88 88.  ... 88       88 88.  .88 88.  ...",
  "`88888P' dP dP    dP `88888P' `88888P' dP       dP 88Y8888' `88888P'",
];

export const LOGO_WIDTH = Math.max(...LOGO_LINES.map((line) => line.length));

/**
 * Rows the logo needs before it is worth showing. Set so the tallest view —
 * the main menu (logo + header + the bordered action list with a two-line
 * hint + footer) — still fits under it; below this the logo is hidden so that
 * view never exceeds the viewport (an over-tall Ink frame in the alt-screen
 * can't be erased cleanly and leaves residue / triggers full-clear flashes).
 */
const LOGO_MIN_ROWS = 30;

/** True when the terminal is tall and wide enough to show the ASCII logo. */
export function logoVisible(columns: number, rows: number): boolean {
  return columns >= LOGO_WIDTH + 2 && rows >= LOGO_MIN_ROWS;
}

/** Current terminal size, re-rendering on resize (0/undefined → defaults). */
export function useTerminalSize(): { columns: number; rows: number } {
  const { stdout } = useStdout();
  const measure = () => ({
    columns: stdout.columns || 80,
    rows: stdout.rows || 24,
  });
  const [size, setSize] = useState(measure);

  useEffect(() => {
    const onResize = () => {
      setSize(measure());
    };

    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  return size;
}

/**
 * ASCII logo for the main menu, colored with the carbon ramp — a dark-to-
 * light vertical gradient. Hidden when the terminal is too small (no
 * fallback line: the header right below already carries the bold name).
 */
export function Logo() {
  const { columns, rows } = useTerminalSize();

  if (!logoVisible(columns, rows)) {
    return null;
  }

  return (
    <Box flexDirection="column">
      {LOGO_LINES.map((line, index) => {
        // Each glyph row maps to one carbon-ramp stop, top (darkest) to bottom.
        const color = index < theme.ramp.length ? theme.ramp[index] : undefined;

        return (
          <Text color={color} key={index} wrap="truncate-end">
            {line}
          </Text>
        );
      })}
    </Box>
  );
}
