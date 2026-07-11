import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL_ID,
  DEFAULT_PROVIDER,
  getDefaultModelId,
  getProviderApiKeyEnvKey,
  getProviderLabel,
  getProviderModelOptions,
  isValidModelId,
  isValidProvider,
  OPENCODE_GO_API_KEY_ENV_KEY,
  OPENCODE_GO_BASE_URL,
  PROVIDER_CONFIGS,
  resolveConfiguredProvider,
  resolveProviderBaseUrl,
  SELECTABLE_PROVIDERS,
} from "../src/constants.js";
import { resolveModelId } from "../src/llm/model.js";

describe("opencode-go provider config", () => {
  const config = PROVIDER_CONFIGS["opencode-go"];

  it("resolves the OpenCode Go API key env var", () => {
    expect(OPENCODE_GO_API_KEY_ENV_KEY).toBe("OPENCODE_API_KEY");
    expect(config.apiKeyEnvKey).toBe("OPENCODE_API_KEY");
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
