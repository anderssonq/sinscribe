import { SINSCRIBE_TICKET_PATTERN_ENV_KEY } from "../constants.js";

const JIRA_TICKET_PATTERN = /\b([A-Z][A-Z0-9]+-\d+)\b/u;
const ISSUE_NUMBER_PATTERN = /#(\d+)\b/u;

/**
 * Extracts a ticket ID (Jira-style `ABC-123` or issue `#123`) from arbitrary
 * text such as a branch name. A custom pattern can be supplied via the
 * SINSCRIBE_TICKET_PATTERN env var; its first capture group (or full match)
 * is used.
 */
export function extractTicketId(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const customPattern = env[SINSCRIBE_TICKET_PATTERN_ENV_KEY]?.trim();

  if (customPattern) {
    try {
      const match = text.match(new RegExp(customPattern, "u"));

      if (match) {
        return match[1] ?? match[0];
      }
    } catch {
      // Invalid custom pattern: fall through to the defaults.
    }
  }

  const jiraMatch = text.match(new RegExp(JIRA_TICKET_PATTERN.source, "iu"));

  if (jiraMatch?.[1]) {
    return jiraMatch[1].toUpperCase();
  }

  const issueMatch = text.match(ISSUE_NUMBER_PATTERN);

  return issueMatch ? `#${issueMatch[1]}` : null;
}

/** Lowercase-kebab slug, ASCII only, capped for branch-name friendliness. */
export function slugify(text: string, maxLength = 40): string {
  const slug = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");

  if (slug.length <= maxLength) {
    return slug;
  }

  const capped = slug.slice(0, maxLength);
  const lastDash = capped.lastIndexOf("-");

  return lastDash > 8 ? capped.slice(0, lastDash) : capped;
}

/**
 * Sanitizes a model-proposed *whole* branch name into a valid git ref,
 * preserving case (ticket IDs stay upper) and slashes (type/scope prefixes).
 * Returns null when nothing usable survives. Used by the preferences-driven
 * branch flow, where the model returns complete names to honor a requested
 * format rather than the bare slugs `buildBranchName` assembles.
 *
 * Each "/"-separated segment is cleaned independently, which guarantees the
 * git-check-ref-format rules that bite in practice: no leading/trailing slash,
 * no "//", no segment starting or ending with "." or "-", no "..", and no
 * ".lock" suffix. git itself remains the final guard in applyBranchName.
 */
export function sanitizeBranchRef(name: string): string | null {
  const segments = name
    .trim()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/gu, "")
    .replace(/\s+/gu, "-")
    .replace(/[^A-Za-z0-9._/-]+/gu, "-")
    .split("/")
    .map((segment) =>
      segment
        .replace(/\.lock$/iu, "")
        .replace(/\.{2,}/gu, ".")
        .replace(/-{2,}/gu, "-")
        .replace(/^[.-]+|[.-]+$/gu, ""),
    )
    .filter((segment) => segment.length > 0);

  return segments.length > 0 ? segments.join("/") : null;
}

export const BRANCH_TYPES = [
  "feat",
  "fix",
  "chore",
  "docs",
  "refactor",
  "test",
  "perf",
  "build",
  "ci",
  "hotfix",
] as const;

export type BranchType = (typeof BRANCH_TYPES)[number];

export function isBranchType(value: string): value is BranchType {
  return (BRANCH_TYPES as readonly string[]).includes(value);
}

/** Cheap keyword-based branch-type inference for deterministic dry runs. */
export function inferBranchType(description: string): BranchType {
  const text = description.toLowerCase();

  if (/\b(fix|bug|broken|crash|error|issue|regression)\b/u.test(text)) {
    return "fix";
  }

  if (/\b(doc|docs|readme|documentation)\b/u.test(text)) {
    return "docs";
  }

  if (/\b(refactor|cleanup|restructure|rework)\b/u.test(text)) {
    return "refactor";
  }

  if (/\b(test|tests|spec|coverage)\b/u.test(text)) {
    return "test";
  }

  if (/\b(chore|bump|upgrade|dependency|deps|config)\b/u.test(text)) {
    return "chore";
  }

  return "feat";
}

export function buildBranchName(
  type: BranchType,
  ticketId: string | null,
  description: string,
): string {
  const ticketSegment = ticketId
    ? `${ticketId.replace(/^#/u, "").toUpperCase()}-`
    : "";
  const slug = slugify(description);

  return `${type}/${ticketSegment}${slug}`.replace(/-+$/u, "");
}
