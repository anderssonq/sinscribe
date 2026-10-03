import { randomUUID } from "node:crypto";
import { SINSCRIBE_VERSION } from "../constants.js";

/**
 * OpenCode Go only routes requests that identify their client and carry a
 * stable per-conversation session id (https://opencode.ai/docs/go/ — "Where
 * can I use it"); without `x-opencode-session` it answers 400. The session id
 * is its sticky-routing and prompt-cache key, so it must stay the same across
 * every turn of one conversation and change for the next one.
 */
export function buildOpencodeGoHeaders(
  sessionId: string,
): Record<string, string> {
  return {
    "User-Agent": `sinscribe/${SINSCRIBE_VERSION}`,
    "x-opencode-client": "sinscribe",
    "x-opencode-session": sessionId,
  };
}

/**
 * A fresh session id for one conversation. 30 chars: OpenCode keeps only the
 * first 30 for usage tracking, so a longer id would just be truncated there.
 */
export function createOpencodeSessionId(): string {
  return `ses_${randomUUID().replaceAll("-", "")}`.slice(0, 30);
}
