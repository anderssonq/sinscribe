/**
 * Inactivity watchdog for streamed LLM calls.
 *
 * Provider SDKs are given an AbortSignal (threaded through LangChain's
 * RunnableConfig), but a signal alone is not hang-proof: a provider that
 * ignores it, or a socket that stalls without erroring, would leave a
 * `for await` loop suspended forever — the intermittent "CLI freeze".
 * raceAbort() closes that gap by racing every chunk read against the
 * watchdog, so the consuming loop always exits once the watchdog fires.
 */

/** Both timeouts fire through the same error so retry classification is uniform. */
export const LLM_INACTIVITY_MS = 120_000;
/** Overall deadline for single-shot calls; agent loops legitimately run longer. */
export const SINGLE_SHOT_TOTAL_MS = 600_000;

/**
 * Thrown when a model call produces no output for too long. `name` is
 * "TimeoutError" so classifyLlmError treats it as a retryable network
 * failure without any changes to the classifier.
 */
export class LlmTimeoutError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super(`Model call timed out — ${detail}.`);
    this.name = "TimeoutError";
    this.detail = detail;
  }
}

export type InactivityWatchdog = {
  /** Pass to the SDK call so well-behaved providers abort their own request. */
  signal: AbortSignal;
  /** Call once per received chunk to reset the inactivity timer. */
  touch(): void;
  /** Clears both timers; always call in a finally block. */
  dispose(): void;
  /** The error the watchdog aborted with, or null while healthy. */
  readonly timeoutError: LlmTimeoutError | null;
};

/**
 * Creates a watchdog that aborts after `inactivityMs` without a touch(), or
 * after `totalMs` overall when given. Timers are unref()ed so a disposed-but-
 * forgotten watchdog can never keep the process alive.
 */
export function createInactivityWatchdog(options: {
  inactivityMs: number;
  totalMs?: number;
}): InactivityWatchdog {
  const controller = new AbortController();
  let timeoutError: LlmTimeoutError | null = null;
  let inactivityTimer: NodeJS.Timeout | null = null;
  let totalTimer: NodeJS.Timeout | null = null;

  const clearTimers = (): void => {
    if (inactivityTimer !== null) {
      clearTimeout(inactivityTimer);
      inactivityTimer = null;
    }

    if (totalTimer !== null) {
      clearTimeout(totalTimer);
      totalTimer = null;
    }
  };

  const fire = (detail: string): void => {
    timeoutError = new LlmTimeoutError(detail);
    clearTimers();
    controller.abort(timeoutError);
  };

  const armInactivity = (): void => {
    if (inactivityTimer !== null) {
      clearTimeout(inactivityTimer);
    }

    inactivityTimer = setTimeout(() => {
      fire(`no model output for ${Math.round(options.inactivityMs / 1_000)}s`);
    }, options.inactivityMs);
    inactivityTimer.unref();
  };

  armInactivity();

  if (options.totalMs !== undefined) {
    totalTimer = setTimeout(() => {
      fire(
        `call still running after ${Math.round((options.totalMs ?? 0) / 1_000)}s`,
      );
    }, options.totalMs);
    totalTimer.unref();
  }

  return {
    signal: controller.signal,
    touch(): void {
      if (timeoutError === null) {
        armInactivity();
      }
    },
    dispose(): void {
      clearTimers();
    },
    get timeoutError(): LlmTimeoutError | null {
      return timeoutError;
    },
  };
}

/**
 * Yields from `iterable`, racing each read against the watchdog. Throws the
 * watchdog's LlmTimeoutError when it fires mid-read — even if the underlying
 * provider stream ignores the abort signal entirely.
 */
export async function* raceAbort<T>(
  iterable: AsyncIterable<T>,
  watchdog: InactivityWatchdog,
): AsyncGenerator<T> {
  const iterator = iterable[Symbol.asyncIterator]();
  const aborted = new Promise<never>((_, reject) => {
    const rejectWithReason = (): void => {
      reject(watchdog.timeoutError ?? new LlmTimeoutError("call aborted"));
    };

    if (watchdog.signal.aborted) {
      rejectWithReason();
      return;
    }

    watchdog.signal.addEventListener("abort", rejectWithReason, {
      once: true,
    });
  });

  // The race can finish without this promise settling the loop's await;
  // mark it handled so an abort never surfaces as an unhandled rejection.
  aborted.catch(() => undefined);

  try {
    for (;;) {
      const next = iterator.next();

      // If the race is lost to an abort, this pending read is abandoned; a
      // late rejection from it must not crash the process.
      next.catch(() => undefined);

      const result = await Promise.race([next, aborted]);

      if (result.done === true) {
        return;
      }

      yield result.value;
    }
  } finally {
    // Release the underlying stream (closes the socket for SDK streams).
    try {
      const cleanup = iterator.return?.();

      if (cleanup !== undefined) {
        cleanup.catch(() => undefined);
      }
    } catch {
      // The stream may already be closed — nothing left to release.
    }
  }
}
