export type RunEvent =
  | { type: "text"; text: string }
  | { type: "tool_start"; id: string; name: string; call: string }
  | { type: "tool_end"; id: string; name: string; status: "error" | "finished" }
  | { type: "status"; message: string }
  | { type: "debug"; message: string };

export type RunCallbacks = {
  debug?: boolean;
  onEvent?: (event: RunEvent) => void;
};

export function emitDebug(callbacks: RunCallbacks, message: string): void {
  if (!callbacks.debug) {
    return;
  }

  callbacks.onEvent?.({ type: "debug", message });
}

/**
 * Extracts plain text from a LangChain message content value, which may be a
 * string or an array of content blocks. Tool/reasoning blocks are skipped.
 */
export function getContentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content.map((block) => getBlockText(block)).join("");
  }

  return getBlockText(content);
}

function getBlockText(block: unknown): string {
  if (typeof block === "string") {
    return block;
  }

  if (!isRecord(block)) {
    return "";
  }

  const type = typeof block.type === "string" ? block.type : "";

  if (type.includes("tool") || type.includes("reasoning")) {
    return "";
  }

  if (typeof block.text === "string") {
    return block.text;
  }

  return "";
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
