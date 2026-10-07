import { providerExploreKind } from "../constants.js";
import { runReadOnlyAgent } from "./agent.js";
import { ChatClaudeCli } from "./claude-cli/model.js";
import {
  ExploreUnsupportedError,
  runClaudeExplore,
} from "./claude-cli/explore.js";
import { emitDebug } from "./events.js";
import { runKiroExplore } from "./kiro-cli/explore.js";
import { ChatKiroCli } from "./kiro-cli/model.js";
import { resolveModel } from "./model.js";
import { runSingleShot, type SingleShotOptions } from "./single-shot.js";

/**
 * The read-only explore tier: the model may read the repository (never
 * write, never run anything) before answering. Used by the spec plan's
 * requirements and design stages and by the AI session-context draft. Every
 * path ends in the same contract — one final document — and every path has a
 * single-shot fallback, so no provider is locked out:
 *
 * - claude-cli: the CLI's own Read/Glob/Grep under --restricted (repo-confined)
 * - api-key providers: deepagents FilesystemBackend with write-deny permissions
 * - kiro-cli: a per-run agent whose only tool is fs_read, confined to the repo
 * - --no-explore / an old claude CLI: single-shot + repo brief
 */

export type ExploreMode =
  | "claude-cli-readonly"
  | "kiro-cli-readonly"
  | "agent-readonly"
  | "single-shot";

export type ExploreOptions = SingleShotOptions & {
  repoRoot: string;
  /** False forces single-shot (--no-explore). */
  explore: boolean;
  /**
   * Orientation appended to the user prompt when the model cannot explore
   * (the repo brief). Lazy, so it is only built when needed.
   */
  fallbackContext: () => Promise<string>;
  /** Why single-shot when `explore` is false; defaults to "--no-explore". */
  singleShotReason?: string;
  maxTurns?: number;
};

export type ExploreResult = {
  text: string;
  modelId: string;
  mode: ExploreMode;
  /** Repo-relative paths the model actually read (empty for single-shot). */
  filesRead: string[];
  /** Why exploration did not happen, when it did not. */
  fallbackReason: string | null;
};

export async function runExplore(
  systemPrompt: string,
  userPrompt: string,
  options: ExploreOptions,
): Promise<ExploreResult> {
  if (!options.explore) {
    return singleShot(
      systemPrompt,
      userPrompt,
      options,
      options.singleShotReason ?? "--no-explore",
    );
  }

  // Resolving first loads ~/.sinscribe/.env, so a provider configured there
  // (not just via flags) picks the right route.
  const resolved = await resolveModel({
    modelId: options.modelId ?? null,
    provider: options.provider ?? null,
    apiKey: options.apiKey ?? null,
  });
  const kind = providerExploreKind(resolved.provider);

  emitDebug(options, `explore kind=${kind}`);

  if (kind === "claude-cli" && resolved.model instanceof ChatClaudeCli) {
    options.onEvent?.({
      type: "status",
      message: "Exploring the repository (read-only)…",
    });

    try {
      const result = await runClaudeExplore({
        command: resolved.model.command,
        model: resolved.model.model,
        systemPrompt: withExploreClause(systemPrompt),
        userPrompt,
        repoRoot: options.repoRoot,
        maxTurns: options.maxTurns,
        debug: options.debug,
        onEvent: options.onEvent,
      });

      return {
        text: result.text,
        modelId: resolved.modelId,
        mode: "claude-cli-readonly",
        filesRead: result.filesRead,
        fallbackReason: null,
      };
    } catch (error) {
      // Only a missing capability degrades silently; auth, timeouts and
      // turn limits surface so the user decides (the UI offers a retry
      // without exploring).
      if (error instanceof ExploreUnsupportedError) {
        options.onEvent?.({ type: "status", message: error.message });

        return singleShot(systemPrompt, userPrompt, options, error.message);
      }

      throw error;
    }
  }

  if (kind === "kiro-cli" && resolved.model instanceof ChatKiroCli) {
    options.onEvent?.({
      type: "status",
      message: "Exploring the repository (read-only)…",
    });

    const result = await runKiroExplore({
      command: resolved.model.command,
      model: resolved.model.model,
      systemPrompt: withExploreClause(systemPrompt),
      userPrompt,
      repoRoot: options.repoRoot,
      debug: options.debug,
      onEvent: options.onEvent,
    });

    return {
      text: result.text,
      modelId: resolved.modelId,
      mode: "kiro-cli-readonly",
      filesRead: result.filesRead,
      fallbackReason: null,
    };
  }

  if (kind === "agent") {
    options.onEvent?.({
      type: "status",
      message: "Exploring the repository (read-only)…",
    });

    const result = await runReadOnlyAgent(
      withExploreClause(systemPrompt),
      userPrompt,
      options.repoRoot,
      options,
    );

    return {
      text: result.text,
      modelId: result.modelId,
      mode: "agent-readonly",
      filesRead: result.filesRead,
      fallbackReason: null,
    };
  }

  return singleShot(
    systemPrompt,
    userPrompt,
    options,
    "this provider cannot explore the repository yet",
  );
}

async function singleShot(
  systemPrompt: string,
  userPrompt: string,
  options: ExploreOptions,
  reason: string,
): Promise<ExploreResult> {
  const brief = await options.fallbackContext();
  const prompt =
    brief.length > 0
      ? `${userPrompt}\n\nRepository orientation (you cannot open files; rely on this):\n${brief}`
      : userPrompt;
  const result = await runSingleShot(systemPrompt, prompt, options);

  return {
    text: result.text,
    modelId: result.modelId,
    mode: "single-shot",
    filesRead: [],
    fallbackReason: reason,
  };
}

/** Appended only when tools exist, so single-shot prompts never mention them. */
export const EXPLORE_CLAUSE = [
  "",
  "You can read this repository with read-only tools (read files, list/glob,",
  "grep). Read what you need to ground the document — existing modules,",
  "conventions, data models, API surfaces, tests, and the build/test commands —",
  "but budget yourself: about 25 tool calls, then write. You cannot write files",
  "or run commands. Never open .env files, keys, or credentials. When you are",
  "done reading, reply with ONLY the final document — no narration of what you",
  "read.",
].join("\n");

export function withExploreClause(systemPrompt: string): string {
  return `${systemPrompt}\n${EXPLORE_CLAUSE}`;
}
