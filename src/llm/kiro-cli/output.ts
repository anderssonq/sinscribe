/**
 * Cleans Kiro CLI's human-facing stdout into plain model text.
 *
 * `kiro-cli chat --no-interactive` is a TUI, not a text API: it colors its
 * output and prefixes the answer with "> ", and it does so even under
 * NO_COLOR=1 (verified against kiro-cli 2.3.0). Its stdout for `OK` is
 * literally `\x1b[38;5;141m> \x1b[0mOK`.
 *
 * The cleaning is incremental rather than a single pass at the end, because
 * the caller's inactivity watchdog is fed by emitted chunks — buffering the
 * whole answer would look like a stall on a long generation. That means an
 * escape sequence can arrive split across two stdout reads, so a partial
 * tail is held back until the next chunk completes it.
 */

// Matching the real ESC byte is the whole job here, so the control-character
// rule is the wrong guard for these two patterns specifically.
/* eslint-disable no-control-regex */

/** A complete CSI sequence (colors, cursor moves — everything kiro emits). */
const ANSI_COMPLETE = /\x1b\[[0-9;?]*[A-Za-z]/gu;

/** An escape sequence cut off by a chunk boundary: hold it for the next read. */
const ANSI_PARTIAL_TAIL = /\x1b(?:\[[0-9;?]*)?$/u;

/* eslint-enable no-control-regex */

/** kiro-cli's assistant marker, emitted once before the answer. */
const ANSWER_PREFIX = "> ";

export class KiroOutputCleaner {
  /** A partial escape sequence carried over from the previous chunk. */
  #pendingEscape = "";
  /** Visible text held back while deciding whether it starts with "> ". */
  #pendingStart = "";
  #prefixHandled = false;

  /** Feeds one stdout chunk; returns the text that is safe to emit now. */
  push(chunk: string): string {
    return this.#clean(chunk, false);
  }

  /** Releases anything still held back once stdout closes. */
  flush(): string {
    return this.#clean("", true);
  }

  #clean(chunk: string, final: boolean): string {
    let text = this.#pendingEscape + chunk;

    this.#pendingEscape = "";

    if (!final) {
      // A trailing "\x1b[3" is not yet a sequence — wait for the rest.
      const partial = ANSI_PARTIAL_TAIL.exec(text);

      if (partial !== null) {
        this.#pendingEscape = partial[0];
        text = text.slice(0, text.length - partial[0].length);
      }
    }

    const visible = text.replace(ANSI_COMPLETE, "");

    if (this.#prefixHandled) {
      return visible;
    }

    this.#pendingStart += visible;

    // Decide only once "> " could be distinguished from a real "…" start.
    if (this.#pendingStart.length < ANSWER_PREFIX.length && !final) {
      return "";
    }

    this.#prefixHandled = true;

    const started = this.#pendingStart;

    this.#pendingStart = "";

    return started.startsWith(ANSWER_PREFIX)
      ? started.slice(ANSWER_PREFIX.length)
      : started;
  }
}
