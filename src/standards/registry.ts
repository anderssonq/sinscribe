/**
 * The external standards every agent-facing artifact Sinscribe writes is
 * based on: where each format is defined, what we checked it against and
 * when, and how to notice that it changed upstream.
 *
 * This is the single answer to "what is this output based on?". Prompts read
 * their concrete limits from here instead of repeating literals, the validator
 * checks written files against the same rules, and `pnpm standards:check`
 * diffs the `track` sources against standards.lock.json so a moving standard
 * raises an issue instead of silently going stale (see DESIGN.md §5d).
 *
 * Updating an entry: re-read the source, adjust `rules` and the prompts that
 * use them, then bump `verifiedOn`/`verifiedAgainst` and refresh the lock with
 * `pnpm standards:check --update` in the same change.
 */

/** How to detect that a source changed. */
export type TrackSource =
  /** Latest commit on the default branch, optionally limited to one path. */
  | { kind: "github-commit"; repo: string; path?: string }
  /** Tag of the latest GitHub release. */
  | { kind: "github-release"; repo: string }
  /** Content hash of a page; prefer a .md rendition, HTML pages are noisier. */
  | { kind: "page"; url: string };

export type FrontmatterRules = {
  required: string[];
  /** Fields the target ignores or rejects; their presence is a warning. */
  discouraged?: string[];
  name?: { pattern: RegExp; maxLength: number };
  description?: { maxLength: number };
};

export type StandardRules = {
  /** The length Sinscribe asks the model for — a house choice, not the spec's. */
  lineBudget?: number;
  /** Above this the target's own guidance says the file is too long. */
  maxLines?: number;
  frontmatter?: FrontmatterRules;
};

export type StandardId =
  | "agents-md"
  | "claude-md"
  | "claude-subagent"
  | "agent-skill"
  | "ears-spec"
  | "spec-kit"
  | "llms-txt"
  | "claude-code-best-practices"
  | "kiro-steering"
  | "cursor-rules"
  | "copilot-instructions"
  | "gemini-md";

export type Standard = {
  id: StandardId;
  title: string;
  canonicalUrl: string;
  /** Sinscribe commands whose output follows this standard; empty = tracked only. */
  usedBy: string[];
  /** ISO date the rules below were last checked against the source. */
  verifiedOn: string;
  /** Version, tag or commit the check was made against. */
  verifiedAgainst: string;
  track: TrackSource[];
  rules: StandardRules;
  /**
   * For a tool's own instruction format: how that tool picks up AGENTS.md.
   * This is why Sinscribe writes AGENTS.md instead of one file per tool — if a
   * tracked page changes, re-check this line first.
   */
  readsAgentsMd?: string;
};

/** Kebab-case slug, the shape both Claude Code and the Agent Skills spec require. */
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/u;

