import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CliError } from "../src/domain/errors.js";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ spawn: spawnMock }));

const { copyToClipboard, getClipboardCommands } =
  await import("../src/util/clipboard.js");

type FakeChildBehavior =
  { kind: "exit"; code: number } | { kind: "spawn-error" };

function fakeChild(behavior: FakeChildBehavior, received: string[]) {
  const child = new EventEmitter() as EventEmitter & {
    stdin: EventEmitter & { end: (text: string) => void };
  };
  const stdin = new EventEmitter() as EventEmitter & {
    end: (text: string) => void;
  };

  stdin.end = (text: string) => {
    received.push(text);
    queueMicrotask(() => {
      if (behavior.kind === "spawn-error") {
        child.emit(
          "error",
          Object.assign(new Error("spawn"), { code: "ENOENT" }),
        );
      } else {
        child.emit("close", behavior.code);
      }
    });
  };
  child.stdin = stdin;

  return child;
}

describe("getClipboardCommands", () => {
  it("selects pbcopy on macOS and clip on Windows", () => {
    expect(getClipboardCommands("darwin", {})).toEqual([
      { command: "pbcopy", args: [] },
    ]);
    expect(getClipboardCommands("win32", {})).toEqual([
      { command: "clip", args: [] },
    ]);
  });

  it("prefers X11 utilities on Linux without Wayland", () => {
    expect(
      getClipboardCommands("linux", {}).map((entry) => entry.command),
    ).toEqual(["xclip", "xsel", "wl-copy"]);
  });

  it("prefers wl-copy when WAYLAND_DISPLAY is set", () => {
    expect(
      getClipboardCommands("linux", { WAYLAND_DISPLAY: "wayland-0" }).map(
        (entry) => entry.command,
      ),
    ).toEqual(["wl-copy", "xclip", "xsel"]);
  });

  it("returns no candidates for unknown platforms", () => {
    expect(getClipboardCommands("freebsd", {})).toEqual([]);
  });
});

describe("copyToClipboard", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it("writes the text to the first working utility", async () => {
    const received: string[] = [];

    spawnMock.mockImplementation(() =>
      fakeChild({ kind: "exit", code: 0 }, received),
    );

    await copyToClipboard("PR body");

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(received).toEqual(["PR body"]);
  });

  it("falls through to the next candidate when the first is missing", async () => {
    const received: string[] = [];

    spawnMock
      .mockImplementationOnce(() =>
        fakeChild({ kind: "spawn-error" }, received),
      )
      .mockImplementationOnce(() =>
        fakeChild({ kind: "exit", code: 0 }, received),
      );

    await copyToClipboard("text", getClipboardCommands("linux", {}));

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(received).toEqual(["text", "text"]);
  });

  it("rejects with a CliError when every candidate fails", async () => {
    const received: string[] = [];

    spawnMock.mockImplementation(() =>
      fakeChild({ kind: "exit", code: 1 }, received),
    );

    await expect(
      copyToClipboard("text", getClipboardCommands("linux", {})),
    ).rejects.toBeInstanceOf(CliError);
    expect(spawnMock).toHaveBeenCalledTimes(3);
  });
});
