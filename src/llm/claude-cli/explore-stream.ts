import path from "node:path";
import type { RunEvent } from "../events.js";
import {
  type ClaudeStreamResult,
  type StreamEvent,
  toResult,
} from "./stream.js";

/**
 * Parser for `claude -p --output-format stream-json` when the CLI runs with
 * read-only tools (the plan's explore mode). Shaped by the real 2.1.x
 * stream: `assistant` messages carry `tool_use` blocks, the following `user`
 * message carries the matching `tool_result` (with `is_error` on denial),
 * and the final `result` event holds the answer.
 *
 * Unlike ClaudeStreamParser, text deltas are NOT the answer here: with tools
 * the model narrates between calls ("Let me read…"), so only `result.result`
 * is kept. Deltas still count as activity so the inactivity watchdog does
 * not fire while the long final document streams.
 */

type ContentBlock = {
  type?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
  tool_use_id?: unknown;
  is_error?: unknown;
};

export type ExploreParseOutput = {
  events: RunEvent[];
  /** True for any parsable line, so the caller can touch its watchdog. */
  active: boolean;
};

export class ClaudeExploreParser {
  private buffer = "";
  private readonly names = new Map<string, string>();
  private readonly read = new Set<string>();
  /** Read calls awaiting their result, by tool_use id. */
  private readonly pendingReads = new Map<string, string>();
  result: ClaudeStreamResult | null = null;

  constructor(private readonly repoRoot: string) {}

  /** Repo-relative paths of files the model actually read, in first-read order. */
  get filesRead(): string[] {
    return [...this.read];
  }

  push(chunk: string): ExploreParseOutput {
    this.buffer += chunk;

    const lines = this.buffer.split("\n");

    this.buffer = lines.pop() ?? "";

    return this.handleLines(lines);
  }

  flush(): ExploreParseOutput {
    const tail = this.buffer;

    this.buffer = "";

    return this.handleLines([tail]);
  }

  private handleLines(lines: string[]): ExploreParseOutput {
    const events: RunEvent[] = [];
    let active = false;

    for (const line of lines) {
      const trimmed = line.trim();

      if (trimmed.length === 0) {
        continue;
      }

      let event: StreamEvent;

      try {
        event = JSON.parse(trimmed) as StreamEvent;
      } catch {
        continue;
      }

      active = true;

      // Subagent traffic (a Task tool) is not part of the answer; there is
      // no Task tool in the read-only set, so this is belt and braces.
      if (
        event.parent_tool_use_id !== undefined &&
        event.parent_tool_use_id !== null
      ) {
        continue;
      }

      if (event.type === "assistant") {
        events.push(...this.toolStarts(event.message?.content));
      } else if (event.type === "user") {
        events.push(...this.toolEnds(event.message?.content));
      } else if (event.type === "result") {
        this.result = toResult(event);
      }
    }

    return { events, active };
  }

  private toolStarts(content: unknown): RunEvent[] {
    return blocks(content).flatMap((block) => {
      if (
        block.type !== "tool_use" ||
        typeof block.id !== "string" ||
        typeof block.name !== "string"
      ) {
        return [];
      }

      this.names.set(block.id, block.name);

      const file =
        block.name === "Read"
          ? this.relative(stringArg(block.input, "file_path"))
          : null;

      if (file) {
        this.pendingReads.set(block.id, file);
      }

      return [
        {
          type: "tool_start" as const,
          id: block.id,
          name: block.name,
          call: this.describeCall(block.name, block.input),
        },
      ];
    });
  }

  private toolEnds(content: unknown): RunEvent[] {
    return blocks(content).flatMap((block) => {
      if (
        block.type !== "tool_result" ||
        typeof block.tool_use_id !== "string"
      ) {
        return [];
      }

      const failed = block.is_error === true;
      const file = this.pendingReads.get(block.tool_use_id);

      this.pendingReads.delete(block.tool_use_id);

      // Only a read that succeeded counts: a denied Read (.env) was never read.
      if (file && !failed) {
        this.read.add(file);
      }

      return [
        {
          type: "tool_end" as const,
          id: block.tool_use_id,
          name: this.names.get(block.tool_use_id) ?? "tool",
          status: failed ? ("error" as const) : "finished",
        },
      ];
    });
  }

  /** A one-line, repo-relative description: `Read src/x.ts`, `Grep "foo" in src`. */
  private describeCall(name: string, input: unknown): string {
    const args =
      typeof input === "object" && input !== null
        ? (input as Record<string, unknown>)
        : {};
    const str = (key: string): string | null => {
      const value = args[key];

      return typeof value === "string" ? value : null;
    };

    if (name === "Read") {
      return `Read ${this.relative(str("file_path")) ?? "?"}`;
    }

    if (name === "Glob") {
      const where = this.relative(str("path"));

      return `Glob ${str("pattern") ?? "?"}${where ? ` in ${where}` : ""}`;
    }

    if (name === "Grep") {
      const where = this.relative(str("path")) ?? str("glob");

      return `Grep "${str("pattern") ?? "?"}"${where ? ` in ${where}` : ""}`;
    }

    return `${name}(${JSON.stringify(args).slice(0, 120)})`;
  }

  private relative(file: string | null): string | null {
    if (file === null || file.length === 0) {
      return null;
    }

    if (!path.isAbsolute(file)) {
      return file;
    }

    const relative = path.relative(this.repoRoot, file);

    return relative.length === 0 ? "." : relative;
  }
}

function stringArg(input: unknown, key: string): string | null {
  if (typeof input !== "object" || input === null) {
    return null;
  }

  const value = (input as Record<string, unknown>)[key];

  return typeof value === "string" ? value : null;
}

function blocks(content: unknown): ContentBlock[] {
  return Array.isArray(content)
    ? content.filter(
        (block): block is ContentBlock =>
          typeof block === "object" && block !== null,
      )
    : [];
}
