import type { Template } from "./schema.js";

export type PlaceholderValues = Record<string, string | string[] | undefined>;

export class TemplateRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateRenderError";
  }
}

/**
 * Substitutes {{placeholder}} slots in a template body. Missing required
 * values throw; missing optional values render as an empty string (and any
 * heading directly above an emptied optional block is left untouched —
 * templates should keep optional sections self-contained).
 *
 * With `leaveUnfilled`, slots without a value stay as `{{name}}` — used by
 * --dry-run to show the scaffold.
 */
export function renderTemplate(
  template: Template,
  values: PlaceholderValues,
  options: { leaveUnfilled?: boolean } = {},
): string {
  const missing: string[] = [];
  const rendered = template.body.replace(
    /\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/gu,
    (raw, name: string) => {
      const spec = template.placeholders[name];
      const value = values[name];

      if (value === undefined) {
        if (options.leaveUnfilled) {
          return raw;
        }

        if (spec?.required !== false) {
          missing.push(name);
        }

        return "";
      }

      return formatValue(value, spec?.type ?? "string");
    },
  );

  if (missing.length > 0) {
    throw new TemplateRenderError(
      `Missing required placeholder value(s): ${missing.join(", ")}`,
    );
  }

  return `${rendered.replace(/\n{3,}/gu, "\n\n").trim()}\n`;
}

function formatValue(value: string | string[], type: string): string {
  if (Array.isArray(value)) {
    return value.map((item) => `- ${item}`).join("\n");
  }

  if (type === "list") {
    // A single string for a list slot: keep as one bullet unless it already
    // looks like a bullet list.
    return /^\s*[-*]/u.test(value) ? value : `- ${value}`;
  }

  return value;
}

/**
 * Renders a template body for the picker preview: every {{slot}} becomes a hint
 * drawn from its placeholder description (or the slot name when it has none),
 * wrapped in ‹ › so it reads as sample text rather than literal `{{syntax}}`.
 * No real values are produced — this only shows the shape the generated text
 * will take, so the user can judge a template before spending a model call.
 */
export function renderTemplatePreview(template: Template): string {
  const rendered = template.body.replace(
    /\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/gu,
    (_raw, name: string) => {
      const hint = template.placeholders[name]?.description?.trim() || name;
      return `‹ ${hint} ›`;
    },
  );

  return `${rendered.replace(/\n{3,}/gu, "\n\n").trim()}\n`;
}

/** Names of placeholders the LLM must produce for this template. */
export function getLlmPlaceholderNames(template: Template): string[] {
  return Object.entries(template.placeholders)
    .filter(([, spec]) => spec.from === "llm")
    .map(([name]) => name);
}
