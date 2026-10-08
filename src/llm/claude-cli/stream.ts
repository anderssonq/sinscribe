/**
 * Incremental parser for `claude -p --output-format stream-json` (NDJSON:
 * one event object per line). Pulls the answer text out of the event stream
 * and remembers the final `result` event, which is where the CLI reports
 * failures such as being signed out — on stdout, not stderr.
 *
 * Text comes from `stream_event` text deltas (--include-partial-messages).
 * Complete `assistant` messages repeat that text, so they are used only as a
 * fallback when no delta was seen (a CLI that ignores the partial flag).
 */

export type ClaudeStreamResult = {
  isError: boolean;
  /** The answer on success; the failure description otherwise. */
  message: string;
  /** The result event's subtype ("success", "error_max_turns", …), or null. */
  subtype: string | null;
};

export type StreamEvent = {
  type?: unknown;
  subtype?: unknown;
  parent_tool_use_id?: unknown;
  event?: { delta?: { type?: unknown; text?: unknown } };
  message?: { content?: unknown };
  is_error?: unknown;
  result?: unknown;
  errors?: unknown;
};

export class ClaudeStreamParser {
  private buffer = "";
  private sawDelta = false;
  private fallbackParts: string[] = [];
  result: ClaudeStreamResult | null = null;

  /** Feeds raw stdout; returns the text to emit now, in order. */
  push(chunk: string): string[] {
    this.buffer += chunk;

    const lines = this.buffer.split("\n");

    // The last piece is an unterminated line; keep it for the next chunk.
    this.buffer = lines.pop() ?? "";

    return lines.flatMap((line) => this.handleLine(line));
  }

  /** Drains the unterminated tail and, if no delta ever arrived, the fallback. */
  flush(): string[] {
    const tail = this.handleLine(this.buffer);

    this.buffer = "";

    if (this.sawDelta) {
      return tail;
    }

    const fallback = this.fallbackParts;

    this.fallbackParts = [];

    return [...tail, ...fallback];
  }

  private handleLine(line: string): string[] {
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      return [];
    }

    let event: StreamEvent;

    try {
      event = JSON.parse(trimmed) as StreamEvent;
    } catch {
      // Not ours to interpret (a stray log line); never let it reach output.
      return [];
    }

    // Subagent traffic would carry a parent id; with no tools there is
    // none, but only the main conversation's text is the answer anyway.
    if (
      event.parent_tool_use_id !== undefined &&
      event.parent_tool_use_id !== null
    ) {
      return [];
    }

    if (event.type === "stream_event") {
      const delta = event.event?.delta;

      if (delta?.type === "text_delta" && typeof delta.text === "string") {
        this.sawDelta = true;

        return delta.text.length > 0 ? [delta.text] : [];
      }

      return [];
    }

    if (event.type === "assistant" && !this.sawDelta) {
      this.fallbackParts.push(...extractText(event.message?.content));

      return [];
    }

    if (event.type === "result") {
      this.result = toResult(event);
    }

    return [];
  }
}

function extractText(content: unknown): string[] {
  if (!Array.isArray(content)) {
    return [];
  }

  return content.flatMap((block: unknown) => {
    if (typeof block !== "object" || block === null) {
      return [];
    }

    const { type, text } = block as { type?: unknown; text?: unknown };

    return type === "text" && typeof text === "string" && text.length > 0
      ? [text]
      : [];
  });
}

export function toResult(event: StreamEvent): ClaudeStreamResult {
  const isError = event.is_error === true || event.subtype !== "success";
  const errors = Array.isArray(event.errors)
    ? event.errors.filter((entry): entry is string => typeof entry === "string")
    : [];
  const message =
    typeof event.result === "string" && event.result.length > 0
      ? event.result
      : errors.join("; ") ||
        (typeof event.subtype === "string" ? event.subtype : "");

  return {
    isError,
    message,
    subtype: typeof event.subtype === "string" ? event.subtype : null,
  };
}
