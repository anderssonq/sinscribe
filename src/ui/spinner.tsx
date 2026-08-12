import { useEffect, useRef, useState } from "react";
import { Text, useStdout } from "ink";
import { SINSCRIBE_REDUCED_MOTION_ENV_KEY } from "../constants.js";
import { theme } from "./theme.js";

/**
 * The loading indicator every "the model is thinking" state renders: a pixel
 * grid driving a wavefront, a label with a shimmer sweeping across it, and a
 * live elapsed timer.
 *
 * The grid is three braille characters, which is a 6x3 dot matrix inside a
 * *single* terminal row — the whole widget must never grow past one row. Ink
 * clears and repaints the entire screen once a frame reaches the terminal's
 * height (its `outputHeight >= stdout.rows` branch), which reads as a freeze,
 * so the same windowing discipline RunLog applies to streamed output applies
 * here by construction.
 */

/** Dot bit for [row][column-within-cell] of a braille cell (U+2800 + mask). */
const DOT_BITS = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
];

/**
 * Only the three high dot rows are used. Braille's fourth row (dots 7/8,
 * 0x40/0x80) hangs below the text baseline and visibly de-centers the widget
 * against the label beside it.
 */
const DOT_ROWS = DOT_BITS.length;
const CELLS = 3;
const DOT_COLUMNS = CELLS * 2;

const BRAILLE_BASE = 0x2800;
/** Every dot of the three used rows lit — the frozen, reduced-motion grid. */
export const STILL_FRAME = String.fromCodePoint(
  ...Array.from({ length: CELLS }, () => BRAILLE_BASE + 0x3f),
);

const FRAME_MS = 80;
/** Reduced motion still needs a heartbeat, but only to advance the timer. */
const REDUCED_FRAME_MS = 1_000;
/** Frames per color step — the hue shifts every ~240ms. */
const FRAMES_PER_COLOR = 3;

/**
 * Ticks between one wavefront and the next. Deliberately shorter than the
 * 7-step sweep a front needs to cross the grid, so two fronts are always in
 * flight and the grid never reads as empty mid-cycle.
 */
const WAVE_PERIOD = 6;
/**
 * Ticks a dot stays lit as the front passes over it. Half the period: a
 * braille dot is either on or off, so where the web grid keeps every cell
 * visible at a low opacity, density is the only thing standing in for it —
 * a thinner front reads as a few scattered dots rather than a grid.
 */
const WAVE_WIDTH = 3;

/** Comet length, in dots, for the orbit variant. */
const COMET_DOTS = 3;

/** Perimeter of the 6x3 grid, clockwise from the top-left dot. */
const ORBIT_PATH: [column: number, row: number][] = [
  ...Array.from(
    { length: DOT_COLUMNS },
    (_, column) => [column, 0] as [number, number],
  ),
  [DOT_COLUMNS - 1, 1],
  ...Array.from(
    { length: DOT_COLUMNS },
    (_, index) => [DOT_COLUMNS - 1 - index, DOT_ROWS - 1] as [number, number],
  ),
  [0, 1],
];

export type SpinnerVariant = "pixels" | "orbit";

/**
 * Chevron wavefront: a dot's turn comes from its column plus its distance from
 * the middle row, so the lit front leans forward as it drives right.
 */
function chevronPhase(column: number, row: number): number {
  return column + Math.abs(row - Math.floor(DOT_ROWS / 2));
}

function withinFront(tick: number, phase: number, period: number): number {
  return (((tick - phase) % period) + period) % period;
}

function isLit(
  tick: number,
  column: number,
  row: number,
  variant: SpinnerVariant,
) {
  if (variant === "orbit") {
    const index = ORBIT_PATH.findIndex(
      ([orbitColumn, orbitRow]) => orbitColumn === column && orbitRow === row,
    );

    return (
      index !== -1 && withinFront(tick, index, ORBIT_PATH.length) < COMET_DOTS
    );
  }

  return withinFront(tick, chevronPhase(column, row), WAVE_PERIOD) < WAVE_WIDTH;
}

