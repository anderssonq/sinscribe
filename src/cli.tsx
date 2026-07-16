#!/usr/bin/env node
import "./ui/no-color.js";
import type { ReactElement } from "react";
import { render } from "ink";
import { getHelpText, parseCommand, type CliCommand } from "./commands.js";
import { needsCredentialSetup } from "./credentials.js";
import { CliError } from "./domain/errors.js";
import {
  executeCommand,
  executeDryRun,
  isOfflineCommand,
} from "./domain/execute.js";
import { loadSinscribeEnv } from "./env.js";
import { NotAGitRepositoryError } from "./git/repo.js";
import type { RunEvent } from "./llm/events.js";
import { ChatApp } from "./ui/chat-app.js";
import { MenuApp } from "./ui/menu-app.js";
import { RunApp } from "./ui/run-app.js";
import { getErrorMessage, isDebugMode } from "./ui/shared.js";
import {
  ENTER_ALT_SCREEN,
  installTerminalCleanup,
  LEAVE_ALT_SCREEN,
  markActive,
  resetTerminalBackground,
  setTerminalBackground,
  supportsBackgroundControl,
} from "./ui/term.js";
import { initThemeFromEnv, theme } from "./ui/theme.js";

type RunCommand = Extract<CliCommand, { kind: "run" }>;

/**
 * Global failure nets. Without these, an unhandled rejection (Node's default
 * is a hard crash) or a stray exception could leave the terminal in raw/alt
 * mode with no message — the process guards print a clear error and exit;
 * installTerminalCleanup's process-exit handler restores the terminal.
 * Installed unconditionally so print/offline runs get SIGINT/SIGTERM/SIGHUP
 * handling too, not just interactive Ink sessions.
 */
function installProcessGuards(): void {
  // exitWhenFlushed (not a bare process.exit) so the error message itself
  // is guaranteed to flush before the process dies.
  process.on("unhandledRejection", (reason) => {
    process.stderr.write(`Unexpected error: ${getErrorMessage(reason)}\n`);
    process.exitCode = 1;
    exitWhenFlushed();
  });

  process.on("uncaughtException", (error) => {
    process.stderr.write(`Unexpected error: ${getErrorMessage(error)}\n`);
    process.exitCode = 1;
    exitWhenFlushed();
  });

  installTerminalCleanup();
}

/**
 * Forces the process to exit once stdout/stderr have flushed. Node only
 * exits when the event loop drains, so a lingering keep-alive socket or SDK
 * timer would otherwise hang the CLI after its output was already printed —
 * the intermittent "freeze" that forced a terminal kill. The empty writes
 * queue behind every earlier write, so their callbacks fire only after all
 * real output has flushed (safe when stdout is a pipe).
 */
function exitWhenFlushed(): void {
  const code = typeof process.exitCode === "number" ? process.exitCode : 0;
  let pending = 2;
  const done = (): void => {
    pending -= 1;

    if (pending === 0) {
      process.exit(code);
    }
  };

  process.stdout.write("", done);
  process.stderr.write("", done);
}

/** One-shot path used by -p/--print and non-TTY runs. No Ink. */
async function runPrint(command: RunCommand): Promise<void> {
  try {
    const result = await executeCommand(
      command.command,
      command.flags,
      process.cwd(),
      { debug: isDebugMode(), onEvent: printDebugEvent },
    );

    process.stdout.write(`${result}\n`);
    process.exitCode = 0;
  } catch (error) {
    process.stderr.write(`${getErrorMessage(error)}\n`);
    process.exitCode = 1;
  }
}

function printDebugEvent(event: RunEvent): void {
  if (event.type === "status") {
    process.stderr.write(`~ ${event.message}\n`);
    return;
  }

  if (event.type === "debug" && isDebugMode()) {
    process.stderr.write(`- ${event.message}\n`);
  }
}

/**
 * Renders an interactive Ink app with the carbon terminal background applied
 * on entry and restored on every exit path (normal exit and Ctrl+C resolve
 * waitUntilExit so the finally runs; signals/crashes are covered by
 * installTerminalCleanup's process-exit net). The dark background is what
 * makes the monochrome palette readable regardless of the user's terminal
 * theme. With `altScreen`, the app takes over the alternate screen buffer and
 * restores it on exit — required for the menu's mouse hit-testing, which
 * needs a fixed layout origin.
 */
