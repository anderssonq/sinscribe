import { describe, expect, it } from "vitest";
import { REDACTED, redactSecrets } from "../src/util/redact.js";

describe("redactSecrets", () => {
  it("replaces the literal values of loaded API keys", () => {
    const env = { ANTHROPIC_API_KEY: "plainvalue-123456789" };
    const result = redactSecrets("key is plainvalue-123456789 here", env);

    expect(result.text).toBe(`key is ${REDACTED} here`);
    expect(result.count).toBe(1);
  });

  it.each([
    ["anthropic", "sk-ant-api03-abcdefghijklmnopqrstuv"],
    ["openai", "sk-proj-abcdefghijklmnopqrstuvwxyz"],
    ["aws", "AKIAIOSFODNN7EXAMPLE"],
    ["github", `ghp_${"a".repeat(36)}`],
    ["github pat", `github_pat_${"B".repeat(40)}`],
    ["slack", "xoxb-1234567890-abcdefghij"],
  ])("redacts %s tokens", (_name, secret) => {
    const result = redactSecrets(`use ${secret} now`, {});

    expect(result.text).toBe(`use ${REDACTED} now`);
    expect(result.count).toBe(1);
  });

  it("redacts PEM private key blocks whole", () => {
    const pem = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEowIBAAKCAQEA",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");

    expect(redactSecrets(`a\n${pem}\nb`, {}).text).toBe(`a\n${REDACTED}\nb`);
  });

  it("redacts long secret-looking assignments but keeps the key name", () => {
    const result = redactSecrets('API_KEY="abcdEFGH1234ijklMNOP5678"', {});

    expect(result.text).toBe(`API_KEY="${REDACTED}"`);
  });

  it("leaves type annotations and short placeholders alone", () => {
    const code = "type Auth = { token: string; password: Secret };";

    expect(redactSecrets(code, {})).toEqual({ text: code, count: 0 });
  });
});
