import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL_ID,
  DEFAULT_PROVIDER,
  getDefaultModelId,
  getProviderApiKeyEnvKey,
  getProviderAuthKind,
  getProviderCommand,
  getProviderLabel,
  getProviderModelOptions,
  isValidModelId,
  isValidProvider,
  OPENCODE_GO_API_KEY_ENV_KEY,
  OPENCODE_GO_BASE_URL,
  PROVIDER_CONFIGS,
  providerSupportsAgentic,
  resolveConfiguredProvider,
  resolveProviderBaseUrl,
  SELECTABLE_PROVIDERS,
  SINSCRIBE_VERSION,
  type SinscribeProvider,
} from "../src/constants.js";
import { resolveModelId } from "../src/llm/model.js";

describe("opencode-go provider config", () => {
  const config = PROVIDER_CONFIGS["opencode-go"];

  it("resolves the OpenCode Go API key env var", () => {
    expect(OPENCODE_GO_API_KEY_ENV_KEY).toBe("OPENCODE_API_KEY");
    expect(config.authKind === "api-key" ? config.apiKeyEnvKey : null).toBe(
      "OPENCODE_API_KEY",
    );
    expect(getProviderApiKeyEnvKey("opencode-go")).toBe("OPENCODE_API_KEY");
  });

  it("pins the OpenAI-compatible base URL and does not require an override", () => {
    expect(OPENCODE_GO_BASE_URL).toBe("https://opencode.ai/zen/go/v1");
    expect(config.baseURL).toBe("https://opencode.ai/zen/go/v1");
    // No baseUrlEnvKey / requiresBaseUrl: the endpoint is fixed like baseten.
    expect(config.baseUrlEnvKey).toBeUndefined();
    expect(config.requiresBaseUrl).toBeUndefined();
    // Injected empty env so the result comes from the fixed baseURL, not process.env.
    expect(resolveProviderBaseUrl("opencode-go", {})).toBe(
      "https://opencode.ai/zen/go/v1",
    );
  });

  it("uses the OpenCode Go label", () => {
    expect(config.label).toBe("OpenCode Go");
    expect(getProviderLabel("opencode-go")).toBe("OpenCode Go");
  });

  it("ships the eight OpenAI-compatible models with Kimi K2.7 Code as default", () => {
    const options = getProviderModelOptions("opencode-go");

    expect(options.map((option) => option.id)).toEqual([
      "kimi-k2.7-code",
      "glm-5.2",
      "glm-5.1",
      "kimi-k2.6",
      "deepseek-v4-pro",
      "deepseek-v4-flash",
      "mimo-v2.5",
      "mimo-v2.5-pro",
    ]);
    // getDefaultModelId returns modelOptions[0].id, so Kimi is the default.
    expect(getDefaultModelId("opencode-go")).toBe("kimi-k2.7-code");
  });

  it("exposes every model id as a valid model id", () => {
    for (const option of getProviderModelOptions("opencode-go")) {
      expect(isValidModelId(option.id)).toBe(true);
    }
  });

  it("is a valid, selectable provider", () => {
    expect(isValidProvider("opencode-go")).toBe(true);
    expect(SELECTABLE_PROVIDERS).toContain("opencode-go");
  });

  it("is selected when SINSCRIBE_PROVIDER=opencode-go", () => {
    expect(
      resolveConfiguredProvider(null, { SINSCRIBE_PROVIDER: "opencode-go" }),
    ).toBe("opencode-go");
  });

  it("honors an explicit model-id override", () => {
    expect(resolveModelId("glm-5.2", "opencode-go")).toBe("glm-5.2");
  });
});

