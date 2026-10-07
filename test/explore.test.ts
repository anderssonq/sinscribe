import { beforeEach, describe, expect, it, vi } from "vitest";
import { CliError } from "../src/domain/errors.js";
import { ChatClaudeCli } from "../src/llm/claude-cli/model.js";
import type { RunEvent } from "../src/llm/events.js";

const mocks = vi.hoisted(() => ({
  resolveModel: vi.fn(),
  runSingleShot: vi.fn(),
  runReadOnlyAgent: vi.fn(),
  runClaudeExplore: vi.fn(),
  runKiroExplore: vi.fn(),
}));

vi.mock("../src/llm/model.js", () => ({ resolveModel: mocks.resolveModel }));
vi.mock("../src/llm/single-shot.js", () => ({
  runSingleShot: mocks.runSingleShot,
}));
vi.mock("../src/llm/agent.js", () => ({
  runReadOnlyAgent: mocks.runReadOnlyAgent,
}));
vi.mock("../src/llm/claude-cli/explore.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../src/llm/claude-cli/explore.js")>();

  return { ...original, runClaudeExplore: mocks.runClaudeExplore };
});

vi.mock("../src/llm/kiro-cli/explore.js", () => ({
  runKiroExplore: mocks.runKiroExplore,
}));

const { runExplore, EXPLORE_CLAUSE } = await import("../src/llm/explore.js");
const { ChatKiroCli } = await import("../src/llm/kiro-cli/model.js");
const { ExploreUnsupportedError } =
  await import("../src/llm/claude-cli/explore.js");
const { buildReadOnlyPermissions } = await vi.importActual<
  typeof import("../src/llm/agent.js")
>("../src/llm/agent.js");

function options(overrides: Record<string, unknown> = {}) {
  return {
    repoRoot: "/repo",
    explore: true,
    fallbackContext: vi.fn(() => Promise.resolve("BRIEF")),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runSingleShot.mockResolvedValue({ text: "SINGLE", modelId: "m" });
});

describe("runExplore routing", () => {
  it("--no-explore goes single-shot with the repo brief, never resolving tools", async () => {
    const opts = options({ explore: false });
    const result = await runExplore("SYS", "USER", opts);

    expect(result).toMatchObject({
      text: "SINGLE",
      mode: "single-shot",
      filesRead: [],
      fallbackReason: "--no-explore",
    });
    expect(mocks.resolveModel).not.toHaveBeenCalled();
    expect(mocks.runSingleShot.mock.calls[0][0]).toBe("SYS");
    expect(mocks.runSingleShot.mock.calls[0][1]).toContain("USER");
    expect(mocks.runSingleShot.mock.calls[0][1]).toContain("BRIEF");
  });

  it("claude-cli explores read-only with the explore clause appended", async () => {
    mocks.resolveModel.mockResolvedValue({
      provider: "claude-cli",
      modelId: "sonnet",
      model: new ChatClaudeCli({ model: "sonnet", command: "claude" }),
    });
    mocks.runClaudeExplore.mockResolvedValue({
      text: "DOC",
      filesRead: ["src/a.ts"],
    });

    const opts = options();
    const result = await runExplore("SYS", "USER", opts);

    expect(result).toEqual({
      text: "DOC",
      modelId: "sonnet",
      mode: "claude-cli-readonly",
      filesRead: ["src/a.ts"],
      fallbackReason: null,
    });
    expect(mocks.runClaudeExplore.mock.calls[0][0]).toMatchObject({
      command: "claude",
      model: "sonnet",
      repoRoot: "/repo",
      userPrompt: "USER",
      systemPrompt: `SYS\n${EXPLORE_CLAUSE}`,
    });
    expect(opts.fallbackContext).not.toHaveBeenCalled();
  });

  it("kiro-cli explores through its read-only agent", async () => {
    mocks.resolveModel.mockResolvedValue({
      provider: "kiro-cli",
      modelId: "auto",
      model: new ChatKiroCli({ model: "auto", command: "kiro-cli" }),
    });
    mocks.runKiroExplore.mockResolvedValue({
      text: "DOC",
      filesRead: ["docs/report.md"],
    });

    const opts = options();
    const result = await runExplore("SYS", "USER", opts);

    expect(result).toEqual({
      text: "DOC",
      modelId: "auto",
      mode: "kiro-cli-readonly",
      filesRead: ["docs/report.md"],
      fallbackReason: null,
    });
    expect(mocks.runKiroExplore.mock.calls[0][0]).toMatchObject({
      command: "kiro-cli",
      model: "auto",
      repoRoot: "/repo",
      systemPrompt: `SYS\n${EXPLORE_CLAUSE}`,
    });
    expect(opts.fallbackContext).not.toHaveBeenCalled();
  });

  it("falls back to single-shot when the claude CLI is too old", async () => {
    mocks.resolveModel.mockResolvedValue({
      provider: "claude-cli",
      modelId: "sonnet",
      model: new ChatClaudeCli({ model: "sonnet", command: "claude" }),
    });
    mocks.runClaudeExplore.mockRejectedValue(
      new ExploreUnsupportedError("too old"),
    );

    const events: RunEvent[] = [];
    const result = await runExplore(
      "SYS",
      "USER",
      options({ onEvent: (event: RunEvent) => events.push(event) }),
    );

    expect(result.mode).toBe("single-shot");
    expect(result.fallbackReason).toBe("too old");
    expect(events).toContainEqual({ type: "status", message: "too old" });
  });

  it("does not hide real failures behind a fallback", async () => {
    mocks.resolveModel.mockResolvedValue({
      provider: "claude-cli",
      modelId: "sonnet",
      model: new ChatClaudeCli({ model: "sonnet", command: "claude" }),
    });
    mocks.runClaudeExplore.mockRejectedValue(new CliError("Not logged in"));

    await expect(runExplore("SYS", "USER", options())).rejects.toThrow(
      "Not logged in",
    );
    expect(mocks.runSingleShot).not.toHaveBeenCalled();
  });

  it("api-key providers explore through the read-only agent", async () => {
    mocks.resolveModel.mockResolvedValue({
      provider: "openrouter",
      modelId: "glm",
      model: {},
    });
    mocks.runReadOnlyAgent.mockResolvedValue({
      text: "DOC",
      modelId: "glm",
      filesRead: ["README.md"],
    });

    const result = await runExplore("SYS", "USER", options());

    expect(result.mode).toBe("agent-readonly");
    expect(mocks.runReadOnlyAgent.mock.calls[0][2]).toBe("/repo");
  });

  it("kiro-cli stays single-shot until its read-only agent is verified", async () => {
    mocks.resolveModel.mockResolvedValue({
      provider: "kiro-cli",
      modelId: "auto",
      model: {},
    });

    const result = await runExplore("SYS", "USER", options());

    expect(result.mode).toBe("single-shot");
    expect(result.fallbackReason).toMatch(/cannot explore/u);
  });
});

describe("buildReadOnlyPermissions", () => {
  it("denies every write first, then secret reads, at root and any depth", () => {
    const [writes, reads] = buildReadOnlyPermissions();

    expect(writes).toEqual({
      operations: ["write"],
      paths: ["/**"],
      mode: "deny",
    });
    expect(reads.operations).toEqual(["read"]);
    expect(reads.paths).toEqual(
      expect.arrayContaining(["/.env", "/**/.env", "/.git/**", "/**/*.pem"]),
    );
    expect(reads.paths.every((p) => p.startsWith("/"))).toBe(true);
  });
});
