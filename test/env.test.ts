import { describe, expect, it } from "vitest";
import { createCredentialPreview, formatEnv, parseEnv } from "../src/env.js";

describe("env round-trip", () => {
  it("parses quoted and unquoted values", () => {
    const env = parseEnv(
      [
        "# comment",
        "OPENROUTER_API_KEY=sk-plain",
        'ANTHROPIC_API_KEY="sk-with \\"quotes\\" and\\nnewline"',
        "not a valid line",
        "lowercase=ignored",
      ].join("\n"),
    );

    expect(env.OPENROUTER_API_KEY).toBe("sk-plain");
    expect(env.ANTHROPIC_API_KEY).toBe('sk-with "quotes" and\nnewline');
    expect(env.lowercase).toBeUndefined();
  });

  it("round-trips through format and parse", () => {
    const original = {
      OPENROUTER_API_KEY: "sk-or-123",
      SINSCRIBE_PROVIDER: "openrouter",
      SINSCRIBE_MODEL_ID: "z-ai/glm-5.2",
      CUSTOM_KEY: 'value with "quotes"\nand newline',
    };

    expect(parseEnv(formatEnv(original))).toEqual(original);
  });
});

describe("createCredentialPreview", () => {
  it("masks short values entirely", () => {
    expect(createCredentialPreview("sk-1234")).toBe('"*******"');
  });

  it("shows first 6 and last 4 characters of long values", () => {
    expect(createCredentialPreview("sk-abcdefghijklmnopqrstuvwxyz")).toBe(
      '"sk-abc...wxyz"',
    );
  });
});
