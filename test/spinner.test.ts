import { describe, expect, it } from "vitest";
import {
  formatElapsed,
  gridFrame,
  shimmerSegments,
  STILL_FRAME,
  type SpinnerVariant,
} from "../src/ui/spinner.js";

const VARIANTS: SpinnerVariant[] = ["pixels", "orbit"];

/** Braille's low dot row (0x40/0x80) hangs below the text baseline. */
function usesLowDotRow(frame: string): boolean {
  return [...frame].some(
    (cell) => (((cell.codePointAt(0) ?? 0) - 0x2800) & 0xc0) !== 0,
  );
}

function isBraille(frame: string): boolean {
  return [...frame].every((cell) => {
    const code = cell.codePointAt(0) ?? 0;

    return code >= 0x2800 && code <= 0x28ff;
  });
}

/** Per-character colors, undoing the run-length grouping. */
function expand(segments: { text: string; color: string }[]): string[] {
  return segments.flatMap((segment) =>
    [...segment.text].map(() => segment.color),
  );
}

describe("gridFrame", () => {
  for (const variant of VARIANTS) {
    it(`draws three braille cells on the baseline (${variant})`, () => {
      for (let tick = 0; tick < 24; tick += 1) {
        const frame = gridFrame(tick, variant);

        expect([...frame]).toHaveLength(3);
        expect(isBraille(frame)).toBe(true);
        expect(usesLowDotRow(frame)).toBe(false);
      }
    });

    it(`animates rather than holding one frame (${variant})`, () => {
      const frames = new Set(
        Array.from({ length: 24 }, (_, tick) => gridFrame(tick, variant)),
      );

      expect(frames.size).toBeGreaterThan(1);
    });
  }

  it("repeats the chevron wavefront every six ticks", () => {
    for (let tick = 0; tick < 12; tick += 1) {
      expect(gridFrame(tick + 6)).toBe(gridFrame(tick));
    }
  });

  it("never blanks the grid: a second front is always in flight", () => {
    for (let tick = 0; tick < 12; tick += 1) {
      expect(gridFrame(tick)).not.toBe("⠀⠀⠀");
    }
  });

  it("laps the perimeter of the grid in the orbit variant", () => {
    const frames = Array.from({ length: 14 }, (_, tick) =>
      gridFrame(tick, "orbit"),
    );

    expect(gridFrame(14, "orbit")).toBe(frames[0]);
  });

  it("freezes to a full grid under reduced motion", () => {
    expect([...STILL_FRAME]).toHaveLength(3);
    expect(isBraille(STILL_FRAME)).toBe(true);
    expect(usesLowDotRow(STILL_FRAME)).toBe(false);
  });
});

describe("shimmerSegments", () => {
  const RAMP = ["r0", "r1", "r2", "r3", "r4", "r5"];
  const LABEL = "Waiting for model output...";

  it("reproduces the label exactly", () => {
    for (let tick = 0; tick < 40; tick += 1) {
      const text = shimmerSegments(LABEL, tick, RAMP)
        .map((segment) => segment.text)
        .join("");

      expect(text).toBe(LABEL);
    }
  });

  it("returns nothing for an empty label", () => {
    expect(shimmerSegments("", 3, RAMP)).toEqual([]);
  });

  it("groups equal-color runs so a long label stays cheap to render", () => {
    for (let tick = 0; tick < 40; tick += 1) {
      expect(shimmerSegments(LABEL, tick, RAMP).length).toBeLessThanOrEqual(
        RAMP.length * 2,
      );
    }
  });

  it("sweeps the highlight left to right", () => {
    const brightest = (tick: number) =>
      expand(shimmerSegments(LABEL, tick, RAMP)).indexOf(RAMP[RAMP.length - 1]);

    // Ticks 0..4 keep the head over the label; past its length the sweep runs
    // off the end, which is the pause before the next pass.
    for (let tick = 0; tick < 5; tick += 1) {
      expect(brightest(tick)).toBe(tick);
    }
  });

  it("falls off symmetrically around the highlight", () => {
    const colors = expand(shimmerSegments(LABEL, 6, RAMP));

    expect(colors[6]).toBe("r5");
    expect(colors[5]).toBe("r4");
    expect(colors[7]).toBe("r4");
    expect(colors[0]).toBe("r0");
  });
});

describe("formatElapsed", () => {
  it("counts in tenths below a minute", () => {
    expect(formatElapsed(0)).toBe(" 0.0s");
    expect(formatElapsed(950)).toBe(" 0.9s");
    expect(formatElapsed(9_999)).toBe(" 9.9s");
    expect(formatElapsed(10_000)).toBe("10.0s");
    expect(formatElapsed(59_900)).toBe("59.9s");
  });

  it("switches to minutes with zero-padded seconds", () => {
    expect(formatElapsed(60_000)).toBe("1m 00.0s");
    expect(formatElapsed(62_300)).toBe("1m 02.3s");
    expect(formatElapsed(3_723_400)).toBe("62m 03.4s");
  });

  it("keeps a fixed width below a minute so the digits stay in column", () => {
    const widths = new Set<number>();

    for (let ms = 0; ms < 60_000; ms += 137) {
      widths.add(formatElapsed(ms).length);
    }

    expect([...widths]).toEqual([5]);
  });

  it("clamps a negative reading to zero", () => {
    expect(formatElapsed(-500)).toBe(" 0.0s");
  });
});
