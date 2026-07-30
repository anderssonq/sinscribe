import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createElement } from "react";
import { render, Text } from "ink";
import { describe, expect, it } from "vitest";
import {
  InlinePrompt,
  MainMenu,
  MultilinePrompt,
} from "../src/ui/menu-view.js";
import { Panel, TailPanel } from "../src/ui/panel.js";
import { RunLog, type LogItem } from "../src/ui/run-view.js";

/**
 * Zero-dependency Ink harness: a fake TTY stdout that records every frame
 * Ink writes, and a fake raw-mode-capable stdin. Frame heights are asserted
 * against the fake terminal's rows — the "no overflow at extreme sizes"
 * check the alt-screen residue hazard depends on.
 */

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\[[0-9;?]*[A-Za-z]/gu;

type FakeIO = {
  stdout: NodeJS.WriteStream;
  stdin: NodeJS.ReadStream;
  frames: string[];
};

function createFakeIO(columns: number, rows: number): FakeIO {
  const frames: string[] = [];
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream & {
    columns: number;
    rows: number;
    isTTY: boolean;
    write(chunk: string): boolean;
  };

  stdout.columns = columns;
  stdout.rows = rows;
  stdout.isTTY = true;
  stdout.write = (chunk: string) => {
    frames.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  };

  const emitter = new EventEmitter();
  const stdin = Object.assign(emitter, {
    isTTY: true,
    setRawMode: () => stdin,
    setEncoding: () => stdin,
    ref: () => stdin,
    unref: () => stdin,
    read: () => null,
    resume: () => stdin,
    pause: () => stdin,
  }) as unknown as NodeJS.ReadStream;

  return { stdout, stdin, frames };
}

/** The longest stripped frame — Ink's final unmount write is empty. */
function fullestFrame(frames: string[]): string {
  let fullest = "";

  for (const frame of frames) {
    const stripped = frame.replace(ANSI_PATTERN, "");

    if (stripped.length > fullest.length) {
      fullest = stripped;
    }
  }

  return fullest;
}

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

async function renderOnce(
  node: Parameters<typeof render>[0],
  columns: number,
  rows: number,
): Promise<string[]> {
  const io = createFakeIO(columns, rows);
  const instance = render(node, {
    stdout: io.stdout,
    stdin: io.stdin,
    exitOnCtrlC: false,
    patchConsole: false,
  });

  // Let effects (size hooks) settle for a tick before unmounting. The exit
  // promise must be obtained BEFORE unmount() — created afterwards it can
  // never resolve.
  await new Promise((resolve) => setTimeout(resolve, 10));

  const exited = instance.waitUntilExit();

  instance.unmount();
  await exited;

  return io.frames;
}

function makeLog(lines: number): LogItem[] {
  return Array.from({ length: lines }, (_, index) => ({
    id: index + 1,
    type: "text" as const,
    content: `line ${index + 1}`,
  }));
}

describe("UI at extreme terminal sizes", () => {
  const menuSizes: Array<[number, number]> = [
    [40, 15],
    [80, 24],
    [300, 100],
  ];

  for (const [columns, rows] of menuSizes) {
    it(`MainMenu fits ${columns}x${rows}`, async () => {
      const frames = await renderOnce(
        createElement(MainMenu, { isActive: true, onSelect: () => undefined }),
        columns,
        rows,
      );

      expect(frames.length).toBeGreaterThan(0);
      expect(tallestFrameRows(frames)).toBeLessThanOrEqual(rows);
    });
  }

  it("RunLog with maxRows keeps a 200-line log within a 100-row terminal", async () => {
    const frames = await renderOnce(
      createElement(RunLog, { log: makeLog(200), maxRows: 90 }),
      120,
      100,
    );

    expect(tallestFrameRows(frames)).toBeLessThanOrEqual(100);
  });

  it("RunLog without maxRows renders the whole log (print-path behavior)", async () => {
    const frames = await renderOnce(
      createElement(RunLog, { log: makeLog(50) }),
      120,
      100,
    );

    const frame = fullestFrame(frames);

    expect(frame).toContain("line 1");
    expect(frame).toContain("line 50");
  });

  it("Panel renders a titled border at narrow widths without overflow", async () => {
    const frames = await renderOnce(
      createElement(
        Panel,
        { title: "Actions", width: 30 },
        createElement(Text, null, "hello"),
      ),
      30,
      10,
    );

    const frame = fullestFrame(frames);
    const lines = frame.split("\n").filter((line) => line.length > 0);

    expect(lines[0]).toContain("╭─ Actions ");
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(30);
    }
  });

  it("TailPanel counts wrapped rows, not logical lines", async () => {
    // Model output is one long paragraph per line; counting logical lines let
    // a six-row panel render four times that and outgrow the terminal.
    const paragraph = "word ".repeat(200).trim();
    const frames = await renderOnce(
      createElement(TailPanel, {
        text: `${paragraph}\n${paragraph}\n${paragraph}`,
        maxRows: 6,
      }),
      80,
      24,
    );

    // 6 text rows + the hidden-count note + two borders.
    expect(tallestFrameRows(frames)).toBeLessThanOrEqual(9);
    expect(fullestFrame(frames)).toContain("more rows above");
  });

  for (const [columns, rows] of menuSizes) {
    it(`prompts holding a pasted block fit ${columns}x${rows}`, async () => {
      // initialValue is read on mount, so no key driving is needed here.
      const pasted = "Acceptance criteria: the counters refresh. ".repeat(60);

      for (const prompt of [
        createElement(MultilinePrompt, {
          initialValue: pasted,
          isActive: true,
          label: "Requirements & docs — acceptance criteria, business rules",
          onCancel: () => undefined,
          onSubmit: () => undefined,
          placeholder: "…",
        }),
        createElement(InlinePrompt, {
          initialValue: pasted,
          isActive: true,
          label: "Ticket — Jira/business ticket ID",
          onCancel: () => undefined,
          onSubmit: () => undefined,
          placeholder: "…",
        }),
      ]) {
        const frames = await renderOnce(prompt, columns, rows);

        expect(tallestFrameRows(frames)).toBeLessThan(rows);
      }
    });
  }
});
