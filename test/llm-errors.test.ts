import { describe, expect, it } from "vitest";
import { CliError } from "../src/domain/errors.js";
import {
  backoffDelayMs,
  classifyLlmError,
  InvalidModelJsonError,
  toFriendlyError,
  withRetry,
} from "../src/llm/errors.js";

function errorWith(fields: Record<string, unknown>): Error {
  return Object.assign(new Error("boom"), fields);
}

describe("classifyLlmError", () => {
  it("classifies HTTP statuses", () => {
    expect(classifyLlmError(errorWith({ status: 401 }))).toMatchObject({
      klass: "auth",
      retryable: false,
      detail: "HTTP 401",
    });
    expect(classifyLlmError(errorWith({ status: 403 })).klass).toBe("auth");
    expect(classifyLlmError(errorWith({ statusCode: 429 }))).toMatchObject({
      klass: "rate-limit",
      retryable: true,
      detail: "HTTP 429",
    });
    expect(classifyLlmError(errorWith({ status: 503 }))).toMatchObject({
      klass: "server",
      retryable: true,
    });
    expect(
      classifyLlmError(errorWith({ response: { status: 500 } })).klass,
    ).toBe("server");
  });

  it("classifies network error codes, including nested in cause", () => {
    expect(classifyLlmError(errorWith({ code: "ECONNREFUSED" }))).toMatchObject(
      { klass: "network", retryable: true, detail: "ECONNREFUSED" },
    );

    const wrapped = new Error("fetch failed");

    (wrapped as { cause?: unknown }).cause = errorWith({ code: "ETIMEDOUT" });
    expect(classifyLlmError(wrapped)).toMatchObject({
      klass: "network",
      detail: "ETIMEDOUT",
    });
  });

  it("classifies aborts by error name", () => {
    const abort = new Error("This operation was aborted");

    abort.name = "AbortError";
    expect(classifyLlmError(abort).klass).toBe("network");
  });

  it("falls back to message heuristics", () => {
    expect(classifyLlmError(new Error("Rate limit exceeded")).klass).toBe(
      "rate-limit",
    );
    expect(classifyLlmError(new Error("fetch failed")).klass).toBe("network");
    // The OpenAI SDK's APIConnectionError message carries no code at all.
    expect(classifyLlmError(new Error("Connection error.")).klass).toBe(
      "network",
    );
    expect(
      classifyLlmError(new Error("Incorrect API key provided")).klass,
    ).toBe("auth");
  });

  it("classifies config errors before the auth heuristic", () => {
    expect(
      classifyLlmError(
        new Error(
          "OPENCODE_API_KEY is required to run sinscribe with OpenCode Go. " +
            "Set it in your environment, in ~/.sinscribe/.env, or pass --api-key.",
        ),
      ),
    ).toMatchObject({ klass: "missing-config", retryable: false });
    expect(
      classifyLlmError(
        new Error("Invalid model ID configured in SINSCRIBE_MODEL_ID."),
      ).klass,
    ).toBe("missing-config");
  });

  it("classifies InvalidModelJsonError as non-retryable invalid-json", () => {
    expect(
      classifyLlmError(new InvalidModelJsonError("not json")),
    ).toMatchObject({
      klass: "invalid-json",
      retryable: false,
    });
  });

  it("treats unknown errors as non-retryable", () => {
    expect(classifyLlmError(new Error("something odd"))).toMatchObject({
      klass: "unknown",
      retryable: false,
    });
  });
});

describe("backoffDelayMs", () => {
  it("grows exponentially with jitter bounds", () => {
    expect(backoffDelayMs(1, { random: () => 0 })).toBe(500);
    expect(backoffDelayMs(1, { random: () => 0.999999 })).toBeLessThanOrEqual(
      1_000,
    );
    expect(backoffDelayMs(2, { random: () => 0 })).toBe(1_000);
    expect(backoffDelayMs(3, { random: () => 0 })).toBe(2_000);
  });

  it("caps the exponential term", () => {
    expect(backoffDelayMs(10, { random: () => 0 })).toBe(4_000);
    expect(backoffDelayMs(10, { random: () => 0.999999 })).toBeLessThanOrEqual(
      8_000,
    );
  });
});

describe("withRetry", () => {
  it("retries transient failures and reports each retry", async () => {
    const retries: number[] = [];
    let calls = 0;

    const result = await withRetry(
      // eslint-disable-next-line @typescript-eslint/require-await
      async () => {
        calls += 1;

        if (calls < 3) {
          throw errorWith({ status: 429 });
        }

        return "ok";
      },
      {
        delayMs: () => 0,
        onRetry: ({ attempt, maxAttempts }) => {
          retries.push(attempt);
          expect(maxAttempts).toBe(3);
        },
      },
    );

    expect(result).toBe("ok");
    expect(calls).toBe(3);
    expect(retries).toEqual([1, 2]);
  });

  it("does not retry non-retryable failures", async () => {
    let calls = 0;

    await expect(
      // eslint-disable-next-line @typescript-eslint/require-await
      withRetry(async () => {
        calls += 1;
        throw errorWith({ status: 401 });
      }),
    ).rejects.toMatchObject({ status: 401 });
    expect(calls).toBe(1);
  });

  it("rethrows the last error when attempts run out", async () => {
    let calls = 0;

    await expect(
      withRetry(
        // eslint-disable-next-line @typescript-eslint/require-await
        async () => {
          calls += 1;
          throw errorWith({ code: "ECONNRESET" });
        },
        { maxAttempts: 2, delayMs: () => 0 },
      ),
    ).rejects.toMatchObject({ code: "ECONNRESET" });
    expect(calls).toBe(2);
  });
});

describe("toFriendlyError", () => {
  const context = { providerLabel: "OpenCode Go" };

  it("returns CliErrors (git/domain failures) untouched", () => {
    const original = new CliError("No local changes vs main.");

    expect(toFriendlyError(original, context)).toBe(original);
  });

  it("maps auth failures to an actionable message", () => {
    const friendly = toFriendlyError(errorWith({ status: 401 }), {
      ...context,
      apiKeyEnvKey: "OPENCODE_API_KEY",
    });

    expect(friendly).toBeInstanceOf(CliError);
    expect(friendly.message).toContain("OpenCode Go");
    expect(friendly.message).toContain("OPENCODE_API_KEY");
    expect(friendly.message).toContain("--api-key");
  });

  it("notes exhausted retries for transient classes", () => {
    const friendly = toFriendlyError(errorWith({ status: 429 }), {
      ...context,
      exhaustedRetries: true,
    });

    expect(friendly.message).toContain("Rate limited by OpenCode Go");
    expect(friendly.message).toContain("Retries were exhausted");
  });

  it("maps network and server failures with hints", () => {
    expect(
      toFriendlyError(errorWith({ code: "ECONNREFUSED" }), context).message,
    ).toContain("Check your internet connection");
    expect(
      toFriendlyError(errorWith({ status: 502 }), context).message,
    ).toContain("usually temporary");
  });

  it("maps InvalidModelJsonError to a friendly message", () => {
    const friendly = toFriendlyError(
      new InvalidModelJsonError("raw output"),
      context,
    );

    expect(friendly.message).toContain("did not return valid JSON");
    expect(friendly.message).toContain("--model-id");
  });

  it("passes missing-config messages through", () => {
    const message =
      "OPENCODE_API_KEY is required to run sinscribe with OpenCode Go.";

    expect(toFriendlyError(new Error(message), context).message).toBe(message);
  });
});
