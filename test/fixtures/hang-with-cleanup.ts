/**
 * Test fixture for cli-signals.test.ts: a process that would run forever
 * (referenced interval) with terminal features marked active, exactly like
 * an interactive session that got stuck. The test sends SIGINT and asserts
 * the cleanup net restores the terminal and exits promptly.
 */
import { installTerminalCleanup, markActive } from "../../src/ui/term.js";

installTerminalCleanup();
markActive("bg", true);

setInterval(() => undefined, 1_000);

process.stdout.write("ready\n");