/** The three braille characters of the grid at `tick`. */
export function gridFrame(tick: number, variant: SpinnerVariant = "pixels") {
  const cells: number[] = [];

  for (let cell = 0; cell < CELLS; cell += 1) {
    let mask = 0;

    for (let row = 0; row < DOT_ROWS; row += 1) {
      for (let half = 0; half < 2; half += 1) {
        if (isLit(tick, cell * 2 + half, row, variant)) {
          mask |= DOT_BITS[row][half];
        }
      }
    }

    cells.push(BRAILLE_BASE + mask);
  }

  return String.fromCodePoint(...cells);
}

export type ShimmerSegment = { text: string; color: string };

/**
 * Splits `label` into the fewest colored runs that draw a highlight sweeping
 * left to right across it. Consecutive characters landing on the same ramp
 * stop are merged, so a long label costs a handful of Text nodes per frame
 * rather than one per character.
 */
export function shimmerSegments(
  label: string,
  tick: number,
  ramp: string[] = theme.shimmer,
): ShimmerSegment[] {
  if (label.length === 0 || ramp.length === 0) {
    return [];
  }

  // The sweep runs off the end of the label before restarting, which is the
  // pause between passes the CSS gradient gets from its 200% background.
  const head = tick % (label.length + ramp.length);
  const segments: ShimmerSegment[] = [];

  for (let index = 0; index < label.length; index += 1) {
    const distance = Math.abs(index - head);
    const stop = Math.max(0, ramp.length - 1 - distance);
    const color = ramp[stop];
    const last = segments.at(-1);

    if (last && last.color === color) {
      last.text += label[index];
    } else {
      segments.push({ text: label[index], color });
    }
  }

  return segments;
}

/**
 * Elapsed time in tenths, padded to a fixed width so the digits stay in
 * their columns as the count crosses 9.9s and 59.9s.
 */
export function formatElapsed(ms: number): string {
  const tenths = Math.floor(Math.max(0, ms) / 100);

  if (tenths < 600) {
    return `${Math.floor(tenths / 10)}.${tenths % 10}s`.padStart(5, " ");
  }

  const minutes = Math.floor(tenths / 600);
  const rest = tenths - minutes * 600;

  return `${minutes}m ${String(Math.floor(rest / 10)).padStart(2, "0")}.${rest % 10}s`;
}

/**
 * "off" is a pipe or a CI log, where animating means a fresh line every frame;
 * "reduced" is a terminal whose user asked for stillness — the grid freezes but
 * the timer keeps counting, so the widget still shows the run is alive.
 */
type MotionMode = "full" | "reduced" | "off";

function useMotionMode(): MotionMode {
  const { stdout } = useStdout();

  if (!stdout.isTTY) {
    return "off";
  }

  const flag = process.env[SINSCRIBE_REDUCED_MOTION_ENV_KEY]?.trim();

  return flag === "1" || flag === "true" ? "reduced" : "full";
}

export function Spinner({
  label,
  showElapsed = true,
  variant = "pixels",
}: {
  label: string;
  showElapsed?: boolean;
  variant?: SpinnerVariant;
}) {
  const motion = useMotionMode();
  const [tick, setTick] = useState(0);
  const startedAt = useRef(Date.now());

  useEffect(() => {
    if (motion === "off") {
      return;
    }

    const id = setInterval(
      () => {
        setTick((current) => current + 1);
      },
      motion === "reduced" ? REDUCED_FRAME_MS : FRAME_MS,
    );

    return () => {
      clearInterval(id);
    };
  }, [motion]);

  const animated = motion === "full";
  const colorStep = Math.floor(tick / FRAMES_PER_COLOR);
  const elapsed = Date.now() - startedAt.current;

  return (
    // Truncate, never wrap: a second row would break the one-row invariant on
    // a narrow terminal.
    <Text wrap="truncate">
      {animated ? (
        [...gridFrame(tick, variant)].map((cell, index) => (
          <Text
            color={theme.spinner[(colorStep + index) % theme.spinner.length]}
            key={index}
          >
            {cell}
          </Text>
        ))
      ) : (
        <Text color={theme.dim}>{STILL_FRAME}</Text>
      )}{" "}
      {animated ? (
        shimmerSegments(label, tick).map((segment, index) => (
          <Text color={segment.color} key={index}>
            {segment.text}
          </Text>
        ))
      ) : (
        <Text color={theme.dim}>{label}</Text>
      )}
      {showElapsed && motion !== "off" && elapsed >= 1_000 ? (
        <Text color={theme.faint}> {formatElapsed(elapsed)}</Text>
      ) : null}
    </Text>
  );
}
