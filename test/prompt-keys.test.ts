import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createElement } from "react";
import { render } from "ink";
import { describe, expect, it } from "vitest";
import { InlinePrompt, MultilinePrompt } from "../src/ui/menu-view.js";

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

  stdout.columns = 80;
  stdout.rows = 24;
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

    // label + 2 border rows + footer + in-box rows, where the in-box budget
    // is visibleLines (6) + one indicator row — the pre-cursor worst case.
    expect(tallestFrameRows(frames)).toBeLessThanOrEqual(11);
  });
});

describe("InlinePrompt driven by raw key sequences", () => {
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
