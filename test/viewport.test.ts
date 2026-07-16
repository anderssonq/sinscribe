import { describe, expect, it } from "vitest";
import { LOGO_LINES, LOGO_WIDTH } from "../src/ui/branding.js";
import { computeViewport, logoVisible } from "../src/ui/viewport.js";

describe("logoVisible", () => {
  it("shows the logo only when both dimensions have room", () => {
    expect(logoVisible(LOGO_WIDTH + 2, 30)).toBe(true);
    expect(logoVisible(LOGO_WIDTH + 1, 30)).toBe(false); // one column short
    expect(logoVisible(LOGO_WIDTH + 2, 29)).toBe(false); // one row short
    expect(logoVisible(300, 100)).toBe(true);
    expect(logoVisible(40, 15)).toBe(false);
  });
});

describe("computeViewport", () => {
  it("gives a very tall/wide terminal generous content rows", () => {
    const viewport = computeViewport(300, 100);

    expect(viewport.logoRows).toBe(LOGO_LINES.length);
    expect(viewport.contentRows).toBe(100 - LOGO_LINES.length - 8);
    expect(viewport.contentRows).toBeGreaterThan(80);
  });

  it("hides the logo and floors contentRows on a tiny terminal", () => {
    const viewport = computeViewport(40, 15);

    expect(viewport.logoRows).toBe(0);
    expect(viewport.contentRows).toBe(7);
  });

  it("never returns fewer than 3 content rows", () => {
    expect(computeViewport(20, 5).contentRows).toBe(3);
    expect(computeViewport(20, 1).contentRows).toBe(3);
  });

  it("matches the historical 80x24 window math (logo hidden)", () => {
    const viewport = computeViewport(80, 24);

    expect(viewport.logoRows).toBe(0);
    expect(viewport.contentRows).toBe(16);
  });
});
