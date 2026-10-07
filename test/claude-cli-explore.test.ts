import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { CliError } from "../src/domain/errors.js";
import { buildClaudeArgs } from "../src/llm/claude-cli/model.js";
import {
  buildClaudeExploreArgs,
  buildClaudeExploreSettings,
  ExploreUnsupportedError,
  runClaudeExplore,
} from "../src/llm/claude-cli/explore.js";
import type { RunEvent } from "../src/llm/events.js";
import { makeTempDir, removeDir } from "./git-fixture.js";

const FAKE_CLAUDE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "fake-claude-cli.mjs",
);

let repoRoot: string;

beforeAll(async () => {
  // realpath: the child's process.cwd() is resolved (/private/var on macOS).
  repoRoot = await realpath(await makeTempDir("sinscribe-explore-"));
  await mkdir(path.join(repoRoot, "src"));
  // The fake only switches to explore output with FAKE_CLAUDE_TOOLS set.
  process.env.FAKE_CLAUDE_TOOLS = "1";
});

afterAll(async () => {
  delete process.env.FAKE_CLAUDE_TOOLS;
  await removeDir(repoRoot);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function explore(
  events: RunEvent[] = [],
): ReturnType<typeof runClaudeExplore> {
  return runClaudeExplore({
    command: FAKE_CLAUDE,
    model: "haiku",
    systemPrompt: "SYS",
    userPrompt: "write the design",
    repoRoot,
    onEvent: (event) => events.push(event),
  });
}

function argvOf(text: string): string[] {
  const line = text.split("\n").find((l) => l.startsWith("ARGV:")) ?? "";

  return JSON.parse(line.slice("ARGV:".length)) as string[];
}

describe("buildClaudeExploreArgs", () => {
  it("is read-only, repo-confined, and never prompts", () => {
    const args = buildClaudeExploreArgs("sonnet", "SYS", { maxTurns: 12 });
    const after = (flag: string): string | undefined =>
      args[args.indexOf(flag) + 1];

    expect(args).toContain("--restricted");
    expect(after("--tools")).toBe("Read,Glob,Grep");
    expect(after("--allowedTools")).toBe("Read,Glob,Grep");
    expect(after("--permission-mode")).toBe("dontAsk");
    expect(after("--permission-prompts")).toBe("none");
    expect(after("--max-turns")).toBe("12");
    expect(after("--system-prompt")).toBe("SYS");
    expect(args).toContain("--strict-mcp-config");
    expect(JSON.parse(after("--settings") ?? "{}")).toEqual(
      buildClaudeExploreSettings(),
    );
  });

  it("denies secret paths in both spellings and disables hooks", () => {
    const settings = buildClaudeExploreSettings() as {
      permissions: { deny: string[] };
      disableAllHooks: boolean;
    };

    expect(settings.permissions.deny).toEqual(
      expect.arrayContaining([
        "Read(**/.env)",
        "Read(./.env)",
        "Read(**/*.pem)",
        "Read(./.git/**)",
      ]),
    );
    expect(settings.disableAllHooks).toBe(true);
  });

  it("leaves the single-shot contract untouched", () => {
    const args = buildClaudeArgs("sonnet", "SYS");

    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args).not.toContain("--restricted");
  });
});

describe("runClaudeExplore", () => {
  it("runs in the repo root with secrets scrubbed and returns only the result", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-should-not-leak");

    const result = await explore();

    expect(result.text.startsWith("FINAL")).toBe(true);
    expect(result.text).not.toContain("Let me look around");
    expect(result.text).toContain(`CWD:${repoRoot}`);
    expect(result.text).toContain("KEY:<unset>");
    expect(result.text).toContain("STDIN:write the design");
    expect(argvOf(result.text)).toContain("--restricted");
  });

  it("emits tool events with repo-relative calls and tracks files read", async () => {
    const events: RunEvent[] = [];
    const result = await explore(events);

    expect(
      events
        .filter((event) => event.type === "tool_start")
        .map((event) => (event.type === "tool_start" ? event.call : "")),
    ).toEqual([
      "Glob **/*.ts",
      "Read src/a.ts",
      "Read .env",
      'Grep "TODO" in src',
    ]);
    expect(
      events.find((event) => event.type === "tool_end" && event.id === "t3"),
    ).toMatchObject({ status: "error", name: "Read" });
    // Subagent traffic (parent_tool_use_id set) is dropped.
    expect(events.some((event) => "id" in event && event.id === "t9")).toBe(
      false,
    );
    expect(result.filesRead).toEqual(["src/a.ts", ".env"]);
  });

  it("reports an exhausted turn budget clearly", async () => {
    vi.stubEnv("FAKE_CLAUDE_MAX_TURNS", "1");

    await expect(explore()).rejects.toThrow(/exploration turns/u);
  });

  it("flags an old CLI as unsupported so the caller can fall back", async () => {
    vi.stubEnv("FAKE_CLAUDE_UNKNOWN_OPTION", "1");

    const failure = await explore().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ExploreUnsupportedError);
    expect(failure).toBeInstanceOf(CliError);
  });
});
