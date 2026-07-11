import { useState } from "react";
import { Box, Text, useApp } from "ink";
import {
  getProviderApiKeyEnvKey,
  getProviderLabel,
  resolveConfiguredProvider,
  type SinscribeProvider,
} from "./constants.js";
import { saveSinscribeEnv } from "./env.js";
import { InlinePrompt } from "./ui/menu-view.js";
import { Spinner } from "./ui/spinner.js";
import { theme } from "./ui/theme.js";

export function needsCredentialSetup(
  overrideProvider: string | null = null,
  overrideApiKey: string | null = null,
): boolean {
  if (overrideApiKey && overrideApiKey.trim().length > 0) {
    return false;
  }

  const provider = resolveConfiguredProvider(overrideProvider);

  return !process.env[getProviderApiKeyEnvKey(provider)];
}

type InitSetupProps = {
  onComplete: () => void;
  onError: (message: string) => void;
  overrideProvider?: string | null;
};

/**
 * Minimal first-run wizard: asks for the configured provider's API key and
 * saves it to ~/.sinscribe/.env (0600). The value is masked while typing and
 * never echoed back.
 */
export function InitSetup({
  onComplete,
  onError,
  overrideProvider = null,
}: InitSetupProps) {
  const app = useApp();
  const provider: SinscribeProvider =
    resolveConfiguredProvider(overrideProvider);
  const apiKeyEnvKey = getProviderApiKeyEnvKey(provider);
  const [saving, setSaving] = useState(false);

  function handleSubmit(value: string) {
    const apiKey = value.trim();

    if (apiKey.length === 0) {
      return;
    }

    setSaving(true);
    saveSinscribeEnv({ [apiKeyEnvKey]: apiKey })
      .then(() => {
        onComplete();
      })
      .catch((error: unknown) => {
        onError(
          error instanceof Error
            ? error.message
            : "Failed to save credentials.",
        );
      });
  }

  return (
    <Box flexDirection="column">
      <Text>
        <Text bold>Credential setup</Text>{" "}
        <Text color={theme.dim}>
          provider: {getProviderLabel(provider)} ({apiKeyEnvKey})
        </Text>
      </Text>
      <Text color={theme.dim}>
        The key is stored in ~/.sinscribe/.env with 0600 permissions. Set
        SINSCRIBE_PROVIDER to use a different provider.
      </Text>
      {saving ? (
        <Spinner label="Saving credentials..." />
      ) : (
        <Box marginTop={1}>
          <InlinePrompt
            isActive
            label=""
            mask
            onCancel={() => {
              onError("Credential setup cancelled.");
              app.exit();
            }}
            onSubmit={handleSubmit}
            placeholder="Paste your API key, enter to save, esc to cancel"
          />
        </Box>
      )}
    </Box>
  );
}
