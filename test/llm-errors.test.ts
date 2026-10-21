import { describe, expect, it } from "vitest";
import { CliError } from "../src/domain/errors.js";
import {
  backoffDelayMs,
  classifyLlmError,
  cliExitError,
  cliFailureDetail,
  CliRateLimitError,
  cliVerdictError,
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

const KIRO_THROTTLE =
  "Error: Internal error (code -32603): Encountered an error in the response stream: The request was throttled by the service (request_id: e3b95f)";

describe("cliFailureDetail", () => {
  it("picks the last error line after [tool] progress lines", () => {
    const stderr = [
      "[tool] Reading listing midas-kiro …",
      "[tool] status: Completed",
      "Error: first problem",
      "[tool] Reading src",
      KIRO_THROTTLE,
      "",
    ].join("\n");

    // The cause first, then the CLI's lines just above it.
    expect(cliFailureDetail(stderr)).toBe(
      `${KIRO_THROTTLE}\nError: first problem`,
    );
  });

  it("keeps the context above the cause so it still classifies", () => {
    const detail = cliFailureDetail(
      "unauthorized: run kiro-cli login\nError: request failed",
    );

    expect(detail).toBe(
      "Error: request failed\nunauthorized: run kiro-cli login",
    );
    expect(classifyLlmError(new Error(detail)).klass).toBe("auth");
  });

  it("ignores lines that only mention the word error", () => {
    expect(cliFailureDetail("finished with no error\nbye")).toBe(
      "finished with no error\nbye",
    );
  });

  it("strips ANSI escapes and carriage returns", () => {
    expect(cliFailureDetail("\u001b[31mError: bad\u001b[0m\r\n")).toBe(
      "Error: bad",
    );
  });

  it("falls back to the tail when no line mentions an error", () => {
    expect(cliFailureDetail("a".repeat(30) + "\nlast line", 10)).toBe(
      "last line",
    );
    expect(cliFailureDetail("one\ntwo")).toBe("one\ntwo");
  });

  it("caps an error line to max characters", () => {
    expect(cliFailureDetail("Error: " + "x".repeat(50), 12)).toHaveLength(12);
  });

  it("reports no output for empty or tool-only stderr", () => {
    expect(cliFailureDetail("")).toBe("(no output)");
    expect(
      cliFailureDetail("[tool] Reading a\n[tool] status: Completed\n"),
    ).toBe("(no output)");
  });
});

describe("classifyLlmError throttling", () => {
  it("treats the Kiro throttle message as a retryable rate-limit", () => {
    expect(
      classifyLlmError(
        new CliError(`kiro-cli chat exited with code 1: ${KIRO_THROTTLE}`),
      ),
    ).toMatchObject({ klass: "rate-limit", retryable: true });
    expect(classifyLlmError(new Error("Too Many Requests"))).toMatchObject({
      klass: "rate-limit",
    });
  });
});

describe("cliFailureDetail picks the rate-limit cause", () => {
  it("prefers a rate-limit line over a later generic error line", () => {
    const detail = cliFailureDetail(
      "429 rate limited, slow down\nError: request failed",
    );

    expect(detail).toBe("429 rate limited, slow down");
    expect(classifyLlmError(new Error(detail)).klass).toBe("rate-limit");
  });
});

describe("typed CLI rate limits", () => {
  it("cliExitError types a rate limit only when the CLI's stderr says so", () => {
    const throttled = cliExitError(
      "kiro-cli chat exited with code 1",
      `[tool] Reading a.ts:1\n${KIRO_THROTTLE}\n`,
    );

    expect(throttled).toBeInstanceOf(CliRateLimitError);
    expect(throttled.message).toBe(
      `kiro-cli chat exited with code 1: ${KIRO_THROTTLE}`,
    );
    expect(
      cliExitError("kiro-cli chat exited with code 1", "Error: boom"),
    ).not.toBeInstanceOf(CliRateLimitError);
  });

  it("cliVerdictError types claude's own rate-limit verdict", () => {
    expect(
      cliVerdictError(
        "claude failed: API Error: 429",
        "API Error: 429 rate_limit_error",
      ),
    ).toBeInstanceOf(CliRateLimitError);
    expect(
      cliVerdictError("claude failed: Not logged in", "Not logged in"),
    ).not.toBeInstanceOf(CliRateLimitError);
  });
});
