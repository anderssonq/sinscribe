import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyLlmError } from "../src/llm/errors.js";
import {
  createInactivityWatchdog,
  LlmTimeoutError,
  raceAbort,
} from "../src/llm/watchdog.js";

describe("createInactivityWatchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("aborts after the inactivity window with no touch", () => {
    const watchdog = createInactivityWatchdog({ inactivityMs: 1_000 });

    expect(watchdog.signal.aborted).toBe(false);

    vi.advanceTimersByTime(1_000);

    expect(watchdog.signal.aborted).toBe(true);
    expect(watchdog.timeoutError).toBeInstanceOf(LlmTimeoutError);
    expect(watchdog.timeoutError?.message).toMatch(/no model output/u);

    watchdog.dispose();
  });

  it("touch() defers the inactivity timer", () => {
    const watchdog = createInactivityWatchdog({ inactivityMs: 1_000 });

    vi.advanceTimersByTime(900);
    watchdog.touch();
    vi.advanceTimersByTime(900);

    expect(watchdog.signal.aborted).toBe(false);

    vi.advanceTimersByTime(100);

    expect(watchdog.signal.aborted).toBe(true);

    watchdog.dispose();
  });

  it("the total deadline fires despite regular touches", () => {
    const watchdog = createInactivityWatchdog({
      inactivityMs: 1_000,
      totalMs: 3_000,
    });

    for (let elapsed = 0; elapsed < 3_000; elapsed += 500) {
      vi.advanceTimersByTime(500);
      watchdog.touch();
    }

    expect(watchdog.signal.aborted).toBe(true);
    expect(watchdog.timeoutError?.message).toMatch(/still running/u);

    watchdog.dispose();
  });

  it("dispose() cancels both timers", () => {
    const watchdog = createInactivityWatchdog({
      inactivityMs: 1_000,
      totalMs: 2_000,
    });

    watchdog.dispose();
    vi.advanceTimersByTime(10_000);

    expect(watchdog.signal.aborted).toBe(false);
    expect(watchdog.timeoutError).toBeNull();
  });

  it("classifies as a retryable network error", () => {
    const classifiedDirect = classifyLlmError(new LlmTimeoutError("stalled"));

    expect(classifiedDirect.klass).toBe("network");
    expect(classifiedDirect.retryable).toBe(true);
  });
});

describe("raceAbort", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes chunks through untouched on a healthy stream", async () => {
    const watchdog = createInactivityWatchdog({ inactivityMs: 60_000 });

    async function* healthy(): AsyncGenerator<number> {
      await Promise.resolve();
      yield 1;
      yield 2;
      yield 3;
    }

    const seen: number[] = [];

    for await (const value of raceAbort(healthy(), watchdog)) {
      seen.push(value);
    }

    watchdog.dispose();

    expect(seen).toEqual([1, 2, 3]);
  });

  it("rejects with LlmTimeoutError when the stream never yields", async () => {
    const watchdog = createInactivityWatchdog({ inactivityMs: 1_000 });

    // A stream that ignores abort signals entirely and never produces.
    const stalled: AsyncIterable<never> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<IteratorResult<never>>(() => undefined),
        };
      },
    };

    const consume = (async () => {
      for await (const value of raceAbort(stalled, watchdog)) {
        void value;
      }
    })();
    // Attach the rejection expectation before advancing time so the
    // rejection is handled the moment it happens.
    const expectation = expect(consume).rejects.toBeInstanceOf(LlmTimeoutError);

    await vi.advanceTimersByTimeAsync(1_000);
    await expectation;

    watchdog.dispose();
  });

  it("stops mid-stream when the watchdog fires between chunks", async () => {
    const watchdog = createInactivityWatchdog({ inactivityMs: 1_000 });

    async function* slowAfterFirst(): AsyncGenerator<string> {
      yield "first";
      await new Promise(() => undefined); // stalls forever
    }

    const seen: string[] = [];
    const consume = (async () => {
      for await (const value of raceAbort(slowAfterFirst(), watchdog)) {
        seen.push(value);
        watchdog.touch();
      }
    })();
    const expectation = expect(consume).rejects.toBeInstanceOf(LlmTimeoutError);

    await vi.advanceTimersByTimeAsync(2_500);
    await expectation;

    watchdog.dispose();

    expect(seen).toEqual(["first"]);
  });
});
