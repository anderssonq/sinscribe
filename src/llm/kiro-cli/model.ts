import { spawn } from "node:child_process";
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import {
  BaseChatModel,
  type BaseChatModelCallOptions,
  type BaseChatModelParams,
} from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  AIMessageChunk,
  type BaseMessage,
} from "@langchain/core/messages";
import { ChatGenerationChunk, type ChatResult } from "@langchain/core/outputs";
import { CliError } from "../../domain/errors.js";
import { getContentText } from "../events.js";
import { ensureKiroAgent, KIRO_AGENT_NAME } from "./agent.js";
import { KiroOutputCleaner } from "./output.js";

/**
 * LangChain chat model backed by AWS's official Kiro CLI (formerly the
 * Amazon Q Developer CLI).
 *
 * Why a subprocess rather than calling the API: AWS gates Q subscriptions to
 * *approved applications*, so a third-party client that registers itself is
 * refused with `AccessDeniedException: "Your subscription does not support
 * this application"` however correct its request is. Driving the official
 * CLI keeps that honest — the approved client makes the call, as itself,
 * with its own sign-in (`kiro-cli login`) — and it hands the wire format
 * back to AWS instead of us reverse-engineering it.
 *
 * Tools are disabled through a `tools: []` agent (see agent.ts), which is
 * what keeps pr/commit/branch/prompt single-shot.
 */

const NOT_INSTALLED_HINT =
  "install it (`brew install kiro-cli`, or see https://kiro.dev/docs/cli/) " +
  "and run `kiro-cli login` once.";

/**
 * Kiro prints this when `--agent` names a config it could not load, then
 * silently falls back to a built-in agent that HAS tools. Treated as fatal:
 * a downgrade would break the no-tools guarantee without anyone noticing.
 */
const AGENT_MISSING_PATTERN = /no agent with name|agent .* not found/iu;

type ChatKiroCliFields = BaseChatModelParams & {
  model: string;
  /** The binary to invoke; injectable so tests can drive a fake. */
  command: string;
};

export class ChatKiroCli extends BaseChatModel<BaseChatModelCallOptions> {
  readonly model: string;
  readonly command: string;

  constructor(fields: ChatKiroCliFields) {
    super(fields);
    this.model = fields.model;
    this.command = fields.command;
  }

  _llmType(): string {
    return "kiro-cli";
  }

  /**
   * The agentic tier needs tool calling through LangChain, and this provider
   * deliberately runs a tools-less agent — runAgent refuses it up front, so
   * this throw is only a backstop.
   */
  override bindTools(): never {
    throw new CliError(
      "The Amazon Q Developer (Kiro CLI) provider does not support tool " +
        "calling — use it with pr/commit/branch/prompt, or switch providers.",
    );
  }

  async _generate(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    const parts: string[] = [];

    for await (const chunk of this._streamResponseChunks(
      messages,
      options,
      runManager,
    )) {
      parts.push(chunk.text);
    }

    const text = parts.join("");

    return { generations: [{ text, message: new AIMessage(text) }] };
  }

  override async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    const agentDir = await ensureKiroAgent();
    const args = ["chat", "--no-interactive", "--agent", KIRO_AGENT_NAME];

    // "auto" means "let the CLI choose" — don't pin a model.
    if (this.model !== "auto") {
      args.push("--model", this.model);
    }

    const child = spawn(this.command, args, {
      // cwd is where Kiro discovers the tools-less agent. It is also not the
      // user's repo — belt and braces, since the agent has no tools anyway.
      cwd: agentDir,
      env: { ...process.env, NO_COLOR: "1" },
      // Wired to the caller's watchdog: an abort kills the child, so a
      // stalled CLI can never hang Sinscribe.
      signal: options.signal,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderr = "";

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const exited = new Promise<{ code: number | null; failure: Error | null }>(
      (resolve) => {
        child.on("error", (failure) => {
          resolve({ code: null, failure });
        });
        child.on("close", (code) => {
          resolve({ code, failure: null });
        });
      },
    );

    // The prompt goes over stdin (--no-interactive reads it when no input
    // argument is given), so a large diff can't hit the argv size limit.
    // EPIPE is expected if the child exits before reading it all.
    child.stdin.on("error", () => undefined);
    child.stdin.end(flattenMessages(messages));

    child.stdout.setEncoding("utf8");

    const cleaner = new KiroOutputCleaner();

    try {
      for await (const chunk of child.stdout as AsyncIterable<string>) {
        yield* emit(cleaner.push(chunk), runManager);
      }

      yield* emit(cleaner.flush(), runManager);
    } finally {
      // Reading may have stopped early (abort); don't leave a live child.
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
      }
    }

    const { code, failure } = await exited;

    if (failure !== null) {
      throw toSpawnError(failure, this.command);
    }

    if (AGENT_MISSING_PATTERN.test(stderr)) {
      throw new CliError(
        `${this.command} did not load Sinscribe's tools-less agent, so it ` +
          `would have run with tools enabled. Refusing: ${stderr.trim()}`,
      );
    }

    if (code !== 0) {
      throw new CliError(
        `${this.command} chat exited with code ${code ?? "?"}: ` +
          `${stderr.trim().slice(0, 500) || "(no output)"}`,
      );
    }
  }
}

/** Yields one cleaned chunk, skipping the empties the cleaner holds back. */
function* emit(
  text: string,
  runManager?: CallbackManagerForLLMRun,
): Generator<ChatGenerationChunk> {
  if (text.length === 0) {
    return;
  }

  void runManager?.handleLLMNewToken(text);
  yield new ChatGenerationChunk({
    text,
    message: new AIMessageChunk({ content: text }),
  });
}

/**
 * The CLI takes a single prompt, so system text is prepended to the user
 * message; single-shot commands never send prior turns.
 */
export function flattenMessages(messages: BaseMessage[]): string {
  const systemParts: string[] = [];
  const rest: string[] = [];

  for (const message of messages) {
    const text = getContentText(message.content);

    if (message.type === "system") {
      systemParts.push(text);
    } else {
      rest.push(text);
    }
  }

  return [...systemParts, ...rest]
    .filter((part) => part.length > 0)
    .join("\n\n");
}

function toSpawnError(failure: Error, command: string): CliError {
  if ((failure as NodeJS.ErrnoException).code === "ENOENT") {
    return new CliError(
      `The ${command} CLI is not installed or not on PATH — ${NOT_INSTALLED_HINT}`,
    );
  }

  return new CliError(`Could not run ${command}: ${failure.message}`);
}
