import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ANTHROPIC_API_KEY_ENV_KEY,
  ANTHROPIC_BASE_URL_ENV_KEY,
  BASETEN_API_KEY_ENV_KEY,
  FIREWORKS_API_KEY_ENV_KEY,
  isValidModelId,
  normalizeProvider,
  OPENAI_API_KEY_ENV_KEY,
  OPENAI_COMPATIBLE_API_KEY_ENV_KEY,
  OPENAI_COMPATIBLE_BASE_URL_ENV_KEY,
  OPENCODE_GO_API_KEY_ENV_KEY,
  OPENROUTER_API_KEY_ENV_KEY,
  SINSCRIBE_MODEL_ID_ENV_KEY,
  SINSCRIBE_PROVIDER_ENV_KEY,
  SINSCRIBE_THEME_ENV_KEY,
  SINSCRIBE_TICKET_PATTERN_ENV_KEY,
} from "./constants.js";

export const sinscribeEnvDir = path.join(os.homedir(), ".sinscribe");
export const sinscribeEnvPath = path.join(sinscribeEnvDir, ".env");
export const sinscribeTemplatesDir = path.join(sinscribeEnvDir, "templates");
export const sinscribeRulesPath = path.join(sinscribeEnvDir, "rules.md");

type EnvMap = Record<string, string>;

export type CredentialDiagnostic = {
  key: string;
  source:
    | "process.env"
    | "~/.sinscribe/.env"
    | "process.env over ~/.sinscribe/.env"
    | "unset";
  length: number | null;
  preview: string;
  warnings: string[];
};

const managedEnvKeys = [
  OPENROUTER_API_KEY_ENV_KEY,
  OPENCODE_GO_API_KEY_ENV_KEY,
  BASETEN_API_KEY_ENV_KEY,
  FIREWORKS_API_KEY_ENV_KEY,
  OPENAI_API_KEY_ENV_KEY,
  OPENAI_COMPATIBLE_API_KEY_ENV_KEY,
  OPENAI_COMPATIBLE_BASE_URL_ENV_KEY,
  ANTHROPIC_API_KEY_ENV_KEY,
  ANTHROPIC_BASE_URL_ENV_KEY,
  SINSCRIBE_PROVIDER_ENV_KEY,
  SINSCRIBE_MODEL_ID_ENV_KEY,
  SINSCRIBE_TICKET_PATTERN_ENV_KEY,
  SINSCRIBE_THEME_ENV_KEY,
];

export async function loadSinscribeEnv(): Promise<EnvMap> {
  const env = await readSinscribeEnv();

  for (const [key, value] of Object.entries(env)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }

  return env;
}

export async function getCredentialDiagnostics(): Promise<
  CredentialDiagnostic[]
> {
  const fileEnv = await readSinscribeEnv();

  return [
    SINSCRIBE_PROVIDER_ENV_KEY,
    OPENROUTER_API_KEY_ENV_KEY,
    OPENCODE_GO_API_KEY_ENV_KEY,
    BASETEN_API_KEY_ENV_KEY,
    FIREWORKS_API_KEY_ENV_KEY,
    OPENAI_API_KEY_ENV_KEY,
    OPENAI_COMPATIBLE_API_KEY_ENV_KEY,
    OPENAI_COMPATIBLE_BASE_URL_ENV_KEY,
    ANTHROPIC_API_KEY_ENV_KEY,
    ANTHROPIC_BASE_URL_ENV_KEY,
    SINSCRIBE_MODEL_ID_ENV_KEY,
  ].map((key) => createCredentialDiagnostic(key, fileEnv));
}

