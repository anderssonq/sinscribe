import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createElement } from "react";
import { Text } from "ink";
import { render } from "ink";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { GlobalFlags } from "../src/commands.js";
import { RECOVERY_DIRECTION } from "../src/domain/recover-evidence.js";
import type {
  SessionDraft,
  SessionDraftRequest,
} from "../src/domain/session-draft.js";
import { loadSession } from "../src/session/store.js";
import { MenuApp } from "../src/ui/menu-app.js";
import { git, initRepo, makeTempDir, removeDir } from "./git-fixture.js";

/** Ink checks `CI` once, on import; this flow needs the interactive renderer. */
const originalCi = vi.hoisted(() => {
  const value = process.env.CI;

  process.env.CI = "false";

  return value;
});

afterAll(() => {
  if (originalCi === undefined) {
    delete process.env.CI;
  } else {
    process.env.CI = originalCi;
  }
});

const calls = vi.hoisted(() => ({
  requests: [] as SessionDraftRequest[],
  options: [] as unknown[],
}));

vi.mock("../src/domain/session-draft.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../src/domain/session-draft.js")>();

  return {
    ...original,
    createSessionDraftRun: (
      _flags: unknown,
      _cwd: string,
      options: unknown,
    ) => {
      calls.options.push(options);

      return Promise.resolve({
        meta: {
          branch: "kiro/ABC-123",
          baseRef: "main",
          ticket: "ABC-123",
          commits: 2,
          changedFiles: 3,
          handoff: false,
          docs: 1,
          exploreKind: "claude-cli",
          recovery: { candidates: 3, diagnosis: "/tmp/failure.md" },
        },
        generate: (request: SessionDraftRequest) => {
          calls.requests.push(request);

          return Promise.resolve(DRAFT);
        },
      });
    },
  };
});

// The plan flow would start generating a stage; only the hand-off matters here.
vi.mock("../src/ui/plan-flow.js", () => ({
  PlanFlow: () => createElement(Text, null, "PLAN FLOW OPENED"),
}));

const DRAFT: SessionDraft = {
  feature: `${RECOVERY_DIRECTION}\n\nPredictive bin alerts; blocked on the threshold test.`,
  ticket: "ABC-123",
  requirements:
    "- Alert within 2 hours\n- Failure: the threshold test expects 7200, the code uses 120\n- Remaining: wire the scheduler",
  baseRef: "main",
  sources: [{ path: "docs/spec.md", why: "acceptance criteria" }],
  openQuestions: [],
  mode: "claude-cli-readonly",
  filesRead: ["docs/spec.md"],
  fallbackReason: null,
};

const FLAGS: GlobalFlags = {
  dryRun: false,
  print: false,
  modelId: null,
  // A local-cli provider: no credential wizard before the menu.
  provider: "claude-cli",
  apiKey: null,
};

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001B\[[0-9;?]*[A-Za-z]/gu;
const ENTER = "\r";
const DOWN = "\u001B[B";
const SUBMIT = "\u0004";

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

    await new Promise((resolve) => setTimeout(resolve, 80));
  };

  return { stdout, stdin, frames, press };
}

type Step = { waitFor: string; key: string | null };

const step = (waitFor: string, key: string | null): Step => ({
  waitFor,
  key,
});

async function waitForText(
  frames: string[],
  from: number,
  text: string,
): Promise<void> {
  for (let attempt = 0; attempt < 1500; attempt++) {
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

/** Renders the menu as `sinscribe recover` does and walks the steps. */
async function drive(
  columns: number,
  rows: number,
  steps: Step[],
): Promise<string[]> {
  const io = createFakeIO(columns, rows);
  const instance = render(
    createElement(MenuApp, {
      flags: FLAGS,
      initialRecovery: { diagnosisPath: "/tmp/failure.md" },
    }),
    {
      stdout: io.stdout,
      stdin: io.stdin,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  );
  let seen = 0;

  try {
    for (const { waitFor, key } of steps) {
      await waitForText(io.frames, seen, waitFor);
      seen = io.frames.length;

      if (key !== null) {
        await io.press(key);
      }
    }
  } finally {
    const exited = instance.waitUntilExit();

    instance.unmount();
    await exited;
  }

  return io.frames.map((frame) => frame.replace(ANSI_PATTERN, ""));
}

function tallest(frames: string[]): number {
  return Math.max(
    ...frames.map((frame) => frame.split("\n").filter(Boolean).length),
  );
}

let repo: string;
let cwd: string;

beforeEach(async () => {
  cwd = process.cwd();
  repo = await makeTempDir("sinscribe-recover-ui-");
  await initRepo(repo);
  await git(repo, "checkout", "-b", "kiro/ABC-123");
  process.chdir(repo);
  calls.requests.length = 0;
  calls.options.length = 0;
});

afterEach(async () => {
  process.chdir(cwd);
  await removeDir(repo);
});

describe("MenuApp in recovery mode", () => {
  it("drafts with the recovery goal, saves on approval, then opens the bugfix prompt", async () => {
    const frames = await drive(100, 40, [
      step("Recovery goal", SUBMIT),
      step("How should the AI gather evidence?", ENTER),
      step("Proposed session context", ENTER), // Approve and save
      step("Recovery context saved for kiro/ABC-123", ENTER), // Quick fix
      step("Bug — what is broken?", null),
    ]);
    const text = frames.join("\n");

    // The branch has no context yet: the menu must not swap the recovery
    // draft for its "how do you want to create it?" question.
    expect(text).not.toContain("No session context for");
    expect(text).toContain("Recovery: 3 files the pipeline left");
    expect(calls.options[0]).toMatchObject({
      previous: null,
      recovery: { diagnosisPath: "/tmp/failure.md" },
    });
    expect(calls.requests[0]).toEqual({
      feedback: null,
      direction: RECOVERY_DIRECTION,
      explore: true,
    });

    const session = await loadSession(repo, "kiro/ABC-123");

    expect(session?.context?.requirements).toContain(
      "Failure: the threshold test expects 7200",
    );
  });

  it("hands a heavier rework to the spec plan", async () => {
    const frames = await drive(100, 40, [
      step("Recovery goal", SUBMIT),
      step("How should the AI gather evidence?", ENTER),
      step("Proposed session context", ENTER),
      step("Recovery context saved", DOWN),
      step("Rework — spec plan", ENTER),
      step("PLAN FLOW OPENED", null),
    ]);

    expect(frames.join("\n")).toContain("PLAN FLOW OPENED");
  });

  it("returns to the menu when the recovery draft is cancelled", async () => {
    const frames = await drive(100, 40, [
      step("Recovery goal", "\u001B"),
      step("Interactive chat", null),
    ]);

    const afterCancel = frames.slice(
      frames.findIndex((frame) => frame.includes("Recovery goal")) + 1,
    );

    expect(calls.requests).toEqual([]);
    // Back on the action list, not on the "no session context" question.
    expect(
      afterCancel.some((frame) => frame.includes("Interactive chat")),
    ).toBe(true);
  });

  it.each([
    [80, 24],
    [60, 20],
    [40, 15],
  ])(
    "keeps every recovery screen inside a %ix%i terminal",
    async (columns, rows) => {
      const frames = await drive(columns, rows, [
        step("Recovery goal", SUBMIT),
        step("How should the AI gather evidence?", ENTER),
        // The heading above it gives way on the smallest size; the list stays.
        step("Does this capture the session?", ENTER),
        step("Recovery context saved", null),
      ]);

      expect(tallest(frames)).toBeLessThan(rows);
    },
  );
});
