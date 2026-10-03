import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
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
import { SECRET_ENV_KEYS } from "../../constants.js";
import { CliError } from "../../domain/errors.js";
import { sinscribeEnvDir } from "../../env.js";
import { getContentText } from "../events.js";
import { ClaudeStreamParser } from "./stream.js";

/**
 * LangChain chat model backed by the user's own Claude Code CLI (`claude`),
 * run headless (`-p`). The sibling of the Kiro CLI provider: the official,
 * already-signed-in client makes the call with the user's own Claude login,
 * so Sinscribe stores no credential.
 *
 * Single-shot only, like Kiro: `--tools ""` removes every built-in tool and
 * the isolation flags below keep the user's MCP servers, skills, hooks and
 * settings out — so the model can only answer, never act. They also keep
 * the request small: without them a one-word prompt carried ~130k tokens of
 * the user's environment.
 */

const NOT_INSTALLED_HINT =
  "install Claude Code (see https://code.claude.com/docs) and run `claude` " +
  "once to sign in.";

type ChatClaudeCliFields = BaseChatModelParams & {
  model: string;
  /** The binary to invoke; injectable so tests can drive a fake. */
  command: string;
};

/** Neutral cwd Sinscribe owns, so no repo CLAUDE.md or .claude/ applies. */
export function getClaudeCliDir(): string {
  return path.join(sinscribeEnvDir, "claude-cli");
}

export function buildClaudeArgs(model: string, systemPrompt: string): string[] {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--model",
    model,
    // No tools exist at all: the single-shot contract.
    "--tools",
    "",
    "--max-turns",
    "1",
    "--no-session-persistence",
    // Isolation: no user/project settings (so no hooks or plugins'
    // settings), no MCP servers, no skills, no per-machine prompt sections.
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--exclude-dynamic-system-prompt-sections",
  ];

  // Replaces Claude Code's own agent prompt, so our template is the brief.
  if (systemPrompt.length > 0) {
    args.push("--system-prompt", systemPrompt);
  }

  return args;
}

/**
 * The child's env: the user's own, minus every API key Sinscribe may have
 * loaded from ~/.sinscribe/.env. An ANTHROPIC_API_KEY there would silently
 * switch the CLI from the user's Claude login to pay-per-token billing.
 */
export function buildClaudeEnv(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = { ...env, NO_COLOR: "1" };

  for (const key of SECRET_ENV_KEYS) {
    delete childEnv[key];
  }

  return childEnv;
}

export class ChatClaudeCli extends BaseChatModel<BaseChatModelCallOptions> {
  readonly model: string;
  readonly command: string;

  constructor(fields: ChatClaudeCliFields) {
    super(fields);
    this.model = fields.model;
    this.command = fields.command;
  }

  _llmType(): string {
    return "claude-cli";
  }

  /** runAgent refuses this provider up front; this throw is a backstop. */
  override bindTools(): never {
    throw new CliError(
      "The Claude Code (claude CLI) provider does not support tool calling " +
        "— use it with pr/commit/branch/prompt, or switch providers.",
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
    const cwd = getClaudeCliDir();

    await mkdir(cwd, { recursive: true, mode: 0o700 });

    const { system, prompt } = splitMessages(messages);
    const child = spawn(this.command, buildClaudeArgs(this.model, system), {
      cwd,
      env: buildClaudeEnv(),
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

    // The prompt goes over stdin (-p reads it when no prompt argument is
    // given), so a large diff can't hit the argv size limit. EPIPE is
    // expected if the child exits before reading it all.
    child.stdin.on("error", () => undefined);
    child.stdin.end(prompt);

    child.stdout.setEncoding("utf8");

    const parser = new ClaudeStreamParser();

    try {
      for await (const chunk of child.stdout as AsyncIterable<string>) {
        yield* emit(parser.push(chunk), runManager);
      }

      yield* emit(parser.flush(), runManager);
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

    // The result event is the CLI's own verdict (e.g. "Not logged in"), and
    // it is more useful than the bare exit code, so it is checked first.
    if (parser.result?.isError) {
      throw new CliError(
        `${this.command} failed: ${parser.result.message || "(no detail)"}`,
      );
    }

    if (code !== 0) {
      throw new CliError(
        `${this.command} exited with code ${code ?? "?"}: ` +
          `${stderr.trim().slice(0, 500) || "(no output)"}`,
      );
    }
  }
}

function* emit(
  texts: string[],
  runManager?: CallbackManagerForLLMRun,
): Generator<ChatGenerationChunk> {
  for (const text of texts) {
    void runManager?.handleLLMNewToken(text);
    yield new ChatGenerationChunk({
      text,
      message: new AIMessageChunk({ content: text }),
    });
  }
}

/**
 * System text becomes --system-prompt; everything else is the stdin prompt.
 * Single-shot commands never send prior turns, so joining is lossless.
 */
export function splitMessages(messages: BaseMessage[]): {
  system: string;
  prompt: string;
} {
  const systemParts: string[] = [];
  const rest: string[] = [];

  for (const message of messages) {
    const text = getContentText(message.content);

    if (text.length === 0) {
      continue;
    }

    (message.type === "system" ? systemParts : rest).push(text);
  }

  return { system: systemParts.join("\n\n"), prompt: rest.join("\n\n") };
}

function toSpawnError(failure: Error, command: string): CliError {
  if ((failure as NodeJS.ErrnoException).code === "ENOENT") {
    return new CliError(
      `The ${command} CLI is not installed or not on PATH — ${NOT_INSTALLED_HINT}`,
    );
  }

  return new CliError(`Could not run ${command}: ${failure.message}`);
}
