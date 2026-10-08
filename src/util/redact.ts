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
 * so type annotations (`token: string`) and short placeholders survive, and
 * it must look like a credential (see looksLikeSecretValue), so code that a
 * spec names on purpose — `token: RefreshTokenResponse`,
 * `secretKey = process.env.SESSION_SECRET_KEY` — survives too.
 */
const ASSIGNMENT_PATTERN =
  /\b((?:api[_-]?key|secret|token|password|passwd)\w*["']?\s*[:=]\s*["']?)([A-Za-z0-9_\-/+=.]{20,})(\(?)/giu;

/** A dotted member path: `process.env.SESSION_SECRET_KEY`, `config.auth.token`. */
const MEMBER_PATH = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/u;
/** A file path with an extension: `config/production/tokens.yml`. */
const FILE_PATH = /^[\w.-]+(?:\/[\w.-]+)*\.[A-Za-z]{1,5}$/u;

/**
 * Generated keys, hashes and base64 blobs mix letters with digits; the
 * identifiers, member paths and file paths a spec refers to rarely do.
 */
function looksLikeSecretValue(value: string, isCall: boolean): boolean {
  if (isCall || MEMBER_PATH.test(value)) {
    return false;
  }

  if (FILE_PATH.test(value) && value.includes("/")) {
    return false;
  }

  const digits = value.replace(/[^0-9]/gu, "").length;
  const letters = value.replace(/[^A-Za-z]/gu, "").length;

  return digits >= 2 && letters >= 2;
}

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
    (match: string, prefix: string, value: string, call: string) => {
      if (
        value.includes(REDACTED) ||
        !looksLikeSecretValue(value, call.length > 0)
      ) {
        return match;
      }

      count += 1;

      return `${prefix}${REDACTED}${call}`;
    },
  );

  return { text: result, count };
}
