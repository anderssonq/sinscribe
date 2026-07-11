export const BASETEN_API_KEY_ENV_KEY = "BASETEN_API_KEY";
export const FIREWORKS_API_KEY_ENV_KEY = "FIREWORKS_API_KEY";
export const OPENAI_API_KEY_ENV_KEY = "OPENAI_API_KEY";
export const OPENAI_COMPATIBLE_API_KEY_ENV_KEY = "OPENAI_COMPATIBLE_API_KEY";
export const OPENAI_COMPATIBLE_BASE_URL_ENV_KEY = "OPENAI_COMPATIBLE_BASE_URL";
export const ANTHROPIC_API_KEY_ENV_KEY = "ANTHROPIC_API_KEY";
export const ANTHROPIC_BASE_URL_ENV_KEY = "ANTHROPIC_BASE_URL";
export const OPENROUTER_API_KEY_ENV_KEY = "OPENROUTER_API_KEY";
export const OPENCODE_GO_API_KEY_ENV_KEY = "OPENCODE_API_KEY";
export const SINSCRIBE_PROVIDER_ENV_KEY = "SINSCRIBE_PROVIDER";
export const SINSCRIBE_MODEL_ID_ENV_KEY = "SINSCRIBE_MODEL_ID";
export const SINSCRIBE_TICKET_PATTERN_ENV_KEY = "SINSCRIBE_TICKET_PATTERN";
export const SINSCRIBE_THEME_ENV_KEY = "SINSCRIBE_THEME";
export const DEFAULT_PROVIDER = "opencode-go";
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const OPENCODE_GO_BASE_URL = "https://opencode.ai/zen/go/v1";
export const CLI_DISPLAY_NAME = "Sinscribe";
export const SINSCRIBE_VERSION = "0.0.1";

export type SinscribeProvider =
  | "anthropic"
  | "baseten"
  | "fireworks"
  | "openai"
  | "openai-compatible"
  | "opencode-go"
  | "openrouter";

export type ProviderModelOption = {
  id: string;
  label: string;
};

type ProviderConfig = {
  apiKeyEnvKey: string;
  baseURL?: string;
  /** Env var that overrides {@link ProviderConfig.baseURL} when set. */
  baseUrlEnvKey?: string;
  /** When true, the provider has no default endpoint and requires a base URL. */
  requiresBaseUrl?: boolean;
  label: string;
  modelOptions: ProviderModelOption[];
};

export const SELECTABLE_PROVIDERS = [
  "openrouter",
  "opencode-go",
  "baseten",
  "fireworks",
  "openai",
  "openai-compatible",
  "anthropic",
] as const satisfies readonly SinscribeProvider[];