describe("kiro-cli provider config", () => {
  it("drives the official kiro-cli binary and stores no credential", () => {
    expect(getProviderAuthKind("kiro-cli")).toBe("local-cli");
    expect(getProviderApiKeyEnvKey("kiro-cli")).toBeNull();
    expect(getProviderCommand("kiro-cli")?.command).toBe("kiro-cli");
    // The hint must name the one-time sign-in, not an API key: AWS gates Q
    // to approved apps, so the official CLI has to own the credentials.
    expect(getProviderCommand("kiro-cli")?.setupHint).toMatch(
      /kiro-cli login/u,
    );
  });

  it("is single-shot only: tools would have to cross the subprocess", () => {
    expect(providerSupportsAgentic("kiro-cli")).toBe(false);
  });

  it('defaults to "auto" so the CLI picks its own model', () => {
    expect(getDefaultModelId("kiro-cli")).toBe("auto");
  });

  it("ships the real model ids from `kiro-cli chat --list-models`", () => {
    const ids = getProviderModelOptions("kiro-cli").map((o) => o.id);

    // Dotted, not dashed — `claude-sonnet-4-5` is not a real Kiro model.
    expect(ids).toContain("claude-sonnet-4.5");
    expect(ids).toContain("qwen3-coder-next");
    expect(ids).not.toContain("claude-3.7-sonnet");

    for (const option of getProviderModelOptions("kiro-cli")) {
      expect(isValidModelId(option.id)).toBe(true);
    }
  });

  it("is a valid, selectable provider", () => {
    expect(isValidProvider("kiro-cli")).toBe(true);
    expect(SELECTABLE_PROVIDERS).toContain("kiro-cli");
    expect(
      resolveConfiguredProvider(null, { SINSCRIBE_PROVIDER: "kiro-cli" }),
    ).toBe("kiro-cli");
  });

  it("exposes no command for providers that are not local-cli", () => {
    expect(getProviderCommand("opencode-go")).toBeNull();
    expect(getProviderCommand("anthropic")).toBeNull();
  });
});

describe("legacy provider regression tripwire", () => {
  // Adding kiro-cli must not have changed any existing provider's wiring.
  const expectedApiKeys: Record<
    Exclude<SinscribeProvider, "kiro-cli">,
    string
  > = {
    openrouter: "OPENROUTER_API_KEY",
    "opencode-go": "OPENCODE_API_KEY",
    baseten: "BASETEN_API_KEY",
    fireworks: "FIREWORKS_API_KEY",
    openai: "OPENAI_API_KEY",
    "openai-compatible": "OPENAI_COMPATIBLE_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
  };

  it("keeps all seven legacy providers on api-key auth with agentic support", () => {
    for (const [provider, envKey] of Object.entries(expectedApiKeys)) {
      const typedProvider = provider as SinscribeProvider;

      expect(getProviderAuthKind(typedProvider)).toBe("api-key");
      expect(getProviderApiKeyEnvKey(typedProvider)).toBe(envKey);
      expect(providerSupportsAgentic(typedProvider)).toBe(true);
    }
  });
});

describe("SINSCRIBE_VERSION", () => {
  it("reads a semver-shaped version from package.json", () => {
    expect(SINSCRIBE_VERSION).toMatch(/^\d+\.\d+\.\d+/u);
  });
});

describe("default provider resolution", () => {
  it("defaults to opencode-go with Kimi K2.7 Code", () => {
    expect(DEFAULT_PROVIDER).toBe("opencode-go");
    expect(DEFAULT_MODEL_ID).toBe("kimi-k2.7-code");
  });

  it("resolves to the default provider with no env at all", () => {
    expect(resolveConfiguredProvider(null, {})).toBe("opencode-go");
  });

  it("no longer forces openrouter just because OPENROUTER_API_KEY is set", () => {
    expect(
      resolveConfiguredProvider(null, { OPENROUTER_API_KEY: "sk-x" }),
    ).toBe("opencode-go");
  });

  it("honors an explicit persisted SINSCRIBE_PROVIDER over the default", () => {
    expect(
      resolveConfiguredProvider(null, { SINSCRIBE_PROVIDER: "openrouter" }),
    ).toBe("openrouter");
  });

  it("prefers a provider override over a persisted SINSCRIBE_PROVIDER", () => {
    expect(
      resolveConfiguredProvider("anthropic", {
        SINSCRIBE_PROVIDER: "openrouter",
      }),
    ).toBe("anthropic");
  });

  it("falls back to the default when the override is not a valid provider", () => {
    expect(resolveConfiguredProvider("not-a-provider", {})).toBe("opencode-go");
  });
});
