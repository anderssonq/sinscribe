import { ChatAnthropic } from "@langchain/anthropic";
import { ChatOpenAI } from "@langchain/openai";
import { ChatOpenRouter } from "@langchain/openrouter";
import {
  getDefaultModelId,
  getProviderApiKeyEnvKey,
  getProviderBaseUrlEnvKey,
  getProviderCommand,
  getProviderLabel,
  isValidModelId,
  normalizeModelId,
  OPENROUTER_BASE_URL,
  OPENROUTER_FALLBACK_MODEL_IDS,
  SINSCRIBE_MODEL_ID_ENV_KEY,
  providerRequiresBaseUrl,
  resolveConfiguredProvider,
  resolveProviderBaseUrl,
  type SinscribeProvider,
} from "../constants.js";
import { loadSinscribeEnv } from "../env.js";
import { ChatClaudeCli } from "./claude-cli/model.js";
import { ChatKiroCli } from "./kiro-cli/model.js";
import {
  buildOpencodeGoHeaders,
  createOpencodeSessionId,
} from "./opencode-go.js";

export type ResolvedModel = {
  provider: SinscribeProvider;
  modelId: string;
  model:
    ChatAnthropic | ChatOpenAI | ChatOpenRouter | ChatKiroCli | ChatClaudeCli;
};

export type ModelOverrides = {
  modelId?: string | null;
  provider?: string | null;
  apiKey?: string | null;
  /**
   * LangChain's built-in transport retry count (defaults to 6 in the SDK).
   * The single-shot path passes 0 so its own backoff wrapper owns retrying.
   */
  maxRetries?: number;
  /**
   * Stable id for the conversation this model serves. OpenCode Go requires
   * one (x-opencode-session); chat passes its thread id so every turn shares
   * it. Omitted, a fresh id is minted — one per single-shot invocation.
   */
  sessionId?: string | null;
};

/**
 * Loads ~/.sinscribe/.env, validates provider credentials, and constructs the
 * chat model. The single entrypoint for every LLM-backed command.
 */
export async function resolveModel(
  overrides: ModelOverrides = {},
): Promise<ResolvedModel> {
  await loadSinscribeEnv();

  const provider = resolveConfiguredProvider(overrides.provider ?? null);
  const localCli = getProviderCommand(provider);

  if (localCli !== null) {
    // No credential to resolve: the child CLI owns its own sign-in. A
    // missing binary surfaces from the spawn with the setup hint.
    const modelId = resolveModelId(overrides.modelId ?? null, provider);
    const fields = { model: modelId, command: localCli.command };

    return {
      provider,
      modelId,
      model:
        provider === "claude-cli"
          ? new ChatClaudeCli(fields)
          : new ChatKiroCli(fields),
    };
  }

  const apiKey = resolveProviderApiKey(provider, overrides.apiKey ?? null);

  ensureProviderBaseUrl(provider);

  const modelId = resolveModelId(overrides.modelId ?? null, provider);

  return {
    provider,
    modelId,
    model: createModel(
      provider,
      modelId,
      apiKey,
      overrides.maxRetries,
      overrides.sessionId ?? createOpencodeSessionId(),
    ),
  };
}

/**
 * Resolves the API key for a provider: an explicit override wins, otherwise
 * falls back to the environment. Never mutates process.env — a one-off
 * --api-key override must stay scoped to this model construction, since
 * context/agents/chat hand process.env to shell subprocesses verbatim.
 */
export function resolveProviderApiKey(
  provider: SinscribeProvider,
  override: string | null,
): string {
  const apiKeyEnvKey = getProviderApiKeyEnvKey(provider);

  if (apiKeyEnvKey === null) {
    // aws-sso providers are resolved before this is ever called; reaching
    // here means a wiring bug, so say which provider misrouted.
    throw new Error(
      `${getProviderLabel(provider)} does not use an API key — it signs in via AWS SSO.`,
    );
  }

  const trimmedOverride = override?.trim();
  const apiKey = trimmedOverride || process.env[apiKeyEnvKey];

  if (!apiKey) {
    throw new Error(
      `${apiKeyEnvKey} is required to run sinscribe with ${getProviderLabel(provider)}. ` +
        `Set it in your environment, in ~/.sinscribe/.env, or pass --api-key.`,
    );
  }

  return apiKey;
}

function ensureProviderBaseUrl(provider: SinscribeProvider): void {
  if (!providerRequiresBaseUrl(provider)) {
    return;
  }

  if (!resolveProviderBaseUrl(provider)) {
    const baseUrlEnvKey = getProviderBaseUrlEnvKey(provider) ?? "base URL";

    throw new Error(
      `${baseUrlEnvKey} is required to run sinscribe with ${getProviderLabel(provider)}.`,
    );
  }
}

export function resolveModelId(
  override: string | null,
  provider: SinscribeProvider,
): string {
  // The saved model id belongs to the saved provider. A one-off --provider
  // for a different one must not inherit it (e.g. glm-5.2 sent to kiro-cli).
  const savedModelId =
    resolveConfiguredProvider() === provider
      ? process.env[SINSCRIBE_MODEL_ID_ENV_KEY]
      : undefined;
  const rawModelId = override ?? savedModelId ?? getDefaultModelId(provider);
  const modelId = normalizeModelId(rawModelId);

  if (!isValidModelId(modelId)) {
    throw new Error(
      `Invalid model ID configured in ${SINSCRIBE_MODEL_ID_ENV_KEY}.`,
    );
  }

  return modelId;
}

function createModel(
  provider: SinscribeProvider,
  modelId: string,
  apiKey: string,
  maxRetries: number | undefined,
  sessionId: string,
) {
  const retryOptions = maxRetries === undefined ? {} : { maxRetries };

  if (provider === "anthropic") {
    const baseURL = resolveProviderBaseUrl(provider);

    return new ChatAnthropic(modelId, {
      apiKey,
      ...(baseURL ? { anthropicApiUrl: baseURL } : {}),
      ...retryOptions,
    });
  }

  if (provider === "openrouter") {
    const models = Array.from(
      new Set([modelId, ...OPENROUTER_FALLBACK_MODEL_IDS]),
    );

    return new ChatOpenRouter({
      apiKey,
      baseURL: OPENROUTER_BASE_URL,
      model: modelId,
      models,
      route: "fallback",
      siteName: "sinscribe",
      ...retryOptions,
    });
  }

  const baseURL = resolveProviderBaseUrl(provider);

  return new ChatOpenAI({
    apiKey,
    configuration:
      provider === "opencode-go"
        ? { baseURL, defaultHeaders: buildOpencodeGoHeaders(sessionId) }
        : baseURL
          ? { baseURL }
          : undefined,
    model: modelId,
    ...retryOptions,
  });
}