export const PROVIDER_CONFIGS: Record<SinscribeProvider, ProviderConfig> = {
  openrouter: {
    apiKeyEnvKey: OPENROUTER_API_KEY_ENV_KEY,
    baseURL: OPENROUTER_BASE_URL,
    label: "OpenRouter",
    modelOptions: [
      { id: "z-ai/glm-5.2", label: "GLM 5.2" },
      { id: "moonshotai/kimi-k2.7-code", label: "Kimi K2.7 Code" },
      { id: "openrouter/fusion", label: "OpenRouter Fusion" },
      { id: "openai/gpt-5.4-mini", label: "GPT 5.4 mini" },
      { id: "anthropic/claude-sonnet-5", label: "Claude Sonnet" },
    ],
  },
  "opencode-go": {
    apiKeyEnvKey: OPENCODE_GO_API_KEY_ENV_KEY,
    baseURL: OPENCODE_GO_BASE_URL,
    label: "OpenCode Go",
    modelOptions: [
      { id: "kimi-k2.7-code", label: "Kimi K2.7 Code" },
      { id: "glm-5.2", label: "GLM 5.2" },
      { id: "glm-5.1", label: "GLM 5.1" },
      { id: "kimi-k2.6", label: "Kimi K2.6" },
      { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
      { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash" },
      { id: "mimo-v2.5", label: "MiMo V2.5" },
      { id: "mimo-v2.5-pro", label: "MiMo V2.5 Pro" },
    ],
  },
  baseten: {
    apiKeyEnvKey: BASETEN_API_KEY_ENV_KEY,
    baseURL: "https://inference.baseten.co/v1",
    label: "Baseten",
    modelOptions: [
      { id: "zai-org/GLM-5.2", label: "GLM 5.2" },
      { id: "moonshotai/Kimi-K2.7-Code", label: "Kimi K2.7 Code" },
    ],
  },
  fireworks: {
    apiKeyEnvKey: FIREWORKS_API_KEY_ENV_KEY,
    baseURL: "https://api.fireworks.ai/inference/v1",
    label: "Fireworks",
    modelOptions: [
      { id: "accounts/fireworks/models/glm-5p2", label: "GLM 5.2" },
      {
        id: "accounts/fireworks/models/kimi-k2p7-code",
        label: "Kimi K2.7 Code",
      },
    ],
  },
  openai: {
    apiKeyEnvKey: OPENAI_API_KEY_ENV_KEY,
    label: "OpenAI",
    modelOptions: [
      { id: "gpt-5.4-mini", label: "5.4 mini" },
      { id: "gpt-5.5", label: "5.5" },
    ],
  },
  "openai-compatible": {
    apiKeyEnvKey: OPENAI_COMPATIBLE_API_KEY_ENV_KEY,
    baseUrlEnvKey: OPENAI_COMPATIBLE_BASE_URL_ENV_KEY,
    requiresBaseUrl: true,
    label: "OpenAI-compatible",
    modelOptions: [],
  },
  anthropic: {
    apiKeyEnvKey: ANTHROPIC_API_KEY_ENV_KEY,
    baseUrlEnvKey: ANTHROPIC_BASE_URL_ENV_KEY,
    label: "Anthropic",
    modelOptions: [
      { id: "claude-haiku-4-5", label: "Haiku" },
      { id: "claude-sonnet-5", label: "Sonnet" },
      { id: "claude-opus-4-8", label: "Opus" },
    ],
  },
};

export const DEFAULT_MODEL_ID =
  PROVIDER_CONFIGS[DEFAULT_PROVIDER].modelOptions[0]?.id ?? "z-ai/glm-5.2";

export const OPENROUTER_FALLBACK_MODEL_IDS = [
  "moonshotai/kimi-k2.7-code",
  "openai/gpt-5.4-mini",
];

export function getProviderConfig(provider: SinscribeProvider): ProviderConfig {
  return PROVIDER_CONFIGS[provider];
}

export function getProviderLabel(provider: SinscribeProvider): string {
  return getProviderConfig(provider).label;
}

export function getProviderApiKeyEnvKey(provider: SinscribeProvider): string {
  return getProviderConfig(provider).apiKeyEnvKey;
}

/**
 * Resolves the base URL for a provider, preferring the override env var over
 * the built-in default. Returns undefined so callers fall back to SDK defaults.
 */
export function resolveProviderBaseUrl(
  provider: SinscribeProvider,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const config = getProviderConfig(provider);
  const override = config.baseUrlEnvKey ? env[config.baseUrlEnvKey] : undefined;
  const trimmedOverride = override?.trim();

  if (trimmedOverride) {
    return trimmedOverride;
  }

  return config.baseURL;
}

export function getProviderBaseUrlEnvKey(
  provider: SinscribeProvider,
): string | undefined {
  return getProviderConfig(provider).baseUrlEnvKey;
}

export function providerRequiresBaseUrl(provider: SinscribeProvider): boolean {
  return getProviderConfig(provider).requiresBaseUrl === true;
}

export function getProviderModelOptions(
  provider: SinscribeProvider,
): ProviderModelOption[] {
  return getProviderConfig(provider).modelOptions;
}

export function getDefaultModelId(provider: SinscribeProvider): string {
  return getProviderModelOptions(provider)[0]?.id ?? DEFAULT_MODEL_ID;
}

export function normalizeProvider(
  value: string | null | undefined,
): SinscribeProvider | null {
  if (value === undefined || value === null) {
    return null;
  }

  const provider = value.trim().toLowerCase();

  return isValidProvider(provider) ? provider : null;
}

export function isValidProvider(value: string): value is SinscribeProvider {
  return value in PROVIDER_CONFIGS;
}

export function resolveConfiguredProvider(
  overrideProvider: string | null = null,
  env: NodeJS.ProcessEnv = process.env,
): SinscribeProvider {
  return (
    normalizeProvider(overrideProvider) ??
    normalizeProvider(env[SINSCRIBE_PROVIDER_ENV_KEY]) ??
    DEFAULT_PROVIDER
  );
}

export function normalizeModelId(value: string): string {
  return value.trim();
}

export function isValidModelId(value: string): boolean {
  const modelId = normalizeModelId(value);

  return (
    modelId.length > 0 &&
    modelId.length <= 120 &&
    /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/u.test(modelId) &&
    !modelId.includes("://")
  );
}
