// TUI-only orchestration invoked after an explicit user selection; never
// called from executeCommand — the `branch` LLM command stays tool-free
// (two-tier contract: git writes happen in the CLI layer, not in a model loop).
import {
  branchExists,
  createBranchFrom,
  renameCurrentBranch,
} from "../git/repo.js";
import { tryGit } from "../git/run.js";
import {
  deleteSession,
  saveSession,
  type BranchSession,
} from "../session/store.js";
import { CliError } from "./errors.js";

export type BranchActionMode = "create" | "rename";

export type ApplyBranchNameInput = {
  cwd: string;
  repoRoot: string;
  name: string;
  mode: BranchActionMode;
  /** Start point for "create"; ignored by "rename". */
  baseRef: string | null;
  /** Session of the branch we are leaving/renaming, migrated to the new name. */
  sourceSession: BranchSession | null;
};

export type ApplyBranchNameResult = {
  branch: string;
  mode: BranchActionMode;
  baseRef: string | null;
  sessionMigrated: boolean;
};

/**
 * Applies the chosen branch name: `git checkout -b <name> <base>` (create)
 * or `git branch -m <name>` (rename), then re-keys the saved session context
 * under the new branch name so `pr` works there without re-entering it.
 * GitCommandError is deliberately not caught — it carries git's stderr.
 */
export async function applyBranchName(
  input: ApplyBranchNameInput,
): Promise<ApplyBranchNameResult> {
  if (await branchExists(input.cwd, input.name)) {
    throw new CliError(
      `Branch "${input.name}" already exists — pick another suggestion.`,
    );
  }

  if (input.mode === "create") {
    if (input.baseRef === null) {
      throw new CliError(
        "Could not resolve the target branch. Set it in the session context (Create session context → target branch).",
      );
    }

    const verified = await tryGit(input.cwd, [
      "rev-parse",
      "--verify",
      "--quiet",
      input.baseRef,
    ]);

    if (verified === null) {
      throw new CliError(
        `Target branch "${input.baseRef}" does not exist in this repository.`,
      );
    }

    await createBranchFrom(input.cwd, input.name, input.baseRef);
  } else {
    await renameCurrentBranch(input.cwd, input.name);
  }

  let sessionMigrated = false;

  if (input.sourceSession?.context) {
    const now = new Date().toISOString();

    await saveSession(input.repoRoot, {
      version: 1,
      branch: input.name,
      context: input.sourceSession.context,
      // A generated PR belongs to the branch it described; a rename keeps the
      // same line of work, a fresh branch starts without one.
      pr: input.mode === "rename" ? input.sourceSession.pr : null,
      createdAt: now,
      updatedAt: now,
    });
    sessionMigrated = true;
  }

  // A rename retires the old branch name; without this, its session file
  // would resurrect on a future branch that reuses the name. Deleted after
  // the migrated save so a lossy-key collision can never drop the new file
  // (deleteSession verifies the file's branch field first).
  if (input.mode === "rename" && input.sourceSession !== null) {
    await deleteSession(input.repoRoot, input.sourceSession.branch);
  }

  return {
    branch: input.name,
    mode: input.mode,
    baseRef: input.mode === "create" ? input.baseRef : null,
    sessionMigrated,
  };
}
