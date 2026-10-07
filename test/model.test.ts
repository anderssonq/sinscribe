import { ChatOpenAI } from "@langchain/openai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SINSCRIBE_VERSION } from "../src/constants.js";
import { ChatClaudeCli } from "../src/llm/claude-cli/model.js";
import { ChatKiroCli } from "../src/llm/kiro-cli/model.js";
import {
  resolveModel,
  resolveModelId,
  resolveProviderApiKey,
} from "../src/llm/model.js";
import { createOpencodeSessionId } from "../src/llm/opencode-go.js";

/** Redirect ~/.sinscribe so tests never read or write the real one. */
const FAKE_HOME = vi.hoisted(
  () => `/tmp/sinscribe-model-home-${process.pid}-${Date.now()}`,
);

vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();

  const homedir = (): string => FAKE_HOME;

  return { ...original, default: { ...original, homedir }, homedir };
});

const OPENCODE_KEY = "OPENCODE_API_KEY";
const MODEL_ID_KEY = "SINSCRIBE_MODEL_ID";
const PROVIDER_KEY = "SINSCRIBE_PROVIDER";

describe("resolveProviderApiKey", () => {
  const original = process.env[OPENCODE_KEY];

  beforeEach(() => {
    delete process.env[OPENCODE_KEY];
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env[OPENCODE_KEY];
    } else {
      process.env[OPENCODE_KEY] = original;
    }
  });

  it("throws when there is no override and no env var", () => {
    expect(() => resolveProviderApiKey("opencode-go", null)).toThrow(
      /OPENCODE_API_KEY is required/,
    );
  });

  it("returns the override even with no env var set", () => {
    expect(resolveProviderApiKey("opencode-go", "sk-override")).toBe(
      "sk-override",
    );
  });

  it("falls back to the env var when no override is given", () => {
    process.env[OPENCODE_KEY] = "sk-from-env";

    expect(resolveProviderApiKey("opencode-go", null)).toBe("sk-from-env");
  });

  it("prefers the override over the env var when both are present", () => {
    process.env[OPENCODE_KEY] = "sk-from-env";

    expect(resolveProviderApiKey("opencode-go", "sk-override")).toBe(
      "sk-override",
    );
  });
});

describe("resolveModelId", () => {
  const originalModelId = process.env[MODEL_ID_KEY];
  const originalProvider = process.env[PROVIDER_KEY];

  beforeEach(() => {
    delete process.env[MODEL_ID_KEY];
    delete process.env[PROVIDER_KEY];
  });

  afterEach(() => {
    for (const [key, value] of [
      [MODEL_ID_KEY, originalModelId],
      [PROVIDER_KEY, originalProvider],
    ] as const) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("uses the saved model id for the saved provider", () => {
    process.env[PROVIDER_KEY] = "kiro-cli";
    process.env[MODEL_ID_KEY] = "claude-sonnet-4.5";

    expect(resolveModelId(null, "kiro-cli")).toBe("claude-sonnet-4.5");
  });

  it("ignores another provider's saved model id", () => {
    process.env[PROVIDER_KEY] = "opencode-go";
    process.env[MODEL_ID_KEY] = "glm-5.2";

    expect(resolveModelId(null, "kiro-cli")).toBe("auto");
    expect(resolveModelId(null, "claude-cli")).toBe("sonnet");
  });

  it("accepts ids outside the provider's listed options", () => {
    expect(resolveModelId("claude-opus-5-5", "claude-cli")).toBe(
      "claude-opus-5-5",
    );
    expect(resolveModelId("qwen3-coder-480b", "kiro-cli")).toBe(
      "qwen3-coder-480b",
    );
  });

  it("uses the explicit override when given", () => {
    expect(resolveModelId("glm-5.2", "opencode-go")).toBe("glm-5.2");
  });

  it("falls back to the provider default when no override is given", () => {
    expect(resolveModelId(null, "opencode-go")).toBe("kimi-k2.7-code");
  });

  it("throws for an invalid model id", () => {
    expect(() => resolveModelId("bad id with spaces", "opencode-go")).toThrow(
      /Invalid model ID/,
    );
  });
});

function headersOf(model: unknown): Record<string, string> {
  expect(model).toBeInstanceOf(ChatOpenAI);

  return ((model as ChatOpenAI).clientConfig.defaultHeaders ?? {}) as Record<
    string,
    string
  >;
}

describe("OpenCode Go request headers", () => {
  // Without x-opencode-session, OpenCode Go answers 400 "Request is missing
  // x-opencode-session and cannot be routed efficiently".
  it("identifies sinscribe and sends a session id", async () => {
    const { model } = await resolveModel({
      provider: "opencode-go",
      apiKey: "sk-test",
    });
    const headers = headersOf(model);

    expect(headers["x-opencode-session"]).toMatch(/^ses_[0-9a-f]{26}$/u);
    expect(headers["x-opencode-client"]).toBe("sinscribe");
    expect(headers["User-Agent"]).toBe(`sinscribe/${SINSCRIBE_VERSION}`);
  });

  it("uses the caller's session id verbatim so chat turns share it", async () => {
    const { model } = await resolveModel({
      provider: "opencode-go",
      apiKey: "sk-test",
      sessionId: "sinscribe-thread-1",
    });

    expect(headersOf(model)["x-opencode-session"]).toBe("sinscribe-thread-1");
  });

  it("mints a new session per model when none is given", async () => {
    const first = await resolveModel({ provider: "opencode-go", apiKey: "k" });
    const second = await resolveModel({ provider: "opencode-go", apiKey: "k" });

    expect(headersOf(first.model)["x-opencode-session"]).not.toBe(
      headersOf(second.model)["x-opencode-session"],
    );
  });

  it("keeps x-opencode-* headers away from other providers", async () => {
    const { model } = await resolveModel({ provider: "openai", apiKey: "k" });

    expect(headersOf(model)).not.toHaveProperty("x-opencode-session");
  });

  it("session ids fit OpenCode's 30-char tracking window", () => {
    expect(createOpencodeSessionId()).toHaveLength(30);
  });
});

describe("local-cli providers", () => {
  it("routes claude-cli to the Claude Code CLI model", async () => {
    const { model, modelId } = await resolveModel({
      provider: "claude-cli",
      modelId: "haiku",
    });

    expect(model).toBeInstanceOf(ChatClaudeCli);
    expect((model as ChatClaudeCli).command).toBe("claude");
    expect(modelId).toBe("haiku");
  });

  it("still routes kiro-cli to the Kiro CLI model", async () => {
    const { model } = await resolveModel({ provider: "kiro-cli" });

    expect(model).toBeInstanceOf(ChatKiroCli);
  });

  it("hands a custom model id straight to the child CLI", async () => {
    const kiro = await resolveModel({
      provider: "kiro-cli",
      modelId: "claude-sonnet-4.5",
    });
    const claude = await resolveModel({
      provider: "claude-cli",
      modelId: "claude-opus-5-5",
    });

    expect((kiro.model as ChatKiroCli).model).toBe("claude-sonnet-4.5");
    expect((claude.model as ChatClaudeCli).model).toBe("claude-opus-5-5");
  });
});
