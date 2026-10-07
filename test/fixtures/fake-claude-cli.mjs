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
 * FAKE_CLAUDE_TOOLS=1   -> explore mode: tool_use/tool_result traffic and
 *                          narration deltas before the final result
 * FAKE_CLAUDE_MAX_TURNS=1 -> an error_max_turns result, exit 1
 * FAKE_CLAUDE_UNKNOWN_OPTION=1 -> commander's "unknown option" on stderr, exit 1
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

  if (process.env.FAKE_CLAUDE_UNKNOWN_OPTION === "1") {
    process.stderr.write("error: unknown option '--restricted'\n");
    process.exit(1);
  }

  if (process.env.FAKE_CLAUDE_TOOLS === "1") {
    writeExploreStream(stdin);
    return;
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

function writeExploreStream(stdin) {
  const delta = (text) => ({
    type: "stream_event",
    parent_tool_use_id: null,
    event: { type: "content_block_delta", delta: { type: "text_delta", text } },
  });
  const use = (id, name, input) => ({
    type: "assistant",
    parent_tool_use_id: null,
    message: { content: [{ type: "tool_use", id, name, input }] },
  });
  const result = (id, isError) => ({
    type: "user",
    parent_tool_use_id: null,
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: id,
          content: "x",
          is_error: isError,
        },
      ],
    },
  });
  const answer =
    `FINAL\nARGV:${JSON.stringify(process.argv.slice(2))}\n` +
    `CWD:${process.cwd()}\nKEY:${process.env.ANTHROPIC_API_KEY ?? "<unset>"}\n` +
    `STDIN:${stdin}`;
  const events = [
    { type: "system", subtype: "init", session_id: "s", tools: [] },
    delta("Let me look around first."),
    use("t1", "Glob", { pattern: "**/*.ts" }),
    result("t1", false),
    use("t2", "Read", { file_path: `${process.cwd()}/src/a.ts` }),
    result("t2", false),
    use("t3", "Read", { file_path: `${process.cwd()}/.env` }),
    result("t3", true),
    use("t4", "Grep", { pattern: "TODO", path: `${process.cwd()}/src` }),
    result("t4", false),
    // A subagent's traffic must never reach the parent's event stream.
    {
      ...use("t9", "Read", { file_path: "/elsewhere" }),
      parent_tool_use_id: "t4",
    },
  ];

  if (process.env.FAKE_CLAUDE_MAX_TURNS === "1") {
    events.push({
      type: "result",
      subtype: "error_max_turns",
      is_error: true,
      errors: [],
    });
  } else {
    events.push(delta(answer), {
      type: "result",
      subtype: "success",
      is_error: false,
      result: answer,
    });
  }

  process.stdout.write(events.map((e) => `${JSON.stringify(e)}\n`).join(""));
  process.exitCode = process.env.FAKE_CLAUDE_MAX_TURNS === "1" ? 1 : 0;
}
