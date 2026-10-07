import { readFile } from "node:fs/promises";
import path from "node:path";
import { tryGit } from "../git/run.js";
import { redactSecrets } from "../util/redact.js";

/**
 * A cheap, bounded orientation pack about the repository: the tracked file
 * list, the agent rule files at the root, and the real script commands. It is
 * what the plan's requirements/design stages see when the provider cannot
 * explore (Kiro, --no-explore, an old claude CLI), and a head start when it
 * can. Tracked files only — gitignored secrets are never even listed.
 */

const DEFAULT_MAX_FILES = 400;
const DEFAULT_MAX_DOC_BYTES = 8_000;
const ROOT_DOCS = ["CLAUDE.md", "AGENTS.md"];
/** Build manifests worth naming, so the model uses the repo's real tooling. */
const MANIFESTS = [
  "package.json",
  "pnpm-workspace.yaml",
  "Makefile",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "build.gradle",
  "build.gradle.kts",
  "pom.xml",
  "Gemfile",
];

/** Mirrors EXPLORE_DENY_GLOBS for plain paths (no glob engine needed). */
export function isSecretPath(relPath: string): boolean {
  const segments = relPath.split("/");
  const base = segments.at(-1) ?? relPath;

  return (
    segments.some(
      (segment) =>
        segment === ".git" || segment === ".sinscribe" || segment === "secrets",
    ) ||
    /^\.env(\..*)?$/u.test(base) ||
    /\.(pem|key|p12|pfx)$/u.test(base) ||
    /^id_(rsa|ed25519|ecdsa)/u.test(base) ||
    /^\.(npmrc|netrc|pypirc)$/u.test(base) ||
    /^credentials/u.test(base) ||
    /^secrets\./u.test(base)
  );
}

export async function buildRepoBrief(
  repoRoot: string,
  options: { maxFiles?: number; maxDocBytes?: number } = {},
): Promise<string> {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxDocBytes = options.maxDocBytes ?? DEFAULT_MAX_DOC_BYTES;
  const listing = await tryGit(repoRoot, ["ls-files"]);
  const files = (listing ?? "")
    .split("\n")
    .filter((file) => file.length > 0 && !isSecretPath(file));
  const sections: string[] = [];

  if (files.length > 0) {
    const shown = files.slice(0, maxFiles);
    const more =
      files.length > shown.length
        ? [`… +${files.length - shown.length} more files`]
        : [];

    sections.push(
      `Tracked files (${files.length}):\n${[...shown, ...more].join("\n")}`,
    );
  }

  const manifests = MANIFESTS.filter((name) => files.includes(name));

  if (manifests.length > 0) {
    sections.push(`Build manifests at the root: ${manifests.join(", ")}`);
  }

  const scripts = await readPackageScripts(repoRoot);

  if (scripts !== null) {
    sections.push(`package.json scripts (the real commands):\n${scripts}`);
  }

  for (const name of ROOT_DOCS) {
    if (!files.includes(name)) {
      continue;
    }

    const content = await readCapped(path.join(repoRoot, name), maxDocBytes);

    if (content !== null) {
      sections.push(`${name}:\n${content}`);
    }
  }

  return redactSecrets(sections.join("\n\n")).text;
}

async function readPackageScripts(repoRoot: string): Promise<string | null> {
  try {
    const raw = await readFile(path.join(repoRoot, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { scripts?: Record<string, unknown> };
    const entries = Object.entries(parsed.scripts ?? {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    );

    return entries.length > 0
      ? entries.map(([name, command]) => `- ${name}: ${command}`).join("\n")
      : null;
  } catch {
    return null;
  }
}

async function readCapped(
  filePath: string,
  maxBytes: number,
): Promise<string | null> {
  try {
    const content = (await readFile(filePath, "utf8")).trim();

    if (content.length === 0) {
      return null;
    }

    return content.length > maxBytes
      ? `${content.slice(0, maxBytes)}\n… (truncated)`
      : content;
  } catch {
    return null;
  }
}
