import { useEffect, useRef } from "react";
import { useInput, type Key } from "ink";
import { isMouseNoise } from "./editor.js";

/**
 * Paste-aware keyboard input for the text prompts.
 *
 * Ink emits one input event per OS read (`App.handleReadable` loops
 * `stdin.read()`), and a pty hands a paste over in ~1 KB pieces — so pasting
 * 50 KB used to mean ~49 synchronous React commits, each paying a full Yoga
 * layout pass over the whole accumulated text. Coalescing the pieces into a
 * single insert turns that back into one commit.
 *
 * The other half of the problem is that a chunk boundary can leave a bare
 * "\r" of its own, which Ink reports as `key.return` — mid-paste, that
 * submitted half the text and dropped the rest. Inside a paste burst a bare
 * return is treated as part of the pasted text instead. (Bracketed paste would
 * mark the boundaries explicitly, but Ink 5 neither enables nor parses it, and
 * `useInput` still sees the raw bytes, so timing is what we have.)
 */

/** Quiet period after the last chunk before a coalesced paste is inserted. */
const PASTE_QUIET_MS = 12;
/** Ceiling on the whole burst, so a steady stream still lands promptly. */
const PASTE_MAX_MS = 50;
/**
 * How recently a chunk must have arrived for a bare return to count as part
 * of the paste rather than a submit. Normally the pending buffer answers that
 * on its own; this only covers the moment right after a long burst hits
 * PASTE_MAX_MS and flushes while its chunks are still streaming in. Kept far
 * below human reaction time so a real enter is never swallowed.
 */
const PASTE_RETURN_MS = 8;

const PASTE_KEY: Key = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
};

/** `pasted` marks a coalesced chunk, which callers insert verbatim. */
export type TextInputHandler = (
  value: string,
  key: Key,
  pasted: boolean,
) => void;

export function useTextInput(
  handler: TextInputHandler,
  options: { isActive?: boolean } = {},
): void {
  const handlerRef = useRef(handler);
  const pending = useRef("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const burstStart = useRef(0);
  const lastChunk = useRef(0);

  handlerRef.current = handler;

  useEffect(
    () => () => {
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    },
    [],
  );

  function flush(): void {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }

    const text = pending.current;

    if (text.length === 0) {
      return;
    }

    pending.current = "";
    handlerRef.current(text, PASTE_KEY, true);
  }

  function collect(text: string): void {
    const now = Date.now();

    if (pending.current.length === 0) {
      burstStart.current = now;
    }

    pending.current += text;
    lastChunk.current = now;

    if (timer.current !== null) {
      clearTimeout(timer.current);
    }

    const waited = now - burstStart.current;

    if (waited >= PASTE_MAX_MS) {
      flush();
      return;
    }

    timer.current = setTimeout(
      flush,
      Math.min(PASTE_QUIET_MS, PASTE_MAX_MS - waited),
    );
  }

  useInput((value, key) => {
    const isChunk =
      value.length > 1 && !key.ctrl && !key.meta && !isMouseNoise(value);

    if (isChunk) {
      collect(value);
      return;
    }

    const inBurst =
      pending.current.length > 0 ||
      Date.now() - lastChunk.current < PASTE_RETURN_MS;

    if (key.return && inBurst) {
      collect("\n");
      return;
    }

    // Anything else ends the burst: flush first so the pasted text lands
    // before the key that follows it.
    flush();
    handlerRef.current(value, key, false);
  }, options);
}
