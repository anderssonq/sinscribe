import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createElement } from "react";
import { render } from "ink";
import { describe, expect, it } from "vitest";
import { InlinePrompt, MultilinePrompt } from "../src/ui/menu-view.js";
import { computeViewport } from "../src/ui/viewport.js";

/**
 * Keyboard-driving Ink harness: like the fake TTY in ui-render.test.ts, but
 * the stdin queues chunks and emits `readable`, which is how Ink's App pulls
 * input. Each press() delivers one raw byte sequence — exactly what a
 * terminal would send — so these tests cover Ink's escape-sequence parsing,
 * the shared editing handler, and the component wiring end to end.
 */

type KeyIO = {
  stdout: NodeJS.WriteStream;
  stdin: NodeJS.ReadStream;
  frames: string[];
  press: (sequence: string) => Promise<void>;
};

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-9;?]*[A-Za-z]/gu;

const TERMINAL_COLUMNS = 80;
const TERMINAL_ROWS = 24;

/**
 * Ink's own escape hatch for a frame it cannot diff: at
 * `outputHeight >= stdout.rows` it writes ansi-escapes' clearTerminal —
 * ESC[2J ESC[3J ESC[H — instead of an incremental update, on every render.
 * The ESC[3J (erase scrollback) is unique to that path, so its absence is an
 * exact assertion that no frame ever outgrew the terminal.
 */
const CLEAR_TERMINAL = "\x1b[3J";

/** A block big enough to have frozen the CLI before it was windowed. */
const PASTED_BLOCK = [
  "Acceptance Criteria",
  "",
  "• Scenario 1: Current Demand mode (existing behavior)",
  "Given: the KPI Counter View is configured in Current Demand mode",
  "And: it has from 1 to 15 KPIs for S/M/L/XL font size",
  "When: a kitchen staff member views the KDS Fulfillment/Production",
  "Then: the food counters display values based on active checks",
]
  .join("\n")
  .repeat(8);

/** The same volume with no newline anywhere — the worst case for wrapping. */
const PASTED_PARAGRAPH = PASTED_BLOCK.replaceAll("\n", " ");

/** Max visible line count across every frame Ink wrote. */
function tallestFrameRows(frames: string[]): number {
  let tallest = 0;

  for (const frame of frames) {
    const stripped = frame.replace(ANSI_PATTERN, "");
    const lines = stripped.split("\n");

    // Trailing newline produces one empty trailing entry; ignore it.
    const height = lines.at(-1) === "" ? lines.length - 1 : lines.length;

    tallest = Math.max(tallest, height);
  }

  return tallest;
}

function createKeyIO(): KeyIO {
  const frames: string[] = [];
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream & {
    columns: number;
    rows: number;
    isTTY: boolean;
    write(chunk: string): boolean;
  };

  stdout.columns = TERMINAL_COLUMNS;
  stdout.rows = TERMINAL_ROWS;
  stdout.isTTY = true;
  stdout.write = (chunk: string) => {
    frames.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  };

  const queue: string[] = [];
  const emitter = new EventEmitter();
  const stdin = Object.assign(emitter, {
    isTTY: true,
    setRawMode: () => stdin,
    setEncoding: () => stdin,
    ref: () => stdin,
    unref: () => stdin,
    read: () => queue.shift() ?? null,
    resume: () => stdin,
    pause: () => stdin,
  }) as unknown as NodeJS.ReadStream;

  const press = async (sequence: string) => {
    queue.push(sequence);
    emitter.emit("readable");
    await new Promise((resolve) => setTimeout(resolve, 5));
  };

  return { stdout, stdin, frames, press };
}

/** Long enough for the paste coalescer's quiet period to elapse and flush. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 40));
}

/**
 * Delivers `text` the way a pty does — in fixed-size reads that fall wherever
 * they fall, including in the middle of a line.
 */
async function pastePieces(
  press: (sequence: string) => Promise<void>,
  text: string,
  size = 1024,
): Promise<void> {
  for (let index = 0; index < text.length; index += size) {
    await press(text.slice(index, index + size));
  }

  await settle();
}

async function withPrompt(
  node: Parameters<typeof render>[0],
  run: (io: KeyIO) => Promise<void>,
): Promise<void> {
  const io = createKeyIO();
  const instance = render(node, {
    stdout: io.stdout,
    stdin: io.stdin,
    exitOnCtrlC: false,
    patchConsole: false,
  });

  // Let useInput's effect subscribe before pressing keys.
  await new Promise((resolve) => setTimeout(resolve, 10));

  try {
    await run(io);
  } finally {
    const exited = instance.waitUntilExit();

    instance.unmount();
    await exited;
  }
}