export async function saveSinscribeEnv(updates: EnvMap): Promise<void> {
  const currentEnv = await readSinscribeEnv();
  const nextEnv = {
    ...currentEnv,
    ...updates,
  };

  await mkdir(sinscribeEnvDir, {
    recursive: true,
    mode: 0o700,
  });
  await chmod(sinscribeEnvDir, 0o700);

  await writeFile(sinscribeEnvPath, formatEnv(nextEnv), {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(sinscribeEnvPath, 0o600);

  for (const [key, value] of Object.entries(updates)) {
    process.env[key] = value;
  }
}

function createCredentialDiagnostic(
  key: string,
  fileEnv: EnvMap,
): CredentialDiagnostic {
  const processValue = process.env[key];
  const fileValue = fileEnv[key];
  const value = processValue ?? fileValue;
  const source = getCredentialSource(processValue, fileValue);

  if (value === undefined) {
    return {
      key,
      source,
      length: null,
      preview: "<unset>",
      warnings: [],
    };
  }

  return {
    key,
    source,
    length: value.length,
    preview: isNonSecretDiagnosticKey(key)
      ? JSON.stringify(value)
      : createCredentialPreview(value),
    warnings:
      key === SINSCRIBE_MODEL_ID_ENV_KEY
        ? getModelWarnings(value)
        : key === SINSCRIBE_PROVIDER_ENV_KEY
          ? getProviderWarnings(value)
          : getCredentialWarnings(value),
  };
}

function getCredentialSource(
  processValue: string | undefined,
  fileValue: string | undefined,
): CredentialDiagnostic["source"] {
  if (processValue !== undefined && fileValue !== undefined) {
    return "process.env over ~/.sinscribe/.env";
  }

  if (processValue !== undefined) {
    return "process.env";
  }

  if (fileValue !== undefined) {
    return "~/.sinscribe/.env";
  }

  return "unset";
}

function isNonSecretDiagnosticKey(key: string): boolean {
  return (
    key === SINSCRIBE_MODEL_ID_ENV_KEY ||
    key === SINSCRIBE_PROVIDER_ENV_KEY ||
    key === ANTHROPIC_BASE_URL_ENV_KEY ||
    key === OPENAI_COMPATIBLE_BASE_URL_ENV_KEY
  );
}

export function createCredentialPreview(value: string): string {
  if (value.length <= 10) {
    return JSON.stringify("*".repeat(value.length));
  }

  return JSON.stringify(`${value.slice(0, 6)}...${value.slice(-4)}`);
}

function getCredentialWarnings(value: string): string[] {
  const warnings: string[] = [];

  if (value !== value.trim()) {
    warnings.push("leading/trailing whitespace");
  }

  if (value.includes("\n") || value.includes("\r")) {
    warnings.push("contains newline");
  }

  if (value.includes('"') || value.includes("'")) {
    warnings.push("contains quote character");
  }

  return warnings;
}

function getModelWarnings(value: string): string[] {
  return isValidModelId(value) ? [] : ["invalid model ID"];
}

function getProviderWarnings(value: string): string[] {
  return normalizeProvider(value) === null ? ["invalid provider"] : [];
}

async function readSinscribeEnv(): Promise<EnvMap> {
  try {
    return parseEnv(await readFile(sinscribeEnvPath, "utf8"));
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return {};
    }

    throw error;
  }
}

export function parseEnv(content: string): EnvMap {
  const env: EnvMap = {};

  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();

    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }

    const equalsIndex = line.indexOf("=");

    if (equalsIndex <= 0) {
      continue;
    }

    const key = line.slice(0, equalsIndex).trim();
    const rawValue = line.slice(equalsIndex + 1).trim();

    if (!/^[A-Z_][A-Z0-9_]*$/u.test(key)) {
      continue;
    }

    env[key] = parseEnvValue(rawValue);
  }

  return env;
}

function parseEnvValue(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    return value
      .slice(1, -1)
      .replace(/\\n/gu, "\n")
      .replace(/\\"/gu, '"')
      .replace(/\\\\/gu, "\\");
  }

  return value;
}

export function formatEnv(env: EnvMap): string {
  const keys = [
    ...managedEnvKeys.filter((key) => env[key] !== undefined),
    ...Object.keys(env)
      .filter((key) => !managedEnvKeys.includes(key))
      .sort(),
  ];

  return `${keys.map((key) => `${key}=${formatEnvValue(env[key] ?? "")}`).join("\n")}\n`;
}

function formatEnvValue(value: string): string {
  return `"${value
    .replace(/\\/gu, "\\\\")
    .replace(/"/gu, '\\"')
    .replace(/\n/gu, "\\n")}"`;
}

export function isFileNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
