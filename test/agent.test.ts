import { describe, expect, it } from "vitest";
import { buildShellEnv } from "../src/llm/agent.js";
import {
  ANTHROPIC_API_KEY_ENV_KEY,
  OPENAI_API_KEY_ENV_KEY,
  OPENROUTER_API_KEY_ENV_KEY,
  ANTHROPIC_BASE_URL_ENV_KEY,
  SINSCRIBE_PROVIDER_ENV_KEY,
} from "../src/constants.js";

describe("buildShellEnv", () => {
  it("removes secret API keys from the shell env", () => {
    const env = buildShellEnv({
      PATH: "/usr/bin:/bin",
      HOME: "/home/dev",
      [ANTHROPIC_API_KEY_ENV_KEY]: "sk-ant-secret",
      [OPENAI_API_KEY_ENV_KEY]: "sk-openai-secret",
      [OPENROUTER_API_KEY_ENV_KEY]: "sk-or-secret",
    });

    expect(env[ANTHROPIC_API_KEY_ENV_KEY]).toBeUndefined();
    expect(env[OPENAI_API_KEY_ENV_KEY]).toBeUndefined();
    expect(env[OPENROUTER_API_KEY_ENV_KEY]).toBeUndefined();
  });

  it("keeps PATH/HOME, base URLs, and non-secret config vars", () => {
    const env = buildShellEnv({
      PATH: "/usr/bin:/bin",
      HOME: "/home/dev",
      [ANTHROPIC_BASE_URL_ENV_KEY]: "https://example.test",
      [SINSCRIBE_PROVIDER_ENV_KEY]: "anthropic",
      [ANTHROPIC_API_KEY_ENV_KEY]: "sk-ant-secret",
    });

    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.HOME).toBe("/home/dev");
    expect(env[ANTHROPIC_BASE_URL_ENV_KEY]).toBe("https://example.test");
    expect(env[SINSCRIBE_PROVIDER_ENV_KEY]).toBe("anthropic");
    expect(env[ANTHROPIC_API_KEY_ENV_KEY]).toBeUndefined();
  });

  it("drops undefined values so the result is a plain string map", () => {
    const env = buildShellEnv({ DEFINED: "x", UNDEFINED: undefined });

    expect(env.DEFINED).toBe("x");
    expect("UNDEFINED" in env).toBe(false);
  });
});
