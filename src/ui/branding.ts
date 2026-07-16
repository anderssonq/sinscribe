/**
 * Single home for the brand assets every screen shares. The README banner
 * (README.md, top) intentionally duplicates LOGO_LINES — it is a Markdown
 * document, not code — so a rebrand edits both.
 */

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

/** Shown next to the CLI name in the Header. */
export const BRAND_TAGLINE = "git-centric workflow assistant";

/** Title of the main menu's actions panel. */
export const MENU_PANEL_TITLE = "Actions";
