import { describe, expect, it } from "vitest";
import { KiroOutputCleaner } from "../src/llm/kiro-cli/output.js";

/** Feeds the whole text as one chunk. */
function cleanWhole(text: string): string {
  const cleaner = new KiroOutputCleaner();

  return cleaner.push(text) + cleaner.flush();
}

/** Feeds one character at a time — the worst case for split escapes. */
function cleanByChar(text: string): string {
  const cleaner = new KiroOutputCleaner();
  let out = "";

  for (const char of text) {
    out += cleaner.push(char);
  }

  return out + cleaner.flush();
}

// Exactly what kiro-cli 2.3.0 writes to stdout for the answer "OK".
const REAL_OK = "\x1b[38;5;141m> \x1b[0mOK";

describe("KiroOutputCleaner", () => {
  it("strips the styling and the answer marker from real output", () => {
    expect(cleanWhole(REAL_OK)).toBe("OK");
  });

  it("produces the same result when the ANSI is split across chunks", () => {
    // The escape "\x1b[38;5;141m" arriving one byte per read must not leak.
    expect(cleanByChar(REAL_OK)).toBe("OK");
  });

  it("keeps multi-line answers intact, marker only at the very start", () => {
    const real =
      "\x1b[m> \x1b[0mfeat: add retry logic\x1b[0m\x1b[0m\n" +
      "\x1b[0m\x1b[0m\n" +
      "Body line here.";

    expect(cleanWhole(real)).toBe("feat: add retry logic\n\nBody line here.");
    expect(cleanByChar(real)).toBe("feat: add retry logic\n\nBody line here.");
  });

  it('only removes "> " at the absolute start, not from later lines', () => {
    const quoted = "\x1b[m> \x1b[0mSee:\n> quoted markdown line";

    expect(cleanWhole(quoted)).toBe("See:\n> quoted markdown line");
  });

  it("leaves output without a marker untouched", () => {
    expect(cleanWhole("\x1b[0mplain answer")).toBe("plain answer");
  });

  it("emits incrementally so a long stream keeps feeding the watchdog", () => {
    const cleaner = new KiroOutputCleaner();
    // The marker is consumed by the first push; later pushes flow straight
    // through rather than being buffered to the end.
    cleaner.push(REAL_OK);

    expect(cleaner.push(" more")).toBe(" more");
    expect(cleaner.push(" and more")).toBe(" and more");
  });

  it("holds back a trailing partial escape until it completes", () => {
    const cleaner = new KiroOutputCleaner();

    cleaner.push("\x1b[38;5;141m> \x1b[0mA");

    // "\x1b[0" is not yet a sequence: it must not be emitted as text.
    expect(cleaner.push("\x1b[0")).toBe("");
    expect(cleaner.push("mB")).toBe("B");
  });

  it("does not swallow a lone ESC that never completes", () => {
    const cleaner = new KiroOutputCleaner();

    cleaner.push("\x1b[0mstart");

    expect(cleaner.push("\x1b")).toBe("");
    // flush() releases whatever was held rather than losing it silently.
    expect(cleaner.flush()).toBe("\x1b");
  });
});