async function renderInteractive(
  node: ReactElement,
  options: { altScreen?: boolean } = {},
): Promise<void> {
  installTerminalCleanup();
  const useBackground = supportsBackgroundControl();
  const useAltScreen = options.altScreen === true && process.stdout.isTTY;

  if (useBackground) {
    setTerminalBackground(theme.bg);
    markActive("bg", true);
  }

  if (useAltScreen) {
    process.stdout.write(ENTER_ALT_SCREEN);
    markActive("alt", true);
  }

  try {
    const instance = render(node);

    await instance.waitUntilExit();
  } finally {
    if (useAltScreen) {
      process.stdout.write(LEAVE_ALT_SCREEN);
      markActive("alt", false);
    }

    if (useBackground) {
      resetTerminalBackground();
      markActive("bg", false);
    }
  }
}

async function main(): Promise<void> {
  installProcessGuards();

  const command = parseCommand(process.argv.slice(2));

  if (command.kind === "help") {
    process.stdout.write(`${getHelpText()}\n`);
    process.exitCode = 0;
    return;
  }

  if (command.kind === "error") {
    process.stderr.write(
      `${command.message}\nRun sinscribe --help for usage.\n`,
    );
    process.exitCode = 1;
    return;
  }

  // Dry runs and template management never touch credentials or the network.
  if (command.flags.dryRun) {
    try {
      process.stdout.write(
        `${await executeDryRun(command.command, process.cwd())}\n`,
      );
      process.exitCode = 0;
    } catch (error) {
      process.stderr.write(`${getErrorMessage(error)}\n`);
      process.exitCode = 1;
    }
    return;
  }

  if (isOfflineCommand(command.command)) {
    try {
      process.stdout.write(
        `${await executeCommand(command.command, command.flags, process.cwd())}\n`,
      );
      process.exitCode = 0;
    } catch (error) {
      process.stderr.write(`${getErrorMessage(error)}\n`);
      process.exitCode = 1;
    }
    return;
  }

  // LLM-backed from here on: load saved env before deciding anything.
  await loadSinscribeEnv();
  // Apply the persisted theme now that ~/.sinscribe/.env is in process.env,
  // so the interactive background (OSC 11) uses the right palette from frame 1.
  initThemeFromEnv();

  if (command.flags.print || !process.stdin.isTTY) {
    if (needsCredentialSetup(command.flags.provider, command.flags.apiKey)) {
      process.stderr.write(
        "Credentials are required for non-interactive runs. Run sinscribe in an interactive terminal to set them up (API key, or AWS SSO sign-in for Kiro), or set the provider API key in the environment.\n",
      );
      process.exitCode = 1;
      return;
    }

    await runPrint(command);
    return;
  }

  if (command.command.name === "chat") {
    // Bare invocation: menu-driven dashboard. With a message: chat session.
    if (command.command.message === null) {
      // Alt-screen clips content taller than the viewport, and generated
      // text would vanish with the alt buffer on exit — so the menu reports
      // results and the last one is re-printed on the normal screen.
      const lastResult: { current: string | null } = { current: null };

      await renderInteractive(
        <MenuApp
          flags={command.flags}
          onResult={(text) => {
            lastResult.current = text;
          }}
        />,
        { altScreen: true },
      );

      if (lastResult.current !== null) {
        process.stdout.write(`--- last result ---\n${lastResult.current}\n`);
      }
      return;
    }

    await renderInteractive(
      <ChatApp
        flags={command.flags}
        initialMessage={command.command.message}
      />,
    );
    return;
  }

  // The docs review clamps its final frame to a tail of the document; the
  // full text is re-printed here after exit (same reasoning as the menu's
  // last-result re-print above).
  const fullDocument: { current: string | null } = { current: null };

  await renderInteractive(
    <RunApp
      command={command.command}
      flags={command.flags}
      onResult={(text) => {
        fullDocument.current = text;
      }}
    />,
  );

  if (fullDocument.current !== null) {
    process.stdout.write(`--- full document ---\n${fullDocument.current}\n`);
  }
}

main()
  .catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof CliError || error instanceof NotAGitRepositoryError ? getErrorMessage(error) : `Unexpected error: ${getErrorMessage(error)}`}\n`,
    );
    process.exitCode = 1;
  })
  // Exit explicitly (after a flush) instead of waiting for the event loop to
  // drain — see exitWhenFlushed. This also makes Ink's Ctrl+C terminal: it
  // resolves waitUntilExit, main() returns, and the process exits even if an
  // SDK left a referenced handle behind.
  .finally(exitWhenFlushed);
