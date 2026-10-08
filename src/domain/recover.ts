import path from "node:path";
import type { CommandSpec, GlobalFlags } from "../commands.js";
import { getCurrentBranch, getRepoRoot, resolveBaseRef } from "../git/repo.js";
import {
  fetchForRecovery,
  listBranches,
  listRemotes,
  matchRecoveryTarget,
  pickRecoveryBranch,
  prepareRecoveryWorkspace,
  RECOVERY_WORKTREES_DIR,
  type RecoveryBranch,
  type RecoveryWorkspace,
} from "../git/recover.js";
import { extractTicketId } from "../git/ticket.js";
import type { RunCallbacks } from "../llm/events.js";
import {
  getSessionPath,
  loadSession,
  saveSession,
  type SessionContext,
} from "../session/store.js";
import { CliError } from "./errors.js";
import {
  listRecoveryCandidates,
  readDiagnosis,
  RECOVERY_DIRECTION,
} from "./recover-evidence.js";
import { createSessionDraftRun, toSessionContext } from "./session-draft.js";

/**
 * Recovery mode: an automated pipeline worked on a branch and gave up (its
 * fix attempts ran out, tests stayed red). The developer takes over here —
 * open the branch, let the AI read what the pipeline left behind (specs,
 * plans, logs, notes, its commits) read-only, and turn that into the
 * branch's session context. From there the existing flows take it: a quick
 * bugfix prompt, or the spec plan for a heavier rework.
 *
 * Nothing here is tied to a particular pipeline: the evidence is whatever
 * the branch carries, plus an optional diagnosis file the developer copies
 * from the ticket or the CI run.
 */

type RecoverSpec = Extract<CommandSpec, { name: "recover" }>;

/**
 * Finds the branch and opens it: fetch (unless told not to), resolve the
 * target, then check it out in place or in a worktree. With no target the
 * current branch is the one to recover and nothing moves.
 */
export async function openRecoveryWorkspace(
  spec: RecoverSpec,
  cwd: string,
): Promise<RecoveryWorkspace> {
  const repoRoot = await getRepoRoot(cwd);

  if (repoRoot === null) {
    throw new CliError("recover must run inside a git repository.");
  }

  if (spec.target === null) {
    const branch = await getCurrentBranch(cwd);

    if (branch === null) {
      throw new CliError(
        "HEAD is detached — pass the branch or ticket to recover.",
      );
    }

    return {
      branch,
      workdir: repoRoot,
      mode: "current",
      notes: [`Recovering the current branch, ${branch}.`],
    };
  }

  const notes: string[] = [];

  if (spec.fetch) {
    notes.push((await fetchForRecovery(cwd)).note);
  }

  const branch = await resolveRecoveryBranch(cwd, spec.target);

  try {
    const workspace = await prepareRecoveryWorkspace(cwd, branch, {
      worktree: spec.worktree,
    });

    return { ...workspace, notes: [...notes, ...workspace.notes] };
  } catch (error) {
    throw new CliError(error instanceof Error ? error.message : String(error));
  }
}

async function resolveRecoveryBranch(
  cwd: string,
  target: string,
): Promise<RecoveryBranch> {
  const [listing, remotes] = await Promise.all([
    listBranches(cwd),
    listRemotes(cwd),
  ]);
  const picked = pickRecoveryBranch(
    target,
    matchRecoveryTarget(target, listing, remotes),
  );

  if (typeof picked === "string") {
    throw new CliError(picked);
  }

  return picked;
}

/** The workspace as the lines the author sees before anything else. */
export function describeRecoveryWorkspace(
  workspace: RecoveryWorkspace,
): string[] {
  return [
    ...workspace.notes,
    workspace.mode === "worktree"
      ? `Work there: cd ${workspace.workdir}`
      : null,
  ].filter((line): line is string => line !== null);
}

/**
 * What a recovery would do, from local refs only: no fetch, no checkout, no
 * model, no credentials. The candidate list is read from the branch's tree,
 * so it is accurate even before the branch is opened.
 */