export const STANDARDS: Record<StandardId, Standard> = {
  "agents-md": {
    id: "agents-md",
    title: "AGENTS.md (Agentic AI Foundation / Linux Foundation)",
    canonicalUrl: "https://agents.md/",
    usedBy: ["agents"],
    verifiedOn: "2026-10-08",
    verifiedAgainst: "agentsmd/agents.md@d001185",
    track: [{ kind: "github-commit", repo: "agentsmd/agents.md" }],
    // Plain markdown, no required fields; nearest file in the tree wins.
    // Codex caps the combined size at 32 KiB, so short is also portable.
    rules: { lineBudget: 80, maxLines: 200 },
  },
  "claude-md": {
    id: "claude-md",
    title: "CLAUDE.md project memory (Claude Code)",
    canonicalUrl: "https://code.claude.com/docs/en/memory",
    usedBy: ["agents"],
    verifiedOn: "2026-10-08",
    verifiedAgainst: "claude-code v2.1.294",
    // Claude Code reads AGENTS.md natively since v2.1.277 only when no
    // CLAUDE.md exists; with both, CLAUDE.md imports it with `@AGENTS.md`.
    track: [{ kind: "page", url: "https://code.claude.com/docs/en/memory.md" }],
    rules: { lineBudget: 80, maxLines: 200 },
    readsAgentsMd:
      "only when no CLAUDE.md exists (v2.1.277+); otherwise via @AGENTS.md",
  },
  "claude-subagent": {
    id: "claude-subagent",
    title: "Claude Code subagent definition (.claude/agents/*.md)",
    canonicalUrl: "https://code.claude.com/docs/en/sub-agents",
    usedBy: ["agent-setup"],
    verifiedOn: "2026-10-08",
    verifiedAgainst: "claude-code v2.1.294",
    track: [
      { kind: "page", url: "https://code.claude.com/docs/en/sub-agents.md" },
    ],
    rules: {
      lineBudget: 60,
      frontmatter: {
        required: ["name", "description"],
        name: { pattern: SLUG, maxLength: 64 },
      },
    },
  },
  "agent-skill": {
    id: "agent-skill",
    title: "Agent Skills open standard (SKILL.md)",
    canonicalUrl: "https://agentskills.io/specification",
    usedBy: [],
    verifiedOn: "2026-10-08",
    verifiedAgainst: "agentskills/agentskills@217be54",
    track: [
      {
        kind: "github-commit",
        repo: "agentskills/agentskills",
        path: "docs/specification.mdx",
      },
    ],
    rules: {
      maxLines: 500,
      frontmatter: {
        required: ["name", "description"],
        name: { pattern: SLUG, maxLength: 64 },
        description: { maxLength: 1024 },
      },
    },
  },
  "ears-spec": {
    id: "ears-spec",
    title: "Kiro specs: EARS requirements → design → tasks",
    canonicalUrl: "https://kiro.dev/docs/specs/",
    usedBy: ["plan"],
    verifiedOn: "2026-10-08",
    verifiedAgainst: "kiro.dev/docs/specs (2026-10-08)",
    track: [{ kind: "page", url: "https://kiro.dev/docs/specs/" }],
    rules: {},
  },
  "spec-kit": {
    id: "spec-kit",
    title: "GitHub spec-kit (spec-driven development)",
    canonicalUrl: "https://github.com/github/spec-kit",
    usedBy: ["plan"],
    verifiedOn: "2026-10-08",
    verifiedAgainst: "v1.1.2",
    track: [{ kind: "github-release", repo: "github/spec-kit" }],
    rules: {},
  },
  "llms-txt": {
    id: "llms-txt",
    title: "llms.txt",
    canonicalUrl: "https://llmstxt.org/",
    usedBy: [],
    verifiedOn: "2026-10-08",
    verifiedAgainst: "v2",
    track: [{ kind: "page", url: "https://llmstxt.org/index.md" }],
    rules: {},
  },
  "claude-code-best-practices": {
    id: "claude-code-best-practices",
    title: "Claude Code best practices (writing agent instructions)",
    canonicalUrl: "https://code.claude.com/docs/en/best-practices",
    usedBy: ["agents", "agent-setup", "prompt"],
    verifiedOn: "2026-10-08",
    verifiedAgainst: "claude-code v2.1.294",
    track: [
      {
        kind: "page",
        url: "https://code.claude.com/docs/en/best-practices.md",
      },
    ],
    rules: {},
  },
  "kiro-steering": {
    id: "kiro-steering",
    title: "Kiro steering files (.kiro/steering/*.md)",
    canonicalUrl: "https://kiro.dev/docs/steering/",
    usedBy: [],
    verifiedOn: "2026-10-08",
    verifiedAgainst: "kiro.dev/docs/steering (2026-10-08)",
    track: [{ kind: "page", url: "https://kiro.dev/docs/steering/" }],
    rules: {},
    readsAgentsMd: "always included, like an inclusion: always steering file",
  },
  "cursor-rules": {
    id: "cursor-rules",
    title: "Cursor rules (.cursor/rules/*.mdc)",
    canonicalUrl: "https://cursor.com/docs/context/rules",
    usedBy: [],
    verifiedOn: "2026-10-08",
    verifiedAgainst: "cursor.com/docs/context/rules (2026-10-08)",
    track: [{ kind: "page", url: "https://cursor.com/docs/context/rules" }],
    rules: {},
    readsAgentsMd: "root and nested AGENTS.md; the most specific file wins",
  },
  "copilot-instructions": {
    id: "copilot-instructions",
    title: "GitHub Copilot custom instructions",
    canonicalUrl:
      "https://docs.github.com/en/copilot/how-tos/configure-custom-instructions/add-repository-instructions",
    usedBy: [],
    verifiedOn: "2026-10-08",
    verifiedAgainst: "docs.github.com (2026-10-08)",
    track: [
      {
        kind: "page",
        url: "https://docs.github.com/api/article/body?pathname=/en/copilot/how-tos/configure-custom-instructions/add-repository-instructions",
      },
    ],
    rules: {},
    readsAgentsMd: "AGENTS.md anywhere in the tree; the nearest one wins",
  },
  "gemini-md": {
    id: "gemini-md",
    title: "Gemini CLI context files (GEMINI.md)",
    canonicalUrl: "https://geminicli.com/docs/cli/gemini-md/",
    usedBy: [],
    verifiedOn: "2026-10-08",
    verifiedAgainst: "geminicli.com/docs/cli/gemini-md (2026-10-08)",
    track: [
      { kind: "page", url: "https://geminicli.com/docs/cli/gemini-md.md" },
    ],
    rules: {},
    readsAgentsMd:
      'only when .gemini/settings.json lists it in "context.fileName"',
  },
};

/** Stable key for a source, used in standards.lock.json. */
export function trackKey(source: TrackSource): string {
  switch (source.kind) {
    case "github-commit":
      return `github-commit:${source.repo}${source.path ? `:${source.path}` : ""}`;
    case "github-release":
      return `github-release:${source.repo}`;
    case "page":
      return `page:${source.url}`;
  }
}

/** Display name per tool format, for "who reads AGENTS.md" summaries. */
const READER_NAMES: Partial<Record<StandardId, string>> = {
  "claude-md": "Claude Code",
  "kiro-steering": "Kiro",
  "cursor-rules": "Cursor",
  "copilot-instructions": "GitHub Copilot",
  "gemini-md": "Gemini CLI",
};

/** Which agents pick up AGENTS.md, and how — from the registry, never hard-coded elsewhere. */
export function agentsMdReaders(): Array<{ tool: string; how: string }> {
  return Object.values(STANDARDS).flatMap((standard) =>
    standard.readsAgentsMd === undefined
      ? []
      : [
          {
            tool: READER_NAMES[standard.id] ?? standard.title,
            how: standard.readsAgentsMd,
          },
        ],
  );
}

/** "<id>@<verifiedOn>", the tag a generated file carries in its header. */
export function formatStamp(id: StandardId): string {
  return `${id}@${STANDARDS[id].verifiedOn}`;
}
