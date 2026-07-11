import { createHash } from "node:crypto";
import path from "node:path";
import { MemorySaver } from "@langchain/langgraph";
import { createDeepAgent, LocalShellBackend } from "deepagents";
import {
  emitDebug,
  getContentText,
  isRecord,
  type RunCallbacks,
  type RunEvent,
} from "./events.js";
import { resolveModel } from "./model.js";

export type AgentRunOptions = RunCallbacks & {
  modelId?: string | null;
  provider?: string | null;
  apiKey?: string | null;
  threadId?: string;
};

export type AgentRunResult = {
  text: string;
  modelId: string;
};

// One in-process checkpointer so interactive chat turns share history.
const checkpointer = new MemorySaver();

/**
 * The deepagents loop (openwiki's pattern): shell/filesystem tools rooted at
 * cwd, streamed events. Used by context/agents/chat, which must explore the
 * repository themselves.
 */
export async function runAgent(
  systemPrompt: string,
  userMessage: string,
  cwd: string,
  options: AgentRunOptions = {},
): Promise<AgentRunResult> {
  const { model, modelId, provider } = await resolveModel({
    modelId: options.modelId ?? null,
    provider: options.provider ?? null,
    apiKey: options.apiKey ?? null,
  });

  emitDebug(options, `provider=${provider} model=${modelId}`);

  const agent = createDeepAgent({
    model,
    tools: [],
    checkpointer,
    backend: new LocalShellBackend({
      // Shell commands must see the user's real environment (PATH, HOME,
      // SSH agent, git config) — the default is an EMPTY env, which only
      // works on macOS by accident of /bin/sh's built-in PATH fallback.
      inheritEnv: true,
      maxOutputBytes: 100_000,
      rootDir: cwd,
      timeout: 120,
      virtualMode: true,
    }),
    systemPrompt,
  });

  const threadId = options.threadId ?? createThreadId(cwd);

  emitDebug(options, `thread=${threadId}`);

  const stream = await agent.stream(
    {
      messages: [
        {
          role: "user",
          content: userMessage,
        },
      ],
    },
    {
      configurable: {
        thread_id: threadId,
      },
      streamMode: ["messages", "tools"],
      subgraphs: true,
    },
  );

  const parts: string[] = [];

  for await (const chunk of stream) {
    const event = parseStreamEvent(chunk);

    if (!event) {
      continue;
    }

    if (event.type === "text") {
      parts.push(event.text);
    }

    options.onEvent?.(event);
  }

  return {
    text: parts.join("").trim(),
    modelId,
  };
}

export function createThreadId(cwd: string): string {
  const digest = createHash("sha256").update(path.resolve(cwd)).digest("hex");
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

  return `sinscribe-${digest.slice(0, 16)}-${runId}`;
}

/**
 * Normalizes a LangGraph stream chunk into a RunEvent. Trimmed port of
 * openwiki's parseStreamEvent: handles [mode, payload] and
 * [namespace, mode, payload] tuples for messages/tools modes.
 */
export function parseStreamEvent(chunk: unknown): RunEvent | null {
  if (!Array.isArray(chunk) || chunk.length < 2) {
    return null;
  }

  const items = chunk as readonly unknown[];
  const nested = Array.isArray(items[0]) && items.length >= 3;
  const mode = nested ? items[1] : items[0];
  const payload = nested ? items[2] : items[1];

  if (mode === "messages") {
    const text = extractMessageText(payload);

    return text.length > 0 ? { type: "text", text } : null;
  }

  if (mode === "tools") {
    return parseToolEvent(payload);
  }

  return null;
}

function extractMessageText(payload: unknown): string {
  // messages mode yields [messageChunk, metadata] tuples.
  const message: unknown =
    Array.isArray(payload) && payload.length === 2 ? payload[0] : payload;

  if (!isRecord(message)) {
    return "";
  }

  if (!isAssistantMessage(message)) {
    return "";
  }

  return getContentText(message.content);
}

function isAssistantMessage(message: Record<string, unknown>): boolean {
  const getType = message._getType;

  if (typeof getType === "function") {
    try {
      const role: unknown = getType.call(message);

      return role === "ai" || role === "assistant";
    } catch {
      return false;
    }
  }

  const role = message.role ?? message.type;

  if (typeof role === "string") {
    return role === "ai" || role === "assistant" || role === "AIMessageChunk";
  }

  // Serialized message classes carry the class name in the id array.
  if (Array.isArray(message.id)) {
    const className: unknown = message.id.at(-1);

    return className === "AIMessage" || className === "AIMessageChunk";
  }

  return "content" in message;
}

function parseToolEvent(payload: unknown): RunEvent | null {
  if (!isRecord(payload)) {
    return null;
  }

  const event = typeof payload.event === "string" ? payload.event : null;
  const name =
    (typeof payload.name === "string" && payload.name) ||
    (typeof payload.tool_name === "string" && payload.tool_name) ||
    "tool";
  const id =
    (typeof payload.toolCallId === "string" && payload.toolCallId) ||
    (typeof payload.tool_call_id === "string" && payload.tool_call_id) ||
    `${name}:${JSON.stringify(payload.input) ?? ""}`;

  if (event === "on_tool_start" || event === "tool-started") {
    return {
      type: "tool_start",
      id,
      name,
      call: `${name}(${formatToolArgs(payload.input)})`,
    };
  }

  if (
    event === "on_tool_end" ||
    event === "tool-finished" ||
    event === "on_tool_error" ||
    event === "tool-error"
  ) {
    return {
      type: "tool_end",
      id,
      name,
      status:
        event === "on_tool_error" || event === "tool-error"
          ? "error"
          : "finished",
    };
  }

  return null;
}

function formatToolArgs(input: unknown): string {
  let value = input;

  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      // Keep the raw string.
    }
  }

  if (isRecord(value)) {
    return Object.entries(value)
      .map(([key, argValue]) => `${key}=${JSON.stringify(argValue)}`)
      .join(", ")
      .slice(0, 200);
  }

  return JSON.stringify(value)?.slice(0, 200) ?? "";
}
