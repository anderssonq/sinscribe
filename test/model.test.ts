import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveModelId, resolveProviderApiKey } from "../src/llm/model.js";

const OPENCODE_KEY = "OPENCODE_API_KEY";
const MODEL_ID_KEY = "SINSCRIBE_MODEL_ID";

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

  beforeEach(() => {
    delete process.env[MODEL_ID_KEY];
  });

  afterEach(() => {
    if (originalModelId === undefined) {
      delete process.env[MODEL_ID_KEY];
    } else {
      process.env[MODEL_ID_KEY] = originalModelId;
    }
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
