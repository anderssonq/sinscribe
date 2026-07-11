/**
 * Central UI palette and theme catalog.
 *
 * `theme` is the *active* palette: a single mutable object every Ink color in
 * src/ui reads from at render time. `setTheme()` mutates it in place, so a
 * re-render of the app tree (any state change at the root) repaints with the
 * new colors — no component needs to subscribe. `bg` is not an Ink color: it
 * is the terminal-window background applied via OSC 11 (see term.ts), so the
 * chosen theme's canvas covers the whole window regardless of the user's own
 * terminal colors. Hex values downgrade to 256/16 colors automatically via
 * chalk on non-truecolor terminals.
 *
 * Each theme is defined by six anchor colors (background, foreground, accent,
 * a secondary accent, and the diff green/red); the greys, banner ramp, and
 * spinner pulse are derived from those so a scheme reads coherently without
 * hand-tuning thirteen values per theme. Palettes are inspired by the named
 * terminal/editor color schemes, not exact ports.
 */

import { SINSCRIBE_THEME_ENV_KEY } from "../constants.js";

type RGB = [number, number, number];

function hexToRgb(hex: string): RGB {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function channel(n: number): string {
  const v = Math.max(0, Math.min(255, Math.round(n)));
  return v.toString(16).padStart(2, "0");
}

function rgbToHex([r, g, b]: RGB): string {
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

/** Linear blend between two hex colors: t=0 → a, t=1 → b. */
function mix(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  return rgbToHex([ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t]);
}

/** Perceived brightness, 0 (black) to 1 (white). */
function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/** Six evenly spaced steps from `dark` to `bright`, inclusive of both ends. */
function ramp6(dark: string, bright: string): string[] {
  const steps: string[] = [];
  for (let i = 0; i < 6; i += 1) {
    steps.push(mix(dark, bright, i / 5));
  }
  return steps;
}

export type Palette = {
  /** Terminal window background (OSC 11). */
  bg: string;
  /** Interactive highlights, titles, cursor. */
  accent: string;
  /** Prompt carets and chat markers. */
  accentAlt: string;
  /** Menu and input box borders. */
  border: string;
  /** Default item/body text. */
  body: string;
  /** Muted labels, hints, section headers. */
  dim: string;
  /** Faint text: paths, footer key hints. */
  faint: string;
  /** Selected item text. */
  selected: string;
  /** Selected-row text highlight. */
  selectedBg: string;
  /** Diff additions, success, ✓ done. */
  ok: string;
  /** Diff deletions, errors, danger items. */
  error: string;
  /** Banner gradient, darkest (top line) to brightest (bottom line). */
  ramp: string[];
  /** Color cycle for the animated loading spinner. */
  spinner: string[];
};

/** The six colors that fully define a theme; everything else is derived. */
type Anchors = {
  bg: string;
  fg: string;
  accent: string;
  accentAlt: string;
  green: string;
  red: string;
};

function makePalette(a: Anchors): Palette {
  const dark = luminance(a.bg) < 0.5;
  const contrastPole = dark ? "#ffffff" : "#000000";

  return {
    bg: a.bg,
    accent: a.accent,
    accentAlt: a.accentAlt,
    body: a.fg,
    border: mix(a.bg, a.fg, 0.42),
    dim: mix(a.bg, a.fg, 0.5),
    faint: mix(a.bg, a.fg, 0.3),
    selected: mix(a.fg, contrastPole, 0.6),
    selectedBg: mix(a.bg, a.fg, dark ? 0.13 : 0.1),
    ok: a.green,
    error: a.red,
    ramp: ramp6(mix(a.bg, a.accent, 0.4), a.accent),
    spinner: [
      mix(a.bg, a.accent, 0.45),
      mix(a.bg, a.accent, 0.65),
      mix(a.bg, a.accent, 0.85),
      a.accent,
      mix(a.bg, a.accent, 0.85),
      mix(a.bg, a.accent, 0.65),
    ],
  };
}

export type ThemeEntry = {
  id: string;
  name: string;
  dark: boolean;
  palette: Palette;
};

/** Theme catalog — dark schemes first, then light, matching the picker order. */
export const THEMES: ThemeEntry[] = [
  {
    id: "apprentice",
    name: "Apprentice",
    dark: true,
    palette: makePalette({
      bg: "#262626",
      fg: "#bcbcbc",
      accent: "#5f8787",
      accentAlt: "#87875f",
      green: "#5f875f",
      red: "#af5f5f",
    }),
  },
  {
    id: "ayu-dark",
    name: "Ayu Dark",
    dark: true,
    palette: makePalette({
      bg: "#0b0e14",
      fg: "#bfbdb6",
      accent: "#e6b450",
      accentAlt: "#ff8f40",
      green: "#7fd962",
      red: "#f26d78",
    }),
  },
  {
    id: "catppuccin-mocha",
    name: "Catppuccin Mocha",
    dark: true,
    palette: makePalette({
      bg: "#1e1e2e",
      fg: "#cdd6f4",
      accent: "#cba6f7",
      accentAlt: "#89b4fa",
      green: "#a6e3a1",
      red: "#f38ba8",
    }),
  },
  {
    id: "cobalt2",
    name: "Cobalt2",
    dark: true,
    palette: makePalette({
      bg: "#193549",
      fg: "#ffffff",
      accent: "#ffc600",
      accentAlt: "#ff9d00",
      green: "#3ad900",
      red: "#ff2600",
    }),
  },
  {
    id: "deus",
    name: "Deus",
    dark: true,
    palette: makePalette({
      bg: "#232830",
      fg: "#b0bec5",
      accent: "#7fb4ca",
      accentAlt: "#e0a3a3",
      green: "#a6c082",
      red: "#e07688",
    }),
  },
  {
    id: "dracula",
    name: "Dracula",
    dark: true,
    palette: makePalette({
      bg: "#282a36",
      fg: "#f8f8f2",
      accent: "#bd93f9",
      accentAlt: "#ff79c6",
      green: "#50fa7b",
      red: "#ff5555",
    }),
  },
  {
    id: "everforest-dark",
    name: "Everforest Dark",
    dark: true,
    palette: makePalette({
      bg: "#2d353b",
      fg: "#d3c6aa",
      accent: "#a7c080",
      accentAlt: "#e69875",
      green: "#a7c080",
      red: "#e67e80",
    }),
  },
  {
    id: "github-dark",
    name: "GitHub Dark",
    dark: true,
    palette: makePalette({
      bg: "#0d1117",
      fg: "#c9d1d9",
      accent: "#58a6ff",
      accentAlt: "#d2a8ff",
      green: "#3fb950",
      red: "#f85149",
    }),
  },
  {
    id: "gotham",
    name: "Gotham",
    dark: true,
    palette: makePalette({
      bg: "#0c1014",
      fg: "#98d1ce",
      accent: "#2aa889",
      accentAlt: "#edb54b",
      green: "#26a98b",
      red: "#c33027",
    }),
  },
  {
    id: "gruvbox-dark",
    name: "Gruvbox Dark",
    dark: true,
    palette: makePalette({
      bg: "#282828",
      fg: "#ebdbb2",
      accent: "#fabd2f",
      accentAlt: "#fe8019",
      green: "#b8bb26",
      red: "#fb4934",
    }),
  },
  {
    id: "iceberg-dark",
    name: "Iceberg Dark",
    dark: true,
    palette: makePalette({
      bg: "#161821",
      fg: "#c6c8d1",
      accent: "#84a0c6",
      accentAlt: "#e2a478",
      green: "#b4be82",
      red: "#e27878",
    }),
  },
  {
    id: "jellybeans",
    name: "Jellybeans",
    dark: true,
    palette: makePalette({
      bg: "#151515",
      fg: "#e8e8d3",
      accent: "#ffb964",
      accentAlt: "#8fbfdc",
      green: "#99ad6a",
      red: "#cf6a4c",
    }),
  },
  {
    id: "ayu-light",
    name: "Ayu Light",
    dark: false,
    palette: makePalette({
      bg: "#fcfcfc",
      fg: "#5c6166",
      accent: "#ffaa33",
      accentAlt: "#fa8d3e",
      green: "#86b300",
      red: "#f07171",
    }),
  },
  {
    id: "catppuccin-latte",
    name: "Catppuccin Latte",
    dark: false,
    palette: makePalette({
      bg: "#eff1f5",
      fg: "#4c4f69",
      accent: "#8839ef",
      accentAlt: "#1e66f5",
      green: "#40a02b",
      red: "#d20f39",
    }),
  },
  {
    id: "everforest-light",
    name: "Everforest Light",
    dark: false,
    palette: makePalette({
      bg: "#fdf6e3",
      fg: "#5c6a72",
      accent: "#8da101",
      accentAlt: "#f57d26",
      green: "#8da101",
      red: "#f85552",
    }),
  },
  {
    id: "github-light",
    name: "GitHub Light",
    dark: false,
    palette: makePalette({
      bg: "#ffffff",
      fg: "#24292f",
      accent: "#0969da",
      accentAlt: "#8250df",
      green: "#1a7f37",
      red: "#cf222e",
    }),
  },
  {
    id: "gruvbox-light",
    name: "Gruvbox Light",
    dark: false,
    palette: makePalette({
      bg: "#fbf1c7",
      fg: "#3c3836",
      accent: "#b57614",
      accentAlt: "#af3a03",
      green: "#79740e",
      red: "#9d0006",
    }),
  },
  {
    id: "iceberg-light",
    name: "Iceberg Light",
    dark: false,
    palette: makePalette({
      bg: "#e8e9ec",
      fg: "#33374c",
      accent: "#2d539e",
      accentAlt: "#c57339",
      green: "#668e3d",
      red: "#cc517a",
    }),
  },
  {
    id: "kanagawa-lotus",
    name: "Kanagawa Lotus",
    dark: false,
    palette: makePalette({
      bg: "#f2ecbc",
      fg: "#545464",
      accent: "#4d699b",
      accentAlt: "#cc6d00",
      green: "#6f894e",
      red: "#c84053",
    }),
  },
  {
    id: "night-owl-light",
    name: "Night Owl Light",
    dark: false,
    palette: makePalette({
      bg: "#fbfbfb",
      fg: "#403f53",
      accent: "#0c969b",
      accentAlt: "#994cc3",
      green: "#08916a",
      red: "#de3d3b",
    }),
  },
  {
    id: "nightfox-dayfox",
    name: "Nightfox Dayfox",
    dark: false,
    palette: makePalette({
      bg: "#f6f2ee",
      fg: "#352c24",
      accent: "#2848a9",
      accentAlt: "#ac5402",
      green: "#396847",
      red: "#a5222f",
    }),
  },
];

const THEME_BY_ID: Record<string, ThemeEntry> = Object.fromEntries(
  THEMES.map((entry) => [entry.id, entry]),
);

/** Shipped default — the Ayu Dark look the TUI launches with. */
export const DEFAULT_THEME_ID = "ayu-dark";

let activeThemeId = DEFAULT_THEME_ID;

/**
 * The active palette. Mutated in place by setTheme so every component that
 * reads `theme.*` at render time picks up the new colors on the next render.
 */
export const theme: Palette = { ...THEME_BY_ID[DEFAULT_THEME_ID].palette };

export function getActiveThemeId(): string {
  return activeThemeId;
}

/** Switches the active palette in place. Returns false for an unknown id. */
export function setTheme(id: string): boolean {
  const entry = THEME_BY_ID[id];
  if (!entry) {
    return false;
  }

  Object.assign(theme, entry.palette);
  activeThemeId = id;
  return true;
}

/** Rows for the Theme picker (SelectList), in catalog order. */
export function getThemeChoices(): {
  id: string;
  label: string;
  hint: string;
}[] {
  return THEMES.map((entry) => ({
    id: entry.id,
    label: entry.name,
    hint: entry.dark ? "Dark theme" : "Light theme",
  }));
}

/**
 * Applies the persisted theme (SINSCRIBE_THEME) when the env var names a known
 * scheme; unknown or unset leaves the shipped default. Call after
 * loadSinscribeEnv so the ~/.sinscribe/.env value is in process.env.
 */
export function initThemeFromEnv(): void {
  const id = process.env[SINSCRIBE_THEME_ENV_KEY]?.trim();
  if (id) {
    setTheme(id);
  }
}
