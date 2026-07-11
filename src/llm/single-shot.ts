import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { getProviderLabel } from "../constants.js";
import {
  classifyLlmError,
  InvalidModelJsonError,
  toFriendlyError,
  withRetry,
} from "./errors.js";
import { emitDebug, getContentText, type RunCallbacks } from "./events.js";
import { resolveModel } from "./model.js";

export type SingleShotOptions = RunCallbacks & {
  modelId?: string | null;
  provider?: string | null;
  apiKey?: string | null;
};

export type SingleShotResult = {
  text: string;
  modelId: string;
};

/**
 * One streamed model call, no agent, no tools, no checkpointer. Used by the
 * pr/commit/branch commands where the CLI computes all context locally.
 */
export async function runSingleShot(
  systemPrompt: string,
  userPrompt: string,
  options: SingleShotOptions = {},
): Promise<SingleShotResult> {
  // resolveModel stays outside the retry: config failures fail fast, and
  // maxRetries: 0 keeps the SDK's transport retries from multiplying ours.
  const { model, modelId, provider } = await resolveModel({
    modelId: options.modelId ?? null,
    provider: options.provider ?? null,
    apiKey: options.apiKey ?? null,
    maxRetries: 0,
  });

  emitDebug(options, `provider=${provider} model=${modelId}`);

  const messages = [
    new SystemMessage(systemPrompt),
    new HumanMessage(userPrompt),
  ];

  try {
    const text = await withRetry(
      async () => {
        // parts is per-attempt so a mid-stream failure discards partial text.
        const parts: string[] = [];
        const stream = await model.stream(messages);

        for await (const chunk of stream) {
          const text = getContentText(chunk.content);

          if (text.length > 0) {
            parts.push(text);
            options.onEvent?.({ type: "text", text });
          }
        }

        return parts.join("").trim();
      },
      {
        onRetry: ({ attempt, maxAttempts, delayMs, error }) => {
          options.onEvent?.({
            type: "status",
            message: `Retrying (attempt ${attempt + 1}/${maxAttempts}) in ${Math.ceil(delayMs / 1_000)}s — ${error.detail}`,
          });
        },
      },
    );

    return { text, modelId };
  } catch (error) {
    throw toFriendlyError(error, {
      providerLabel: getProviderLabel(provider),
      // A retryable class reaching here means every attempt was spent.
      exhaustedRetries: classifyLlmError(error).retryable,
    });
  }
}

/**
 * Extracts a JSON object from model output that may be wrapped in prose or a
 * ```json fence. Throws with the raw output attached when nothing parses.
 */
export function extractJsonObject(text: string): Record<string, unknown> {
  const candidates: string[] = [];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/u);

  if (fenced?.[1]) {
    candidates.push(fenced[1]);
  }

  candidates.push(text);

  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");

  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(text.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate.trim()) as unknown;

      if (typeof parsed === "object" && parsed !== null) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Try the next candidate.
    }
  }

  throw new InvalidModelJsonError(text);
}
