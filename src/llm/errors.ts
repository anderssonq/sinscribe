import type { ProviderAuthKind } from "../constants.js";
import { CliError } from "../domain/errors.js";

/**
 * Failure classes for LLM calls. Provider SDKs throw untyped errors, so
 * classification is duck-typed from status codes, error codes, and messages.
 */
export type LlmErrorClass =
  | "missing-config"
  | "auth"
  | "rate-limit"
  | "network"
  | "server"
  | "invalid-json"
  | "unknown";

export type ClassifiedLlmError = {
  klass: LlmErrorClass;
  /** Only rate-limit, network, and server failures are worth retrying. */
  retryable: boolean;
  /** Short cause for status lines, e.g. "HTTP 429" or "ECONNREFUSED". */
  detail: string;
};

/**
 * Model output that could not be parsed as JSON. Extends CliError so it
 * prints clean at the top level; carries the raw output for re-asks.
 */
export class InvalidModelJsonError extends CliError {
  readonly raw: string;

  constructor(raw: string) {
    super(
      `Model did not return valid JSON. Raw output:\n${raw.slice(0, 2_000)}`,
    );
    this.name = "InvalidModelJsonError";
    this.raw = raw;
  }
}

const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/** Walks error.cause chains (fetch/undici nest the useful code one level down). */
function* causeChain(error: unknown): Generator<unknown> {
  let current = error;

  for (
    let depth = 0;
    depth < 8 && current !== null && current !== undefined;
    depth++
  ) {
    yield current;
    current = (current as { cause?: unknown }).cause;
  }
}

function readStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }

  const record = error as Record<string, unknown>;
  const candidates = [
    record.status,
    record.statusCode,
    (record.response as Record<string, unknown> | undefined)?.status,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "number" && candidate >= 100) {
      return candidate;
    }
  }

  return null;
}

function readStringField(error: unknown, field: string): string | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }

  const value = (error as Record<string, unknown>)[field];

  return typeof value === "string" ? value : null;
}

function getMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function firstLine(message: string): string {
  return message.split("\n", 1)[0]?.trim() ?? message;
}

function classified(klass: LlmErrorClass, detail: string): ClassifiedLlmError {
  return {
    klass,
    retryable:
      klass === "rate-limit" || klass === "network" || klass === "server",
    detail,
  };
}

export function classifyLlmError(error: unknown): ClassifiedLlmError {
  for (const cause of causeChain(error)) {
    if (cause instanceof InvalidModelJsonError) {
      return classified("invalid-json", "invalid JSON output");
    }

    const status = readStatus(cause);

    if (status === 401 || status === 403) {
      return classified("auth", `HTTP ${status}`);
    }

    if (status === 429) {
      return classified("rate-limit", `HTTP ${status}`);
    }

    if (status !== null && status >= 500) {
      return classified("server", `HTTP ${status}`);
    }

    const code = readStringField(cause, "code");

    if (code !== null && NETWORK_CODES.has(code)) {
      return classified("network", code);
    }

    const name = readStringField(cause, "name");

    if (name === "AbortError" || name === "TimeoutError") {
      return classified("network", name);
    }
  }

  const message = getMessage(error);

  // Config messages mention "API key" too — check before the auth fallback.
  if (/is required to run sinscribe|invalid model id/iu.test(message)) {
    return classified("missing-config", firstLine(message));
  }

  if (/rate.?limit/iu.test(message)) {
    return classified("rate-limit", firstLine(message));
  }

  if (
    /timed?.?out|fetch failed|network|socket|econn|connection error/iu.test(
      message,
    )
  ) {
    return classified("network", firstLine(message));
  }

  if (
    /api key|unauthorized|authentication|forbidden|permission/iu.test(message)
  ) {
    return classified("auth", firstLine(message));
  }

  return classified("unknown", firstLine(message));
}

/**
 * Exponential backoff with equal jitter: min(cap, base * 2^(attempt-1)),
 * scaled by a random factor in [0.5, 1). `random` is injectable for tests.
 */
export function backoffDelayMs(
  attempt: number,
  options: { baseMs?: number; capMs?: number; random?: () => number } = {},
): number {
  const { baseMs = 1_000, capMs = 8_000, random = Math.random } = options;
  const exponential = Math.min(capMs, baseMs * 2 ** (Math.max(1, attempt) - 1));

  return Math.round(exponential * (0.5 + random() / 2));
}

export type RetryInfo = {
  /** The 1-based attempt that just failed. */
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  error: ClassifiedLlmError;
};

/**
 * Retries `fn` on transient LLM failures (rate-limit/network/server) with
 * backoff. Non-retryable errors and the final attempt's error rethrow as-is.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: {
    maxAttempts?: number;
    onRetry?: (info: RetryInfo) => void;
    delayMs?: (attempt: number) => number;
  } = {},
): Promise<T> {
  const { maxAttempts = 3, onRetry, delayMs = backoffDelayMs } = options;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;

      if (!classifyLlmError(error).retryable || attempt === maxAttempts) {
        throw error;
      }

      const delay = delayMs(attempt);

      onRetry?.({
        attempt,
        maxAttempts,
        delayMs: delay,
        error: classifyLlmError(error),
      });

      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}

/**
 * Maps a failed LLM call to a CliError with an actionable message, so the
 * top-level handler prints it clean instead of "Unexpected error: ...".
 */
export function toFriendlyError(
  error: unknown,
  context: {
    providerLabel: string;
    apiKeyEnvKey?: string;
    exhaustedRetries?: boolean;
    /**
     * How the provider authenticates. "local-cli" providers have no API key,
     * so the key-centric advice below would be impossible to follow.
     */
    authKind?: ProviderAuthKind;
  },
): CliError {
  // InvalidModelJsonError extends CliError — classify it before passing
  // other CliErrors (git/template failures) through untouched.
  if (error instanceof CliError && !(error instanceof InvalidModelJsonError)) {
    return error;
  }

  const { klass, detail } = classifyLlmError(error);
  const retried = context.exhaustedRetries ? " Retries were exhausted." : "";

  switch (klass) {
    case "missing-config":
      // resolveModel's own messages already say which env var to set.
      return new CliError(getMessage(error));
    case "auth":
      if (context.authKind === "local-cli") {
        // There is no API key to fix; the CLI owns its own sign-in.
        return new CliError(
          `Authentication failed for ${context.providerLabel} (${detail}). ` +
            `Its CLI may be signed out or lack access — sign in again with ` +
            `that CLI's own login command. Details: ${getMessage(error)}`,
        );
      }

      return new CliError(
        `Authentication failed for ${context.providerLabel} (${detail}). ` +
          `The API key looks invalid or expired — update it in ~/.sinscribe/.env` +
          `${context.apiKeyEnvKey ? ` (${context.apiKeyEnvKey})` : ""}, or pass --api-key.`,
      );
    case "rate-limit":
      return new CliError(
        `Rate limited by ${context.providerLabel} (${detail}).${retried} ` +
          `Wait a minute and try again.`,
      );
    case "network":
      return new CliError(
        `Could not reach ${context.providerLabel} (${detail}).${retried} ` +
          `Check your internet connection, VPN, or proxy.`,
      );
    case "server":
      return new CliError(
        `${context.providerLabel} returned a server error (${detail}).${retried} ` +
          `This is usually temporary — try again shortly.`,
      );
    case "invalid-json":
      return new CliError(
        `The model did not return valid JSON. Try again, or pick a different ` +
          `model with --model-id.`,
      );
    case "unknown":
      return new CliError(
        `${context.providerLabel} request failed: ${getMessage(error)}`,
      );
  }
}
