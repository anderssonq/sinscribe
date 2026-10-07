import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createElement } from "react";
import { render } from "ink";
import { describe, expect, it, vi } from "vitest";
import type { GlobalFlags } from "../src/commands.js";
import type {
  SessionDraft,
  SessionDraftRequest,
} from "../src/domain/session-draft.js";
import {
  SessionDraftFlow,
  type SessionDraftOutcome,
} from "../src/ui/session-draft-review.js";

const requests = vi.hoisted(() => [] as SessionDraftRequest[]);

vi.mock("../src/domain/session-draft.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../src/domain/session-draft.js")>();

  return {
    ...original,
    createSessionDraftRun: () =>
      Promise.resolve({
        meta: {
          branch: "feat/ABC-123-uploader-retry",
          baseRef: "main",
          ticket: "ABC-123",
          commits: 2,
          changedFiles: 3,
          handoff: false,
          docs: 4,
          exploreKind: "claude-cli",
        },
        generate: (request: SessionDraftRequest) => {
          requests.push(request);

          return Promise.resolve(DRAFT);
        },
      }),
  };
});

const DRAFT: SessionDraft = {
  feature: `retry uploads\n\n${"Why the retries matter. ".repeat(40)}`,
  ticket: "ABC-123",
  requirements: Array.from({ length: 30 }, (_, i) => `- Rule ${i + 1}`).join(
    "\n",
  ),
  baseRef: "main",
  sources: [{ path: "docs/uploader-report.md", why: "the incident" }],
  openQuestions: ["Should large files be retried?"],
  mode: "claude-cli-readonly",
  filesRead: ["docs/uploader-report.md"],
  fallbackReason: null,
};

const FLAGS: GlobalFlags = {
  dryRun: false,
  print: false,
  modelId: null,
  provider: null,
  apiKey: null,
};

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001B\[[0-9;?]*[A-Za-z]/gu;
const ENTER = "\r";
const DOWN = "\u001B[B";
const SUBMIT = "\u0004";

/** The same fake TTY the ui-render tests use, trimmed to what this flow needs. */
function createFakeIO(columns: number, rows: number) {
  const frames: string[] = [];
  const stdout = Object.assign(new PassThrough(), {
    columns,
    rows,
    isTTY: true,
    write: (chunk: string) => {
      frames.push(String(chunk));
      return true;
    },
  }) as unknown as NodeJS.WriteStream;
  const emitter = new EventEmitter();
  const queue: string[] = [];
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

    for (let attempt = 0; attempt < 100 && queue.length > 0; attempt++) {
      emitter.emit("readable");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    // Ink throttles renders; give each screen time to be written.
    await new Promise((resolve) => setTimeout(resolve, 80));
  };

  return { stdout, stdin, frames, press };
}

/**
 * One key, sent once the screen it is meant for has been written: fixed
 * sleeps lose to a loaded machine, where Ink's throttled renders land late.
 */
type Step = { waitFor: string | null; key: string };

const step = (waitFor: string | null, key: string): Step => ({ waitFor, key });

async function waitForText(
  frames: string[],
  from: number,
  text: string,
): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (
      frames
        .slice(from)
        .some((frame) => frame.replace(ANSI_PATTERN, "").includes(text))
    ) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`Screen never showed: ${text}`);
}

async function drive(
  columns: number,
  rows: number,
  steps: Step[],
): Promise<{ frames: string[]; outcome: SessionDraftOutcome | null }> {
  const io = createFakeIO(columns, rows);
  let outcome: SessionDraftOutcome | null = null;
  const instance = render(
    createElement(SessionDraftFlow, {
      flags: FLAGS,
      previous: null,
      isActive: true,
      onDone: (result: SessionDraftOutcome) => {
        outcome = result;
      },
    }),
    {
      stdout: io.stdout,
      stdin: io.stdin,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  );

  let seen = 0;

  for (const { waitFor, key } of steps) {
    if (waitFor !== null) {
      await waitForText(io.frames, seen, waitFor);
    }

    seen = io.frames.length;
    await io.press(key);
  }

  await new Promise((resolve) => setTimeout(resolve, 50));

  const exited = instance.waitUntilExit();

  instance.unmount();
  await exited;

  return {
    frames: io.frames.map((frame) => frame.replace(ANSI_PATTERN, "")),
    outcome,
  };
}

function tallest(frames: string[]): number {
  return Math.max(
    ...frames.map((frame) => frame.split("\n").filter(Boolean).length),
  );
}

describe("SessionDraftFlow", () => {
  it("goes direction → read the code → review → save with open questions", async () => {
    requests.length = 0;

    const { frames, outcome } = await drive(100, 40, [
      step("Direction", "retry uploads"),
      step("retry uploads", SUBMIT),
      step("How should the AI gather evidence?", ENTER),
      step("Proposed session context", ENTER), // Approve and save
      step("still unanswered", DOWN),
      step("Save with the questions —", ENTER),
    ]);
    const text = frames.join("\n");

    expect(text).toContain("4 markdown docs");
    expect(text).toContain("Direction");
    expect(text).toContain("Proposed session context");
    expect(text).toContain("docs/uploader-report.md");
    expect(text).toContain("1 open question still unanswered");
    expect(requests[0]).toEqual({
      feedback: null,
      direction: "retry uploads",
      explore: true,
    });
    expect(outcome).toMatchObject({ status: "approved" });
    expect(
      outcome?.status === "approved" ? outcome.context.requirements : "",
    ).toContain("Open questions:\n- Should large files be retried?");
  });

  it("sends a new goal as feedback that replaces the direction", async () => {
    requests.length = 0;

    await drive(100, 40, [
      step("Direction", "retry uploads"),
      step("retry uploads", SUBMIT),
      step("How should the AI gather evidence?", DOWN),
      step("Don't read the code —", ENTER),
      step("Proposed session context", DOWN),
      step("Refine the goal —", ENTER),
      step("New direction", "only the retry policy"),
      step("only the retry policy", SUBMIT),
    ]);

    expect(requests[0]?.explore).toBe(false);
    expect(requests[1]).toMatchObject({
      direction: "only the retry policy",
      explore: false,
    });
  });

  for (const [columns, rows] of [
    [40, 15],
    [80, 24],
  ] as const) {
    it(`keeps the review inside a ${columns}x${rows} terminal`, async () => {
      const { frames } = await drive(columns, rows, [
        step("Direction", "retry uploads"),
        step("retry uploads", SUBMIT),
        step("gather evidence", ENTER),
        step("Approve and save", ""),
      ]);

      expect(frames.join("\n")).toContain("Approve and save");
      expect(tallest(frames)).toBeLessThan(rows);
    });
  }
});
