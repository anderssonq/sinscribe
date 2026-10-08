import { parse as parseYaml } from "yaml";
import { STANDARDS, type StandardId } from "./registry.js";

/**
 * Deterministic checks of a file the model wrote against its standard's
 * rules. Findings are warnings, never errors: the file is already on disk and
 * the author decides; the point is that a broken frontmatter or a bloated
 * context file is reported instead of discovered later by a silent agent.
 */

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u;

export function countLines(content: string): number {
  const trimmed = content.replace(/\s+$/u, "");

  return trimmed.length === 0 ? 0 : trimmed.split(/\r?\n/u).length;
}

/** The YAML frontmatter as a record, or null when there is none or it is not a mapping. */
export function parseFrontmatter(
  content: string,
): Record<string, unknown> | null {
  const match = FRONTMATTER.exec(content);

  if (!match) {
    return null;
  }

  try {
    const parsed: unknown = parseYaml(match[1]);

    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function validateAgainstStandard(
  id: StandardId,
  content: string,
  options: { expectedName?: string } = {},
): string[] {
  const { rules } = STANDARDS[id];
  const warnings: string[] = [];
  const lines = countLines(content);

  if (rules.maxLines !== undefined && lines > rules.maxLines) {
    warnings.push(
      `${lines} lines, above the ${rules.maxLines}-line limit of ${id}`,
    );
  } else if (rules.lineBudget !== undefined && lines > rules.lineBudget * 1.5) {
    warnings.push(
      `${lines} lines, well over the ~${rules.lineBudget}-line budget`,
    );
  }

  const spec = rules.frontmatter;

  if (!spec) {
    return warnings;
  }

  const frontmatter = parseFrontmatter(content);

  if (frontmatter === null) {
    warnings.push("missing or unparseable YAML frontmatter");

    return warnings;
  }

  for (const field of spec.required) {
    const value = frontmatter[field];

    if (typeof value !== "string" || value.trim().length === 0) {
      warnings.push(`frontmatter "${field}" is missing or empty`);
    }
  }

  for (const field of spec.discouraged ?? []) {
    if (field in frontmatter) {
      warnings.push(`frontmatter "${field}" is not part of ${id}`);
    }
  }

  const name = frontmatter.name;

  if (spec.name && typeof name === "string" && name.length > 0) {
    if (name.length > spec.name.maxLength || !spec.name.pattern.test(name)) {
      warnings.push(
        `frontmatter name "${name}" must be lowercase kebab-case, at most ${spec.name.maxLength} characters`,
      );
    }

    if (options.expectedName !== undefined && name !== options.expectedName) {
      warnings.push(
        `frontmatter name "${name}" does not match the file name "${options.expectedName}"`,
      );
    }
  }

  const description = frontmatter.description;

  if (
    spec.description &&
    typeof description === "string" &&
    description.length > spec.description.maxLength
  ) {
    warnings.push(
      `frontmatter description is ${description.length} characters, above ${spec.description.maxLength}`,
    );
  }

  return warnings;
}

/** "Standards check" block appended to a run's summary; empty when clean. */
export function formatStandardsReport(
  findings: Array<{ file: string; warnings: string[] }>,
): string {
  const lines = findings.flatMap(({ file, warnings }) =>
    warnings.map((warning) => `  ⚠ ${file}: ${warning}`),
  );

  return lines.length === 0
    ? ""
    : ["", "Standards check:", ...lines].join("\n");
}