export async function dryRunRecover(
  spec: RecoverSpec,
  cwd: string,
): Promise<string> {
  const repoRoot = await getRepoRoot(cwd);

  if (repoRoot === null) {
    throw new CliError("recover must run inside a git repository.");
  }

  let branchLine: string;
  let ref = "HEAD";
  let branchName: string | null;

  if (spec.target === null) {
    branchName = await getCurrentBranch(cwd);
    branchLine = `${branchName ?? "(detached HEAD)"} (current branch)`;
  } else {
    const [listing, remotes] = await Promise.all([
      listBranches(cwd),
      listRemotes(cwd),
    ]);
    const picked = pickRecoveryBranch(
      spec.target,
      matchRecoveryTarget(spec.target, listing, remotes),
    );

    if (typeof picked === "string") {
      branchName = null;
      branchLine = `(unresolved from local refs) ${picked.split("\n").join(" ")}`;
    } else {
      branchName = picked.name;
      ref = picked.existsLocally
        ? picked.name
        : `${picked.remote ?? "origin"}/${picked.name}`;
      branchLine = `${picked.name} (${picked.existsLocally ? "local" : `from ${ref}`})`;
    }
  }

  const ticket =
    (branchName !== null ? extractTicketId(branchName) : null) ??
    (spec.target !== null ? extractTicketId(spec.target) : null);
  const baseRef = await resolveBaseRef(cwd, null);
  const candidates =
    branchName === null
      ? []
      : await listRecoveryCandidates(repoRoot, { ticket, baseRef, ref });
  const workspaceLine =
    spec.target === null
      ? "stay on the current branch"
      : spec.worktree
        ? `worktree under ${path.join(repoRoot, RECOVERY_WORKTREES_DIR)}/ (reused when the branch already has one)`
        : "checkout in place (refused with uncommitted changes)";

  return [
    "sinscribe recover (dry run: no fetch, no checkout, no LLM call, no credentials read)",
    "",
    `Target:     ${spec.target ?? "(current branch)"}`,
    `Branch:     ${branchLine}`,
    `Fetch:      ${spec.target === null ? "(not needed)" : spec.fetch ? "yes, before resolving the branch" : "no (--no-fetch)"}`,
    `Workspace:  ${workspaceLine}`,
    `Ticket:     ${ticket ?? "(none detected)"}`,
    `Base:       ${baseRef ?? "(none detected)"}`,
    `Diagnosis:  ${spec.from === null ? "(none — pass --from <file> with the pipeline's failure notes)" : path.resolve(cwd, spec.from)}`,
    "",
    `Evidence the AI would read first (${candidates.length}):`,
    ...(candidates.length > 0
      ? candidates.map((file) => `  ${file}`)
      : [
          "  (none found by name — the AI still reads the commits and the code)",
        ]),
    "",
    "Then: the AI drafts the branch's session context read-only; you review it,",
    "and continue with a quick bugfix prompt or the spec plan.",
  ].join("\n");
}

/**
 * -p/--print: open the branch, draft the recovery context in one exploring
 * round, and print it. Saved only with --save — in an interactive run the
 * author approves it first.
 */
export async function runRecover(
  spec: RecoverSpec,
  flags: GlobalFlags,
  cwd: string,
  callbacks: RunCallbacks = {},
): Promise<string> {
  const diagnosisPath =
    spec.from === null ? null : path.resolve(cwd, spec.from);

  // Read before touching git: a typo in the path must not cost a checkout.
  if (diagnosisPath !== null) {
    await readDiagnosis(diagnosisPath);
  }

  const workspace = await openRecoveryWorkspace(spec, cwd);
  const run = await createSessionDraftRun(flags, workspace.workdir, {
    previous: null,
    recovery: { diagnosisPath },
  });
  const draft = await run.generate(
    { feedback: null, explore: true, direction: RECOVERY_DIRECTION },
    callbacks,
  );
  const context = toSessionContext(draft, { keepOpenQuestions: true });
  const saved = spec.save
    ? await saveRecoveryContext(workspace.workdir, workspace.branch, context)
    : null;

  return [
    ...describeRecoveryWorkspace(workspace),
    "",
    formatRecoveryContext(context),
    "",
    saved !== null
      ? `Saved as the session context of ${workspace.branch} (${saved}). Next: sinscribe prompt --type bugfix, or sinscribe plan.`
      : "Not saved. Re-run with --save, or run sinscribe recover interactively to review it first.",
  ].join("\n");
}

async function saveRecoveryContext(
  workdir: string,
  branch: string,
  context: SessionContext,
): Promise<string> {
  const repoRoot = (await getRepoRoot(workdir)) ?? workdir;
  const existing = await loadSession(repoRoot, branch);
  const now = new Date().toISOString();

  await saveSession(repoRoot, {
    version: 1,
    branch,
    context,
    pr: existing?.pr ?? null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });

  return getSessionPath(repoRoot, branch);
}

function formatRecoveryContext(context: SessionContext): string {
  return [
    "Feature",
    context.feature,
    "",
    `Ticket: ${context.ticket ?? "(none)"}`,
    `Target branch: ${context.baseRef ?? "(auto-detect)"}`,
    "",
    "Requirements",
    context.requirements ?? "(none found)",
  ].join("\n");
}
