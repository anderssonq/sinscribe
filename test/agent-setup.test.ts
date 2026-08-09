import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AGENT_DIR,
  agentFilePath,
  agentVirtualPath,
  countAgentFiles,
  findExistingAgentFiles,
  normalizeAgentId,
  parseAgentPlan,
} from "../src/domain/agent-setup.js";
import { makeTempDir, removeDir } from "./git-fixture.js";

function plan(body: unknown): string {
  return JSON.stringify(body);
}

const VALID = {
  stack: ["NestJS", "TypeScript", "pnpm"],
  roster: [
    { id: "nestjs-backend", label: "NestJS backend", role: "Owns the API." },
    { id: "commit-writer", label: "Commits", role: "Writes commit messages." },
  ],
  questions: [
    {
      id: "goals",
      question: "What is the product goal?",
      why: "aim",
      multiline: true,
    },
  ],
};

describe("normalizeAgentId", () => {
  it("slugs a human label into a file-safe id", () => {
    expect(normalizeAgentId("NestJS Backend")).toBe("nestjs-backend");
    expect(normalizeAgentId("  React_Frontend  ")).toBe("react-frontend");
    expect(normalizeAgentId("api")).toBe("api");
  });

  // The id becomes a path under .claude/agents, so this is the boundary that
  // stops a malicious or sloppy plan from writing anywhere else.
  it("cannot produce a path that escapes the agents directory", () => {
    for (const id of [
      "../../../etc/passwd",
      "/etc/passwd",
      "..",
      "../secrets",
      "a/b/c",
      "~/.ssh/config",
      ".env",
      "....//....//x",
    ]) {
      const slug = normalizeAgentId(id);

      if (slug === null) {
        continue;
      }

      expect(slug).toMatch(/^[a-z][a-z0-9-]*$/u);
      expect(slug).not.toContain("/");
      expect(slug).not.toContain(".");

      const resolved = path.resolve(agentFilePath("/repo", slug));

      expect(resolved.startsWith(path.resolve("/repo", AGENT_DIR))).toBe(true);
    }
  });

  it("rejects ids with nothing usable left", () => {
    expect(normalizeAgentId("")).toBeNull();
    expect(normalizeAgentId("///")).toBeNull();
    expect(normalizeAgentId("123")).toBeNull();
    expect(normalizeAgentId("9-lives")).toBeNull();
    expect(normalizeAgentId(null)).toBeNull();
    expect(normalizeAgentId(42)).toBeNull();
  });

  it("caps a very long id", () => {
    expect(normalizeAgentId("a".repeat(200))?.length).toBeLessThanOrEqual(40);
  });
});

describe("parseAgentPlan", () => {
  it("parses a well-formed plan", () => {
    const parsed = parseAgentPlan(plan(VALID));

    expect(parsed.stack).toEqual(["NestJS", "TypeScript", "pnpm"]);
    expect(parsed.roster.map((agent) => agent.id)).toEqual([
      "nestjs-backend",
      "commit-writer",
    ]);
    expect(parsed.questions[0].question).toBe("What is the product goal?");
    expect(parsed.questions[0].multiline).toBe(true);
  });

  it("reads a plan wrapped in a fence or prose", () => {
    const fenced = "Here you go:\n```json\n" + plan(VALID) + "\n```\nDone.";

    expect(parseAgentPlan(fenced).roster).toHaveLength(2);
  });

  it("accepts 'agents' as an alias for 'roster'", () => {
    const parsed = parseAgentPlan(
      plan({ stack: [], agents: VALID.roster, questions: [] }),
    );

    expect(parsed.roster).toHaveLength(2);
  });

  it("drops malformed roster entries instead of throwing", () => {
    const parsed = parseAgentPlan(
      plan({
        roster: [
          ...VALID.roster,
          null,
          "not an object",
          { id: "no-role" },
          { role: "no id" },
          { id: "!!!", role: "unusable id" },
          { id: "nestjs-backend", role: "duplicate" },
        ],
      }),
    );

    expect(parsed.roster.map((agent) => agent.id)).toEqual([
      "nestjs-backend",
      "commit-writer",
    ]);
  });

  it("caps the roster and the questions", () => {
    const parsed = parseAgentPlan(
      plan({
        roster: Array.from({ length: 30 }, (_, index) => ({
          id: `agent-${index}`,
          role: "role",
        })),
        questions: Array.from({ length: 30 }, (_, index) => ({
          id: `q-${index}`,
          question: `question ${index}`,
        })),
      }),
    );

    expect(parsed.roster).toHaveLength(8);
    expect(parsed.questions).toHaveLength(6);
  });

  it("falls back to the id for a missing label", () => {
    const parsed = parseAgentPlan(
      plan({ roster: [{ id: "test-runner", role: "Runs tests." }] }),
    );

    expect(parsed.roster[0].label).toBe("test-runner");
  });

  it("keeps a question multi-line unless explicitly told otherwise", () => {
    const parsed = parseAgentPlan(
      plan({
        roster: VALID.roster,
        questions: [
          { question: "a" },
          { question: "b", multiline: false },
          { question: "c", multiline: "yes" },
        ],
      }),
    );

    expect(parsed.questions.map((entry) => entry.multiline)).toEqual([
      true,
      false,
      true,
    ]);
  });

  it("tolerates wrong types for every field", () => {
    const parsed = parseAgentPlan(
      plan({ stack: "not an array", roster: VALID.roster, questions: 7 }),
    );

    expect(parsed.stack).toEqual([]);
    expect(parsed.questions).toEqual([]);
  });

  it("throws when nothing usable survives", () => {
    expect(() => parseAgentPlan(plan({ roster: [] }))).toThrow(
      /did not propose/u,
    );
    expect(() => parseAgentPlan(plan({ stack: ["ts"] }))).toThrow(
      /did not propose/u,
    );
  });

  it("throws on output that is not JSON at all", () => {
    expect(() =>
      parseAgentPlan("I could not analyze this repository."),
    ).toThrow();
  });
});

describe("agent file paths", () => {
  let dir = "";

  beforeEach(async () => {
    dir = await makeTempDir("sinscribe-agent-setup-");
  });

  afterEach(async () => {
    await removeDir(dir);
  });

  it("addresses the same file on disk and virtually", () => {
    expect(agentFilePath("/repo", "api")).toBe("/repo/.claude/agents/api.md");
    expect(agentVirtualPath("api")).toBe("/.claude/agents/api.md");
  });

  it("reports which definitions already exist", async () => {
    await mkdir(path.join(dir, AGENT_DIR), { recursive: true });
    await writeFile(agentFilePath(dir, "api"), "---\nname: api\n---\n");

    expect(await findExistingAgentFiles(dir, ["api", "web", "tests"])).toEqual([
      "api",
    ]);
  });

  it("counts only markdown definitions, and zero when the directory is absent", async () => {
    expect(await countAgentFiles(dir)).toBe(0);

    await mkdir(path.join(dir, AGENT_DIR), { recursive: true });
    await writeFile(agentFilePath(dir, "api"), "x");
    await writeFile(agentFilePath(dir, "web"), "x");
    await writeFile(path.join(dir, AGENT_DIR, "notes.txt"), "x");

    expect(await countAgentFiles(dir)).toBe(2);
  });
});
