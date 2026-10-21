import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { getProviderAuthKind, getProviderLabel } from "../constants.js";
import { escapeRegExp } from "../util/regex.js";
import {
  classifyLlmError,
  InvalidModelJsonError,
  toFriendlyError,
  withRetry,
} from "./errors.js";
import { emitDebug, getContentText, type RunCallbacks } from "./events.js";
import { resolveModel } from "./model.js";
import {
  createInactivityWatchdog,
  LLM_INACTIVITY_MS,
  raceAbort,
  SINGLE_SHOT_TOTAL_MS,
} from "./watchdog.js";

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

  // One deadline across every retry attempt: each attempt's watchdog gets
  // only the remaining share, so retried stalls cannot multiply the cap.
  const overallDeadline = Date.now() + SINGLE_SHOT_TOTAL_MS;

  try {
    const text = await withRetry(
      async () => {
        // parts is per-attempt so a mid-stream failure discards partial text.
        const parts: string[] = [];
        // The watchdog aborts stalled calls (no chunk for LLM_INACTIVITY_MS,
        // or the shared overall deadline) instead of hanging forever; a
        // timeout classifies as a retryable network error, so withRetry
        // surfaces visible retries rather than a frozen spinner.
        const watchdog = createInactivityWatchdog({
          inactivityMs: LLM_INACTIVITY_MS,
          totalMs: Math.max(1_000, overallDeadline - Date.now()),
        });

        try {
          const stream = await model.stream(messages, {
            signal: watchdog.signal,
          });

          for await (const chunk of raceAbort(stream, watchdog)) {
            watchdog.touch();

            const text = getContentText(chunk.content);

            if (text.length > 0) {
              parts.push(text);
              options.onEvent?.({ type: "text", text });
            }
          }

          // Some SDKs end the stream quietly on abort instead of throwing;
          // a timed-out attempt must fail, not return partial text.
          if (watchdog.timeoutError !== null) {
            throw watchdog.timeoutError;
          }
        } finally {
          watchdog.dispose();
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
      authKind: getProviderAuthKind(provider),
      // A retryable class reaching here means every attempt was spent.
      exhaustedRetries: classifyLlmError(error).retryable,
    });
  }
}

/**
 * Defensively unwraps a whole-document ```/```markdown fence — the markdown
 * system prompts forbid one, but models occasionally add it anyway.
 */
export function stripMarkdownFence(text: string): string {
  const trimmed = text.trim();
  const match = /^```[\w-]*\r?\n([\s\S]*?)\r?\n?```$/u.exec(trimmed);

  return match ? match[1].trim() : trimmed;
}

/** Past this length, text before the first section is content, not chatter. */
const MAX_PREAMBLE_CHARS = 600;

/**
 * Drops the narration ("Now I have enough context. Here's the document:")
 * before a document that must open with a "## " section. Agentic CLIs write
 * it in the same turn as the answer, so the prompt alone cannot stop it.
 *
 * With `firstSection` (the heading the document must open with), everything
 * before that heading goes, however long — the prompt forbids anything above
 * it — unless a "## " section sits above it: then the model reordered the
 * document, and cutting would drop real sections. Otherwise only a short
 * lead-in before the first "## " or fence is dropped.
 */
export function stripPreamble(text: string, firstSection?: string): string {
  const trimmed = text.trim();

  if (trimmed.startsWith("#") || trimmed.startsWith("```")) {
    return trimmed;
  }

  if (firstSection !== undefined) {
    const heading = new RegExp(
      // A fence opened right above the heading wraps the document: keep it
      // so stripMarkdownFence can unwrap the pair.
      `^(?:\`\`\`[\\w-]*\\r?\\n\\s*)?## ${escapeRegExp(firstSection)}\\b`,
      "mu",
    ).exec(trimmed);

    if (heading !== null && !/^## /mu.test(trimmed.slice(0, heading.index))) {
      return trimmed.slice(heading.index);
    }
  }

  const start = /^(?:## |```)/mu.exec(trimmed);

  if (start === null || start.index > MAX_PREAMBLE_CHARS) {
    return trimmed;
  }

  return trimmed.slice(start.index);
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
