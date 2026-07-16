import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testProviderConnection } from "../src/llm/healthcheck.js";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeFetch(response: Response) {
  return vi.fn().mockResolvedValue(response) as unknown as typeof fetch & {
    mock: { calls: [string, RequestInit][] };
  };
}

const API_KEY = "sk-test-secret-key";

beforeEach(() => {
  vi.stubEnv("OPENAI_COMPATIBLE_BASE_URL", "");
  vi.stubEnv("ANTHROPIC_BASE_URL", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("testProviderConnection", () => {
  it("hits the opencode-go models endpoint with Bearer auth", async () => {
    const fetchImpl = makeFetch(
      jsonResponse({ data: [{ id: "kimi-k2.7-code" }, { id: "glm-5.2" }] }),
    );
    const result = await testProviderConnection({
      provider: "opencode-go",
      apiKey: API_KEY,
      modelId: "kimi-k2.7-code",
      fetchImpl,
    });

    const [url, init] = fetchImpl.mock.calls[0];

    expect(url).toBe("https://opencode.ai/zen/go/v1/models");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${API_KEY}`,
    );
    expect(result).toEqual({ ok: true, modelCount: 2, modelFound: true });
  });

  it("hits the Anthropic models endpoint with x-api-key auth", async () => {
    const fetchImpl = makeFetch(
      jsonResponse({ data: [{ id: "claude-sonnet-5" }] }),
    );
    const result = await testProviderConnection({
      provider: "anthropic",
      apiKey: API_KEY,
      modelId: "claude-opus-4-8",
      fetchImpl,
    });

    const [url, init] = fetchImpl.mock.calls[0];
    const headers = init.headers as Record<string, string>;

    expect(url).toBe("https://api.anthropic.com/v1/models");
    expect(headers["x-api-key"]).toBe(API_KEY);
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(result).toEqual({ ok: true, modelCount: 1, modelFound: false });
  });

  it("reports a rejected key without leaking it", async () => {
    const fetchImpl = makeFetch(jsonResponse({}, 401));
    const result = await testProviderConnection({
      provider: "opencode-go",
      apiKey: API_KEY,
      modelId: "kimi-k2.7-code",
      fetchImpl,
    });

    expect(result.ok).toBe(false);

    const message = result.ok ? "" : result.message;

    expect(message).toContain("HTTP 401");
    expect(message).toContain("OPENCODE_API_KEY");
    expect(message).not.toContain(API_KEY);
  });

  it("flags a missing models endpoint as a base-URL problem", async () => {
    const fetchImpl = makeFetch(jsonResponse({}, 404));
    const result = await testProviderConnection({
      provider: "opencode-go",
      apiKey: API_KEY,
      modelId: "kimi-k2.7-code",
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.message).toMatch(/base URL/u);
  });

  it("still reports ok when the 2xx body is not a model list", async () => {
    const fetchImpl = makeFetch(new Response("plain text", { status: 200 }));
    const result = await testProviderConnection({
      provider: "openai",
      apiKey: API_KEY,
      modelId: "gpt-5.5",
      fetchImpl,
    });

    expect(result).toEqual({ ok: true, modelCount: null, modelFound: null });
    expect(fetchImpl.mock.calls[0][0]).toBe("https://api.openai.com/v1/models");
  });

  it("maps fetch failures to a network message with the code", async () => {
    const failure = new TypeError("fetch failed");

    (failure as TypeError & { cause: Error & { code: string } }).cause =
      Object.assign(new Error("connect ECONNREFUSED"), {
        code: "ECONNREFUSED",
      });

    const fetchImpl = vi
      .fn()
      .mockRejectedValue(failure) as unknown as typeof fetch;
    const result = await testProviderConnection({
      provider: "opencode-go",
      apiKey: API_KEY,
      modelId: "kimi-k2.7-code",
      fetchImpl,
    });

    expect(result.ok).toBe(false);

    const message = result.ok ? "" : result.message;

    expect(message).toContain("ECONNREFUSED");
    expect(message).toContain("opencode.ai");
  });

  it("requires a base URL for openai-compatible before calling anything", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch & {
      mock: { calls: unknown[] };
    };
    const result = await testProviderConnection({
      provider: "openai-compatible",
      apiKey: API_KEY,
      modelId: "my-model",
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.message).toContain(
      "OPENAI_COMPATIBLE_BASE_URL",
    );
    expect(fetchImpl.mock.calls).toHaveLength(0);
  });

  it("explains that kiro-cli owns its own sign-in, without any request", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch & {
      mock: { calls: unknown[] };
    };
    const result = await testProviderConnection({
      provider: "kiro-cli",
      apiKey: "",
      modelId: "auto",
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.message).toMatch(/kiro-cli/u);
    expect(fetchImpl.mock.calls).toHaveLength(0);
  });
});
