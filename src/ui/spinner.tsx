import { useEffect, useRef, useState } from "react";
import { Text } from "ink";
import { theme } from "./theme.js";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FRAME_MS = 80;
/** Frames per color step — the hue shifts every ~240ms. */
const FRAMES_PER_COLOR = 3;

/**
 * Animated, color-cycling loading indicator for every "the model is
 * thinking" state. Hand-rolled interval cycler; cleans up on unmount.
 */
export function Spinner({
  label,
  showElapsed = true,
}: {
  label: string;
  showElapsed?: boolean;
}) {
  const [tick, setTick] = useState(0);
  const startedAt = useRef(Date.now());

  useEffect(() => {
    const id = setInterval(() => {
      setTick((current) => current + 1);
    }, FRAME_MS);

    return () => {
      clearInterval(id);
    };
  }, []);

  const frame = FRAMES[tick % FRAMES.length];
  const color =
    theme.spinner[Math.floor(tick / FRAMES_PER_COLOR) % theme.spinner.length];
  const seconds = Math.floor((Date.now() - startedAt.current) / 1_000);

  return (
    <Text>
      <Text color={color}>
        {frame} {label}
      </Text>
      {showElapsed && seconds > 0 ? (
        <Text color={theme.dim}> ({seconds}s)</Text>
      ) : null}
    </Text>
  );
}