describe("MultilinePrompt driven by raw key sequences", () => {
  function prompt(onSubmit: (value: string) => void) {
    return createElement(MultilinePrompt, {
      label: "Test",
      placeholder: "type here",
      isActive: true,
      onSubmit,
      onCancel: () => undefined,
    });
  }

  it("jumps a word left on option+arrow (xterm \\x1b[1;3D) and inserts there", async () => {
    let submitted = "";

    await withPrompt(
      prompt((value) => {
        submitted = value;
      }),
      async (io) => {
        await io.press("hello world");
        await io.press("\x1b[1;3D");
        await io.press("X");
        await io.press("\x04");
      },
    );

    expect(submitted).toBe("hello Xworld");
  });

  it("deletes the previous word on option+backspace (\\x1b\\x7f)", async () => {
    let submitted = "";

    await withPrompt(
      prompt((value) => {
        submitted = value;
      }),
      async (io) => {
        await io.press("hello world");
        await io.press("\x1b\x7f");
        await io.press("\x04");
      },
    );

    expect(submitted).toBe("hello");
  });

  it("word-jumps on esc+b and forward-deletes a word on esc+d", async () => {
    let submitted = "";

    await withPrompt(
      prompt((value) => {
        submitted = value;
      }),
      async (io) => {
        await io.press("hello world");
        await io.press("\x1bb");
        await io.press("\x1bd");
        await io.press("\x04");
      },
    );

    expect(submitted).toBe("hello");
  });

  it("keeps the frame within its historical height when both scroll indicators show", async () => {
    let frames: string[] = [];

    await withPrompt(
      prompt(() => undefined),
      async (io) => {
        frames = io.frames;
        await io.press(
          "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten",
        );
        for (let i = 0; i < 6; i += 1) {
          await io.press("\x1b[A");
        }
      },
    );

    // The box now sizes itself from the viewport, so the bound is the view
    // budget itself: label + 2 borders + footer + the text rows and one
    // indicator row, all of which computePromptRows fits inside contentRows.
    expect(tallestFrameRows(frames)).toBeLessThanOrEqual(
      computeViewport(TERMINAL_COLUMNS, TERMINAL_ROWS).contentRows,
    );
    expect(tallestFrameRows(frames)).toBeLessThan(TERMINAL_ROWS);
  });

  it("keeps a huge paste inside the frame instead of freezing the terminal", async () => {
    let frames: string[] = [];
    let submitted = "";

    await withPrompt(
      prompt((value) => {
        submitted = value;
      }),
      async (io) => {
        frames = io.frames;
        await pastePieces(io.press, PASTED_BLOCK);
        await io.press("\x04");
      },
    );

    expect(tallestFrameRows(frames)).toBeLessThan(TERMINAL_ROWS);
    expect(frames.join("")).not.toContain(CLEAR_TERMINAL);
    // The whole paste is in the buffer — only its rendering is windowed.
    expect(submitted).toBe(PASTED_BLOCK.trim());
  });

  it("bounds a paste with no newline to break on, the worst case for wrapping", async () => {
    let frames: string[] = [];

    await withPrompt(
      prompt(() => undefined),
      async (io) => {
        frames = io.frames;
        await pastePieces(io.press, PASTED_PARAGRAPH);
      },
    );

    expect(tallestFrameRows(frames)).toBeLessThan(TERMINAL_ROWS);
    expect(frames.join("")).not.toContain(CLEAR_TERMINAL);
  });

  it("coalesces a chunked paste into a handful of frames", async () => {
    let frames: string[] = [];

    await withPrompt(
      prompt(() => undefined),
      async (io) => {
        frames = io.frames;
        // Many small reads, the way a pty delivers a paste; Ink would
        // otherwise commit and repaint once per read.
        await pastePieces(io.press, PASTED_PARAGRAPH, 256);
      },
    );

    expect(frames.length).toBeLessThanOrEqual(6);
  });
});

describe("InlinePrompt driven by raw key sequences", () => {
  function inlinePrompt(onSubmit: (value: string) => void) {
    return createElement(InlinePrompt, {
      label: "Test",
      placeholder: "type here",
      isActive: true,
      onSubmit,
      onCancel: () => undefined,
    });
  }

  it("stays one row tall however much text is pasted into it", async () => {
    let frames: string[] = [];
    let submitted = "";

    await withPrompt(
      inlinePrompt((value) => {
        submitted = value;
      }),
      async (io) => {
        frames = io.frames;
        await pastePieces(io.press, PASTED_PARAGRAPH);
        await io.press("\r");
      },
    );

    // label + 2 borders + the single text row + footer.
    expect(tallestFrameRows(frames)).toBe(5);
    expect(frames.join("")).not.toContain(CLEAR_TERMINAL);
    expect(submitted).toBe(PASTED_PARAGRAPH.trim());
  });

  it("does not submit half a paste when a chunk boundary leaves a bare return", async () => {
    let submitted: string | null = null;

    await withPrompt(
      inlinePrompt((value) => {
        submitted = value;
      }),
      async (io) => {
        // The pty split the block so a carriage return arrived on its own.
        await io.press("one two");
        await io.press("\r");
        await io.press("three four");
        await settle();
      },
    );

    expect(submitted).toBeNull();
  });

  it("moves the cursor on plain arrows instead of eating characters", async () => {
    let submitted = "";

    await withPrompt(
      createElement(InlinePrompt, {
        label: "Test",
        placeholder: "type here",
        isActive: true,
        onSubmit: (value: string) => {
          submitted = value;
        },
        onCancel: () => undefined,
      }),
      async (io) => {
        await io.press("ab");
        await io.press("\x1b[D");
        await io.press("X");
        await io.press("\r");
      },
    );

    expect(submitted).toBe("aXb");
  });
});
