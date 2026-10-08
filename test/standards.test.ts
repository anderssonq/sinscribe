import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkAgentFiles } from "../src/domain/agent-setup.js";
import { checkWrittenFiles, dryRunAgents } from "../src/domain/agents.js";
import {
  createAgentsSystemPrompt,
  createAgentWriteSystemPrompt,
  createContextSystemPrompt,
  createPlanRequirementsSystemPrompt,
} from "../src/domain/prompts.js";
import { buildPlanDocMarkdown } from "../src/domain/plan-docs.js";
import {
  checkDrift,
  collectSources,
  formatDriftReport,
  readSource,
} from "../src/standards/drift.js";
import {
  agentsMdReaders,
  formatStamp,
  STANDARDS,
  trackKey,
} from "../src/standards/registry.js";
import {
  countLines,
  formatStandardsReport,
  parseFrontmatter,
  validateAgainstStandard,
} from "../src/standards/validate.js";
import { initRepo, makeTempDir, removeDir } from "./git-fixture.js";

const SUBAGENT = `---
name: api-backend
description: Use when changing the NestJS API.
---

Owns the API.
`;

describe("standards registry", () => {
  it("gives every standard a source, a verification date and a tracked upstream", () => {
    for (const [id, standard] of Object.entries(STANDARDS)) {
      expect(standard.id).toBe(id);
      expect(standard.canonicalUrl).toMatch(/^https:\/\//u);
      expect(standard.verifiedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
      expect(standard.verifiedAgainst.length).toBeGreaterThan(0);
      expect(standard.track.length).toBeGreaterThan(0);
    }
  });

  it("has a lock entry for every tracked source", () => {
    const lock = JSON.parse(
      readFileSync(new URL("../standards.lock.json", import.meta.url), "utf8"),
    ) as Record<string, string>;

    for (const { key } of collectSources()) {
      expect(lock, key).toHaveProperty([key]);
    }
  });

  it("records how each tool format picks up AGENTS.md", () => {
    expect(agentsMdReaders().map(({ tool }) => tool)).toEqual([
      "Claude Code",
      "Kiro",
      "Cursor",
      "GitHub Copilot",
      "Gemini CLI",
    ]);
  });

  it("builds stable keys and stamps", () => {
    expect(trackKey({ kind: "github-release", repo: "github/spec-kit" })).toBe(
      "github-release:github/spec-kit",
    );
    expect(formatStamp("ears-spec")).toBe(
      `ears-spec@${STANDARDS["ears-spec"].verifiedOn}`,
    );
  });
});

describe("validateAgainstStandard", () => {
  it("accepts a well-formed subagent", () => {
    expect(
      validateAgainstStandard("claude-subagent", SUBAGENT, {
        expectedName: "api-backend",
      }),
    ).toEqual([]);
  });

  it("flags missing frontmatter, missing fields and bad names", () => {
    expect(validateAgainstStandard("claude-subagent", "# hi\n")).toEqual([
      "missing or unparseable YAML frontmatter",
    ]);
    expect(
      validateAgainstStandard("claude-subagent", "---\nname: Bad_Name\n---\nx"),
    ).toEqual([
      'frontmatter "description" is missing or empty',
      'frontmatter name "Bad_Name" must be lowercase kebab-case, at most 64 characters',
    ]);
    expect(
      validateAgainstStandard("claude-subagent", SUBAGENT, {
        expectedName: "web",
      }),
    ).toContain(
      'frontmatter name "api-backend" does not match the file name "web"',
    );
  });

  it("enforces the Agent Skills description limit", () => {
    const skill = `---\nname: a-skill\ndescription: ${"x".repeat(1100)}\n---\nbody`;

    expect(validateAgainstStandard("agent-skill", skill)).toEqual([
      "frontmatter description is 1100 characters, above 1024",
    ]);
  });

  it("warns on line limits for context files", () => {
    expect(validateAgainstStandard("agents-md", "x\n".repeat(100))).toEqual([]);
    expect(validateAgainstStandard("agents-md", "x\n".repeat(150))).toEqual([
      "150 lines, well over the ~80-line budget",
    ]);
    expect(validateAgainstStandard("claude-md", "x\n".repeat(201))).toEqual([
      "201 lines, above the 200-line limit of claude-md",
    ]);
  });

  it("parses frontmatter and counts lines", () => {
    expect(parseFrontmatter(SUBAGENT)).toMatchObject({ name: "api-backend" });
    expect(parseFrontmatter("---\n- a list\n---\n")).toBeNull();
    expect(countLines("a\nb\n\n")).toBe(2);
    expect(countLines("")).toBe(0);
  });

  it("formats a report only when there are warnings", () => {
    expect(formatStandardsReport([{ file: "A.md", warnings: [] }])).toBe("");
    expect(
      formatStandardsReport([{ file: "A.md", warnings: ["too long"] }]),
    ).toBe("\nStandards check:\n  ⚠ A.md: too long");
  });
});

describe("checking written files", () => {
  let dir = "";

  beforeEach(async () => {
    dir = await makeTempDir("sinscribe-standards-");
  });

  afterEach(async () => {
    await removeDir(dir);
  });

  it("wants CLAUDE.md to import AGENTS.md when both are written", async () => {
    await writeFile(path.join(dir, "AGENTS.md"), "# Project\n");
    await writeFile(path.join(dir, "CLAUDE.md"), "# Project copy\n");

    const spec = { name: "agents", target: "both", update: false } as const;

    expect(await checkWrittenFiles(dir, spec)).toEqual([
      {
        file: "CLAUDE.md",
        warnings: [
          'does not import "@AGENTS.md"; the two files may drift apart',
        ],
      },
      { file: "AGENTS.md", warnings: [] },
    ]);

    await writeFile(path.join(dir, "CLAUDE.md"), "@AGENTS.md\n\nExtra.\n");

    expect(
      (await checkWrittenFiles(dir, spec)).flatMap((entry) => entry.warnings),
    ).toEqual([]);
  });

  it("warns when AGENTS.md is written next to a CLAUDE.md that hides it from Claude Code", async () => {
    const spec = { name: "agents", target: "agents", update: false } as const;

    await writeFile(path.join(dir, "AGENTS.md"), "# Project\n");
    await writeFile(path.join(dir, "CLAUDE.md"), "# Old notes\n");

    expect((await checkWrittenFiles(dir, spec)).at(-1)?.file).toBe("CLAUDE.md");

    await writeFile(path.join(dir, "CLAUDE.md"), "@AGENTS.md\n");

    expect(
      (await checkWrittenFiles(dir, spec)).flatMap((entry) => entry.warnings),
    ).toEqual([]);
  });

  it("lists the tools that read AGENTS.md in the dry run, unless only CLAUDE.md is targeted", async () => {
    await initRepo(dir);

    const both = await dryRunAgents(
      { name: "agents", target: "both", update: false },
      dir,
    );

    expect(both).toContain("AGENTS.md is read by:");
    for (const { tool } of agentsMdReaders()) {
      expect(both).toContain(tool);
    }
    expect(
      await dryRunAgents(
        { name: "agents", target: "claude", update: false },
        dir,
      ),
    ).not.toContain("AGENTS.md is read by:");
  });

  it("validates subagent files and reports missing ones", async () => {
    await mkdir(path.join(dir, ".claude", "agents"), { recursive: true });
    await writeFile(
      path.join(dir, ".claude", "agents", "api-backend.md"),
      SUBAGENT,
    );

    expect(await checkAgentFiles(dir, ["api-backend", "web"])).toEqual([
      { file: ".claude/agents/api-backend.md", warnings: [] },
      { file: ".claude/agents/web.md", warnings: ["was not written"] },
    ]);
  });
});

describe("prompts follow the registry", () => {
  it("makes AGENTS.md canonical and CLAUDE.md an importer when writing both", () => {
    const both = createAgentsSystemPrompt("both", false, null);

    expect(both).toContain('must start with the line "@AGENTS.md"');
    expect(both).toContain(
      `under ~${STANDARDS["agents-md"].rules.lineBudget} lines`,
    );
    expect(both).not.toContain("write both fully");
    expect(createAgentsSystemPrompt("claude", false, null)).not.toContain(
      "@AGENTS.md",
    );
  });

  it("no longer pins a model in subagent definitions", () => {
    const prompt = createAgentWriteSystemPrompt(
      {
        create: [{ id: "a", label: "A", role: "r" }],
        update: [],
        stack: [],
        answers: [],
      },
      null,
    );

    expect(prompt).not.toContain("model: sonnet");
    expect(prompt).toContain('Do not add a "model" field');
    expect(prompt).toContain("Claude Code subagent");
  });

  it("names EARS in the requirements prompt", () => {
    expect(createPlanRequirementsSystemPrompt({}, null)).toContain(
      "EARS notation",
    );
  });

  it("keeps the context brief read-only and shaped per format", () => {
    const md = createContextSystemPrompt("md", null);

    expect(md).toContain("Do not write or modify any files");
    expect(md).toContain("## Notes for agents");
    expect(createContextSystemPrompt("json", null)).toContain(
      "single JSON object",
    );
  });

  it("stamps plan documents with the standards they follow", () => {
    const doc = buildPlanDocMarkdown({
      stage: "requirements",
      branch: "feat/x",
      feature: "X",
      body: "## Objective & users\nx",
      generatedAt: new Date("2026-10-08T00:00:00Z"),
    });

    expect(doc.split("\n")[0]).toContain(
      `standards: ${formatStamp("ears-spec")}, ${formatStamp("spec-kit")}`,
    );
  });
});

describe("drift detection", () => {
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200 });

  it("reads each kind of source", async () => {
    expect(
      await readSource(
        { kind: "github-commit", repo: "o/r", path: "docs/x.md" },
        (url) => {
          expect(url).toBe(
            "https://api.github.com/repos/o/r/commits?per_page=1&path=docs%2Fx.md",
          );

          return Promise.resolve(json([{ sha: "abcdef1234567890" }]));
        },
      ),
    ).toBe("abcdef123456");
    expect(
      await readSource({ kind: "github-release", repo: "o/r" }, () =>
        Promise.resolve(json({ tag_name: "v1.2.3" })),
      ),
    ).toBe("v1.2.3");

    const page = (text: string) =>
      readSource({ kind: "page", url: "https://x/y.md" }, () =>
        Promise.resolve(new Response(text)),
      );

    expect(await page("# A  \r\nbody\n")).toBe(await page("# A\nbody"));
    expect(await page("# A\nbody")).not.toBe(await page("# B\nbody"));
  });

  it("reports drift, keeps old values on fetch failures", async () => {
    const sources = collectSources();
    const [first, second] = sources;
    const lock = Object.fromEntries(sources.map(({ key }) => [key, "same"]));

    // Every source answers "same" except the first, which changed, and the
    // second, which fails.
    const result = await checkDrift(lock, (url) => {
      const source = sources.find(({ source: s }) =>
        url.includes(s.kind === "page" ? s.url : s.repo),
      );

      if (source?.key === second.key) {
        return Promise.resolve(new Response("nope", { status: 503 }));
      }

      const value = source?.key === first.key ? "changed" : "same";

      return Promise.resolve(
        source?.source.kind === "github-release"
          ? json({ tag_name: value })
          : source?.source.kind === "github-commit"
            ? json([{ sha: value }])
            : new Response(value),
      );
    });

    expect(result.drift.map((entry) => entry.key)).toContain(first.key);
    expect(result.failures.map((entry) => entry.key)).toEqual([second.key]);
    expect(result.current[second.key]).toBe("same");
    expect(formatDriftReport(result.drift, result.failures)).toContain(
      "## Could not check",
    );
  });

  it("says so when nothing changed", () => {
    expect(formatDriftReport([], [])).toContain("no changes upstream");
  });
});
