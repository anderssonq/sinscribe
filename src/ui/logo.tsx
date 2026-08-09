import { Box, Text } from "ink";
import { LOGO_LINES } from "./branding.js";
import { theme } from "./theme.js";
import { useViewport } from "./viewport.js";

/**
 * ASCII logo for the main menu, colored with the carbon ramp — a dark-to-
 * light vertical gradient. Hidden when the terminal is too small (no
 * fallback line: the header right below already carries the bold name).
 * The art itself lives in branding.ts; the size math in viewport.ts.
 */
export function Logo() {
  // logoRows is already 0 when the viewport is too small — one decision,
  // made where the row budget that depends on it is computed.
  const { logoRows } = useViewport();

  if (logoRows === 0) {
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
