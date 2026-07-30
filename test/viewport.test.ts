import { describe, expect, it } from "vitest";
import { LOGO_LINES, LOGO_WIDTH } from "../src/ui/branding.js";
import {
  computePromptRows,
  computeViewport,
  logoVisible,
} from "../src/ui/viewport.js";

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

describe("computePromptRows", () => {
  const bounds = { min: 2, max: 20 };

  it("gives a prompt more rows as the terminal grows", () => {
    // 80x24 -> 16 content rows, less five of chrome.
    expect(computePromptRows(16, 5, bounds)).toBe(11);
    // A tall window reaches the ceiling instead of growing without end.
    expect(computePromptRows(86, 5, bounds)).toBe(20);
  });

  it("never drops below the minimum on a tiny terminal", () => {
    expect(computePromptRows(3, 5, bounds)).toBe(2);
    expect(computePromptRows(7, 7, bounds)).toBe(2);
  });

  it("treats a caller's cap as the ceiling", () => {
    expect(computePromptRows(86, 5, { min: 1, max: 8 })).toBe(8);
  });

  it("ignores a negative chrome count", () => {
    expect(computePromptRows(10, -4, bounds)).toBe(10);
  });
});
