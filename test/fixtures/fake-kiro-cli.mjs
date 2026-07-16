#!/usr/bin/env node
/* global process */
/**
 * Stand-in for AWS's `kiro-cli`, faithful to what the real binary (2.3.0)
 * does, so the provider's contract can be tested without a subscription:
 *
 * - stdout carries ANSI styling and a "> " answer marker even under
 *   NO_COLOR=1  ->  `\x1b[38;5;141m> \x1b[0m<answer>`
 * - warnings and the credits footer go to stderr, never stdout
 * - the prompt arrives on stdin under --no-interactive
 *
 * FAKE_KIRO_SPLIT=1 flushes the answer in one-byte writes, so a test can
 * force an ANSI escape to straddle a chunk boundary.
 */
const args = process.argv.slice(2);

let stdin = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdin += chunk;
});
process.stdin.on("end", () => {
  process.stderr.write("some warning on stderr\n");

  if (process.env.FAKE_KIRO_FAIL === "1") {
    process.stderr.write("fake kiro-cli: not logged in\n");
    process.exit(1);
  }

  if (process.env.FAKE_KIRO_NO_AGENT === "1") {
    // How the real CLI reports an agent it could not load, before falling
    // back to a built-in agent that HAS tools.
    process.stderr.write('Error: no agent with name "sinscribe" found\n');
  }

  const answer = `ARGV:${JSON.stringify(args)}\nCWD:${process.cwd()}\nSTDIN:${stdin}`;
  const out = `\x1b[38;5;141m> \x1b[0m${answer}`;

  if (process.env.FAKE_KIRO_SPLIT === "1") {
    for (const char of out) {
      process.stdout.write(char);
    }
  } else {
    process.stdout.write(out);
  }

  process.stderr.write(" ▸ Credits: 0.05 • Time: 1s\n");
  process.exit(0);
});
