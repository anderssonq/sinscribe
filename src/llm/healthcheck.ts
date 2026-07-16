// Explicit user-triggered connectivity check for the settings wizard.
// Never reachable from any --dry-run path (dry runs return before settings
// or model code loads credentials).
import {
  getProviderApiKeyEnvKey,
  getProviderBaseUrlEnvKey,
  getProviderCommand,
  getProviderLabel,
  providerRequiresBaseUrl,
  resolveProviderBaseUrl,
  type SinscribeProvider,
} from "../constants.js";

export const ANTHROPIC_DEFAULT_API_URL = "https://api.anthropic.com";
export const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";

export type HealthcheckResult =
  | {
      ok: true;
      /** Models listed by the endpoint; null when the shape is unknown. */
      modelCount: number | null;
      /** Whether the configured model appears in the list; null when unknown. */
      modelFound: boolean | null;
    }
  | { ok: false; message: string };

type HealthcheckInput = {
  provider: SinscribeProvider;
  apiKey: string;
  modelId: string;
  timeoutMs?: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
};

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/u, "");
}

/** Resolves the models-list URL and auth headers per provider family. */
function buildRequest(
  input: HealthcheckInput,
): { url: string; headers: Record<string, string> } | { error: string } {
  const localCli = getProviderCommand(input.provider);

  if (localCli !== null) {
    return {
      error:
        `${getProviderLabel(input.provider)} has no API key to test — the ` +
        `${localCli.command} CLI owns its own sign-in. Verify it with ` +
        `\`${localCli.command} chat --no-interactive "hi"\`.`,
    };
  }

  if (input.provider === "anthropic") {
    const base =
      resolveProviderBaseUrl(input.provider) ?? ANTHROPIC_DEFAULT_API_URL;

    return {
      url: `${stripTrailingSlash(base)}/v1/models`,
      headers: {
        "x-api-key": input.apiKey,
        "anthropic-version": "2023-06-01",
      },
    };
  }

  const base =
    resolveProviderBaseUrl(input.provider) ??
    (input.provider === "openai" ? OPENAI_DEFAULT_BASE_URL : undefined);

  if (!base) {
    const envKey = providerRequiresBaseUrl(input.provider)
      ? (getProviderBaseUrlEnvKey(input.provider) ?? "a base URL")
      : "a base URL";

    return { error: `${envKey} is required to test this provider.` };
  }

  return {
    url: `${stripTrailingSlash(base)}/models`,
    headers: { Authorization: `Bearer ${input.apiKey}` },
  };
}

/** Defensive parse of an OpenAI/Anthropic-style models list. */
function parseModelsPayload(
  payload: unknown,
  modelId: string,
): { modelCount: number | null; modelFound: boolean | null } {
  if (typeof payload !== "object" || payload === null) {
    return { modelCount: null, modelFound: null };
  }

  const data = (payload as { data?: unknown }).data;

  if (!Array.isArray(data)) {
    return { modelCount: null, modelFound: null };
  }

  const ids = data
    .map((entry) =>
      typeof entry === "object" && entry !== null
        ? (entry as { id?: unknown }).id
        : undefined,
    )
    .filter((id): id is string => typeof id === "string");

  return {
    modelCount: data.length,
    modelFound: ids.length > 0 ? ids.includes(modelId) : null,
  };
}

function describeNetworkError(error: unknown, host: string): string {
  if (error instanceof Error && error.name === "TimeoutError") {
    return `Connection to ${host} timed out.`;
  }

  const cause =
    error instanceof Error && error.cause instanceof Error
      ? error.cause
      : error;
  const code =
    typeof cause === "object" && cause !== null && "code" in cause
      ? String(cause.code)
      : null;

  return `Network error${code ? ` (${code})` : ""} — could not reach ${host}.`;
}

/**
 * Verifies provider connectivity and the API key with a GET of the models
 * list (free — no tokens generated). Error messages never include the key.
 */
export async function testProviderConnection(
  input: HealthcheckInput,
): Promise<HealthcheckResult> {
  const request = buildRequest(input);

  if ("error" in request) {
    return { ok: false, message: request.error };
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  const host = new URL(request.url).host;
  let response: Response;

  try {
    response = await fetchImpl(request.url, {
      headers: request.headers,
      signal: AbortSignal.timeout(input.timeoutMs ?? 10_000),
    });
  } catch (error) {
    return { ok: false, message: describeNetworkError(error, host) };
  }

  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      message: `API key rejected (HTTP ${response.status}) — check the ${getProviderApiKeyEnvKey(input.provider) ?? "API key"} value.`,
    };
  }

  if (response.status === 404) {
    return {
      ok: false,
      message: `Models endpoint not found at ${request.url} — check the base URL.`,
    };
  }

  if (!response.ok) {
    return { ok: false, message: `HTTP ${response.status} from ${host}.` };
  }

  let payload: unknown = null;

  try {
    payload = await response.json();
  } catch {
    // A 2xx with a non-JSON body still proves the key was accepted.
  }

  return { ok: true, ...parseModelsPayload(payload, input.modelId) };
}
