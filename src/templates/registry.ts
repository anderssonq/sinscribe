import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sinscribeTemplatesDir } from "../env.js";
import { parseTemplate, type Template, type TemplateKind } from "./schema.js";

export type TemplateTier = "builtin" | "user" | "project";

export type TemplateEntry = Template & { tier: TemplateTier };

/** Shipped templates live at <package root>/templates. */
export function getBuiltinTemplatesDir(): string {
  return path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "templates",
  );
}

export function getUserTemplatesDir(): string {
  return sinscribeTemplatesDir;
}

export function getProjectTemplatesDir(repoRoot: string): string {
  return path.join(repoRoot, ".sinscribe", "templates");
}

/**
 * Loads all templates. Later tiers override earlier ones by name:
 * builtin < user (~/.sinscribe/templates) < project (<repo>/.sinscribe/templates).
 */
export async function loadTemplates(
  repoRoot: string | null,
): Promise<TemplateEntry[]> {
  const tiers: Array<{ dir: string; tier: TemplateTier }> = [
    { dir: getBuiltinTemplatesDir(), tier: "builtin" },
    { dir: getUserTemplatesDir(), tier: "user" },
  ];

  if (repoRoot) {
    tiers.push({ dir: getProjectTemplatesDir(repoRoot), tier: "project" });
  }

  const byName = new Map<string, TemplateEntry>();

  for (const { dir, tier } of tiers) {
    for (const template of await loadTemplatesFromDir(dir)) {
      byName.set(template.name, { ...template, tier });
    }
  }

  return [...byName.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

export async function resolveTemplate(
  name: string,
  kind: TemplateKind,
  repoRoot: string | null,
): Promise<TemplateEntry> {
  const templates = await loadTemplates(repoRoot);
  const template = templates.find((entry) => entry.name === name);

  if (!template) {
    const available = templates
      .filter((entry) => entry.kind === kind)
      .map((entry) => entry.name)
      .join(", ");

    throw new Error(
      `Template not found: ${name}. Available ${kind} templates: ${available || "(none)"}.`,
    );
  }

  if (template.kind !== kind) {
    throw new Error(
      `Template ${name} is a ${template.kind} template, not a ${kind} template.`,
    );
  }

  return template;
}

export async function saveUserTemplate(
  name: string,
  content: string,
): Promise<string> {
  // Validate before writing so a broken template never lands in the library.
  parseTemplate(content, `${name}.md`);

  const dir = getUserTemplatesDir();

  await mkdir(dir, { recursive: true });

  const filePath = path.join(dir, `${sanitizeTemplateFileName(name)}.md`);

  await writeFile(filePath, content, "utf8");

  return filePath;
}

export function createTemplateScaffold(name: string): string {
  return `---
name: ${name}
kind: pr
description: Describe what this template is for
placeholders:
  title: { type: string, required: true, from: llm }
  summary: { type: markdown, required: true, from: llm }
  changes: { type: list, required: true, from: llm }
  branch: { type: string, required: false, from: git }
---
## {{title}}

### Summary

{{summary}}

### Changes

{{changes}}
`;
}

export function sanitizeTemplateFileName(name: string): string {
  const sanitized = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^[-.]+|[-.]+$/gu, "");

  if (sanitized.length === 0) {
    throw new Error(`Invalid template name: ${name}`);
  }

  return sanitized;
}

async function loadTemplatesFromDir(dir: string): Promise<Template[]> {
  let entries: string[];

  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const templates: Template[] = [];

  for (const entry of entries.filter((file) => file.endsWith(".md")).sort()) {
    const filePath = path.join(dir, entry);

    try {
      templates.push(parseTemplate(await readFile(filePath, "utf8"), filePath));
    } catch {
      // Skip unparseable templates; `template list` surfaces valid ones only.
    }
  }

  return templates;
}
