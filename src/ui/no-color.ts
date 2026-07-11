/**
 * Honors the NO_COLOR convention (https://no-color.org). Chalk 5's vendored
 * supports-color only checks the --no-color CLI flag and FORCE_COLOR, never
 * the NO_COLOR env var — so map it ourselves. Must be imported before ink
 * (and therefore chalk) so the level is read after the override.
 */
if (process.env.NO_COLOR && !("FORCE_COLOR" in process.env)) {
  process.env.FORCE_COLOR = "0";
}

export {};
