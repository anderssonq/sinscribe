import { SECRET_ENV_KEYS } from "../constants.js";

export const REDACTED = "[REDACTED]";

/**
 * Credential shapes that must never reach a generated document. Spec docs
 * are tracked in git (and may be public), and in explore mode the model has
 * read the repository — so anything it quotes is checked here first.
 */
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu,
  /\bsk-ant-[A-Za-z0-9_-]{16,}/gu,
  /\bsk-[A-Za-z0-9_-]{20,}/gu,
  /\bAKIA[0-9A-Z]{16}\b/gu,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/gu,
  /\bgithub_pat_[A-Za-z0-9_]{30,}\b/gu,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/gu,
];

/**
 * `api_key = "…"`-style assignments. The value must be 20+ token characters,
 * so type annotations (`token: string`) and short placeholders survive.
 */
const ASSIGNMENT_PATTERN =
  /\b((?:api[_-]?key|secret|token|password|passwd)\w*["']?\s*[:=]\s*["']?)([A-Za-z0-9_\-/+=.]{20,})/giu;

export type RedactionResult = { text: string; count: number };

/** Replaces every recognised secret with [REDACTED] and counts the hits. */
export function redactSecrets(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
): RedactionResult {
  let count = 0;
  let result = text;

  // Literal values of the API keys Sinscribe itself loaded: the surest hit.
  for (const key of SECRET_ENV_KEYS) {
    const value = env[key];

    if (value && value.length >= 8 && result.includes(value)) {
      count += result.split(value).length - 1;
      result = result.split(value).join(REDACTED);
    }
  }

  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, () => {
      count += 1;

      return REDACTED;
    });
  }

  result = result.replace(
    ASSIGNMENT_PATTERN,
    (match: string, prefix: string, value: string) => {
      if (value === REDACTED || value.includes(REDACTED)) {
        return match;
      }

      count += 1;

      return `${prefix}${REDACTED}`;
    },
  );

  return { text: result, count };
}
