#!/usr/bin/env node
/* global process */
/**
 * Stand-in for Claude Code's `claude -p --output-format stream-json`,
 * shaped like the real 2.1.x stream: hook/init system events, then
 * `stream_event` text deltas, the complete `assistant` message (repeating
 * the text), and a final `result` line.
 *
 * FAKE_CLAUDE_ERROR=1   -> an error result on stdout (how "Not logged in"
 *                          arrives), exit 1
 * FAKE_CLAUDE_CRASH=1   -> stderr only, exit 2
 * FAKE_CLAUDE_SPLIT=1   -> stdout written one byte at a time
 */
const args = process.argv.slice(2);

let stdin = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdin += chunk;
});
process.stdin.on("end", () => {
  if (process.env.FAKE_CLAUDE_CRASH === "1") {
    process.stderr.write("fake claude: boom\n");
    process.exit(2);
  }

  const events = [
    { type: "system", subtype: "init", session_id: "s", tools: [] },
  ];

  if (process.env.FAKE_CLAUDE_ERROR === "1") {
    events.push({
      type: "result",
      subtype: "success",
      is_error: true,
      result: "Not logged in · Please run /login",
    });
  } else {
    const answer =
      `ARGV:${JSON.stringify(args)}\nCWD:${process.cwd()}\n` +
      `KEY:${process.env.ANTHROPIC_API_KEY ?? "<unset>"}\nSTDIN:${stdin}`;
    const half = Math.ceil(answer.length / 2);
    const delta = (text) => ({
      type: "stream_event",
      parent_tool_use_id: null,
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text },
      },
    });

    events.push(
      delta(answer.slice(0, half)),
      delta(answer.slice(half)),
      {
        type: "assistant",
        parent_tool_use_id: null,
        message: { content: [{ type: "text", text: answer }] },
      },
      { type: "result", subtype: "success", is_error: false, result: answer },
    );
  }

  const out = events.map((event) => `${JSON.stringify(event)}\n`).join("");

  if (process.env.FAKE_CLAUDE_SPLIT === "1") {
    for (const char of out) {
      process.stdout.write(char);
    }
  } else {
    process.stdout.write(out);
  }

  process.exitCode = process.env.FAKE_CLAUDE_ERROR === "1" ? 1 : 0;
});
