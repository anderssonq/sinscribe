import { createHash } from "node:crypto";
import path from "node:path";
import { MemorySaver } from "@langchain/langgraph";
import { createDeepAgent, LocalShellBackend } from "deepagents";
import {
  getProviderAuthKind,
  getProviderLabel,
  providerSupportsAgentic,
  resolveConfiguredProvider,
  SECRET_ENV_KEYS,
} from "../constants.js";
import { CliError } from "../domain/errors.js";
import { toFriendlyError } from "./errors.js";
import {
  emitDebug,
  getContentText,
  isRecord,
  type RunCallbacks,
  type RunEvent,
} from "./events.js";
import { resolveModel } from "./model.js";
import {
  createInactivityWatchdog,
  LLM_INACTIVITY_MS,
  raceAbort,
} from "./watchdog.js";

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
  // Registry-declared capability check, before any credential or network
  // access: the agentic loop needs a tool-calling model (bindTools), which
  // aws-sso providers do not offer yet.
  const configuredProvider = resolveConfiguredProvider(
    options.provider ?? null,
  );

  if (!providerSupportsAgentic(configuredProvider)) {
    throw new CliError(
      `The ${getProviderLabel(configuredProvider)} provider supports ` +
        `pr/commit/branch/prompt only for now — context/docs/agents/chat ` +
        `need a tool-calling provider. Switch providers in AI settings or ` +
        `with SINSCRIBE_PROVIDER.`,
    );
  }

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
      // Shell commands see the user's real environment (PATH, HOME, SSH agent,
      // git config) but NOT secret API keys: buildShellEnv() passes the full
      // env minus SECRET_ENV_KEYS with inheritEnv:false, so prompt-injected
      // repository content cannot read or exfiltrate credentials through the
      // shell tool. The model already holds the key (resolveModel above), so
      // the LLM call is unaffected. (A bare empty env would also break PATH on
      // non-macOS, which is why we pass the real env explicitly rather than
      // relying on the default.)
      inheritEnv: false,
      env: buildShellEnv(),
      maxOutputBytes: 100_000,
      rootDir: cwd,
      timeout: 120,
      virtualMode: true,
    }),
    systemPrompt,
  });

  const threadId = options.threadId ?? createThreadId(cwd);

  emitDebug(options, `thread=${threadId}`);

  // Inactivity-only watchdog: agent loops legitimately run for minutes, so
  // there is no overall deadline — but a stalled socket (no chunk for
  // LLM_INACTIVITY_MS) must abort instead of freezing the CLI. Tool
  // subprocesses have their own 120s cap via LocalShellBackend's timeout.
  const watchdog = createInactivityWatchdog({
    inactivityMs: LLM_INACTIVITY_MS,
  });
  const parts: string[] = [];

  try {
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
        signal: watchdog.signal,
        streamMode: ["messages", "tools"],
        subgraphs: true,
      },
    );

    for await (const chunk of raceAbort(stream, watchdog)) {
      watchdog.touch();

      const event = parseStreamEvent(chunk);

      if (!event) {
        continue;
      }

      if (event.type === "text") {
        parts.push(event.text);
      }

      options.onEvent?.(event);
    }

    // LangGraph can end the stream quietly on abort; surface the timeout.
    if (watchdog.timeoutError !== null) {
      throw watchdog.timeoutError;
    }
  } catch (error) {
    throw toFriendlyError(error, {
      providerLabel: getProviderLabel(provider),
      authKind: getProviderAuthKind(provider),
    });
  } finally {
    watchdog.dispose();
  }

  return {
    text: parts.join("").trim(),
    modelId,
  };
}

/**
 * The environment handed to the agent's shell tool: the caller's real env
 * (PATH, HOME, SSH agent, git config, …) with every secret API-key variable
 * removed. Scrubbing the keys means prompt-injected repository content cannot
 * read or exfiltrate them via the shell; the model itself already received the
 * credential through resolveModel(), so LLM calls are unaffected. Exported so
 * the scrub is unit-testable without spawning a shell.
 */
export function buildShellEnv(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const secrets = new Set<string>(SECRET_ENV_KEYS);
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && !secrets.has(key)) {
      env[key] = value;
    }
  }

  return env;
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
