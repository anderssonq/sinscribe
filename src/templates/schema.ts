import { parse as parseYaml } from "yaml";

export type PlaceholderType = "string" | "markdown" | "list";
export type PlaceholderSource = "llm" | "git" | "branch";

export type PlaceholderSpec = {
  type: PlaceholderType;
  required: boolean;
  from: PlaceholderSource;
  description?: string;
};

export type TemplateKind = "pr" | "commit" | "branch";

export type Template = {
  name: string;
  kind: TemplateKind;
  description: string;
  placeholders: Record<string, PlaceholderSpec>;
  body: string;
  /** Where the template file lives (builtin, user, or project path). */
  sourcePath: string;
};

export class TemplateParseError extends Error {
  constructor(
    public readonly filePath: string,
    message: string,
  ) {
    super(`Invalid template ${filePath}: ${message}`);
    this.name = "TemplateParseError";
  }
}

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u;

export function parseTemplate(content: string, sourcePath: string): Template {
  const match = content.match(FRONTMATTER_PATTERN);

  if (!match) {
    throw new TemplateParseError(sourcePath, "missing YAML frontmatter block");
  }

  let frontmatter: unknown;

  try {
    frontmatter = parseYaml(match[1]);
  } catch (error) {
    throw new TemplateParseError(
      sourcePath,
      `frontmatter is not valid YAML (${error instanceof Error ? error.message : String(error)})`,
    );
  }

  if (!isRecord(frontmatter)) {
    throw new TemplateParseError(sourcePath, "frontmatter must be a mapping");
  }

  const name = frontmatter.name;
  const kind = frontmatter.kind;

  if (typeof name !== "string" || name.trim().length === 0) {
    throw new TemplateParseError(sourcePath, "missing required field: name");
  }

  if (kind !== "pr" && kind !== "commit" && kind !== "branch") {
    throw new TemplateParseError(
      sourcePath,
      "field kind must be one of: pr, commit, branch",
    );
  }

  return {
    name: name.trim(),
    kind,
    description:
      typeof frontmatter.description === "string"
        ? frontmatter.description
        : "",
    placeholders: parsePlaceholders(frontmatter.placeholders, sourcePath),
    body: content.slice(match[0].length),
    sourcePath,
  };
}

function parsePlaceholders(
  value: unknown,
  sourcePath: string,
): Record<string, PlaceholderSpec> {
  if (value === undefined || value === null) {
    return {};
  }

  if (!isRecord(value)) {
    throw new TemplateParseError(sourcePath, "placeholders must be a mapping");
  }

  const placeholders: Record<string, PlaceholderSpec> = {};

  for (const [key, spec] of Object.entries(value)) {
    if (!/^[a-z][a-z0-9_]*$/u.test(key)) {
      throw new TemplateParseError(
        sourcePath,
        `invalid placeholder name: ${key} (use lower_snake_case)`,
      );
    }

    if (!isRecord(spec)) {
      throw new TemplateParseError(
        sourcePath,
        `placeholder ${key} must be a mapping`,
      );
    }

    const type = spec.type ?? "string";
    const from = spec.from ?? "llm";

    if (type !== "string" && type !== "markdown" && type !== "list") {
      throw new TemplateParseError(
        sourcePath,
        `placeholder ${key}: type must be string, markdown, or list`,
      );
    }

    if (from !== "llm" && from !== "git" && from !== "branch") {
      throw new TemplateParseError(
        sourcePath,
        `placeholder ${key}: from must be llm, git, or branch`,
      );
    }

    placeholders[key] = {
      type,
      from,
      required: spec.required !== false,
      description:
        typeof spec.description === "string" ? spec.description : undefined,
    };
  }

  return placeholders;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
