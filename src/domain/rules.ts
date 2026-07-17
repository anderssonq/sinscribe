import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isFileNotFoundError, sinscribeRulesPath } from "../env.js";

/**
 * Free-text rules the author writes, appended to every LLM command's system
 * prompt. Two tiers combine additively (unlike the template system's
 * highest-tier-wins): personal rules (~/.sinscribe/rules.md) apply to every
 * repo, project rules (<repoRoot>/.sinscribe/rules.md, meant to be committed)
 * apply to this one — both show up together when both exist.
 */

export type RulesSummary = {
  user: string | null;
  project: string | null;
  /** Both tiers, labeled and concatenated; null when neither has content. */
  combined: string | null;
};

export function getProjectRulesPath(repoRoot: string): string {
  return path.join(repoRoot, ".sinscribe", "rules.md");
}

/** Reads a rules file; missing or whitespace-only ⇒ null (never a stray heading). */
async function readRulesFile(filePath: string): Promise<string | null> {
  let raw: string;

  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return null;
    }

    throw error;
  }

  const trimmed = raw.trim();

  return trimmed.length > 0 ? trimmed : null;
}

export async function loadUserRules(): Promise<string | null> {
  return readRulesFile(sinscribeRulesPath);
}

export async function loadProjectRules(
  repoRoot: string | null,
): Promise<string | null> {
  if (repoRoot === null) {
    return null;
  }

  return readRulesFile(getProjectRulesPath(repoRoot));
}

/** Pure: labels each present tier and joins them, so provenance stays clear. */
export function combineRules(
  userText: string | null,
  projectText: string | null,
): string | null {
  const parts: string[] = [];

  if (userText !== null) {
    parts.push(`User rules:\n${userText}`);
  }

  if (projectText !== null) {
    parts.push(`Project rules:\n${projectText}`);
  }

  return parts.length > 0 ? parts.join("\n\n") : null;
}

/** Loads both tiers and their additive combination for a run. */
export async function loadRules(
  repoRoot: string | null,
): Promise<RulesSummary> {
  const [user, project] = await Promise.all([
    loadUserRules(),
    loadProjectRules(repoRoot),
  ]);

  return { user, project, combined: combineRules(user, project) };
}

async function writeRulesFile(
  filePath: string,
  content: string,
): Promise<string> {
  await mkdir(path.dirname(filePath), { recursive: true });

  const trimmed = content.trim();

  await writeFile(filePath, trimmed.length > 0 ? `${trimmed}\n` : "", "utf8");

  return filePath;
}

/** Writes the user-tier rules file, creating ~/.sinscribe if needed. Returns the path written. */
export async function saveUserRules(content: string): Promise<string> {
  return writeRulesFile(sinscribeRulesPath, content);
}

/** Writes the project-tier rules file, creating <repoRoot>/.sinscribe if needed. Returns the path written. */
export async function saveProjectRules(
  repoRoot: string,
  content: string,
): Promise<string> {
  return writeRulesFile(getProjectRulesPath(repoRoot), content);
}

/** One-line dry-run summary of what's active, e.g. "user tier (42 chars) + project tier (18 chars)". */
export function describeRulesForDryRun(summary: RulesSummary): string {
  const parts: string[] = [];

  if (summary.user !== null) {
    parts.push(`user tier (${summary.user.length} chars)`);
  }

  if (summary.project !== null) {
    parts.push(`project tier (${summary.project.length} chars)`);
  }

  return parts.length > 0 ? parts.join(" + ") : "none";
}
