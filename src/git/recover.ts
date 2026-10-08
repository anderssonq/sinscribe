import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { sanitizeBranchKey } from "../session/store.js";
import { getCurrentBranch, getRepoRoot, isPathIgnored } from "./repo.js";
import { runGit, runGitStrict, tryGit } from "./run.js";
import { extractTicketId } from "./ticket.js";

/**
 * Taking over a branch an automated pipeline gave up on: find it from a
 * ticket or a name, bring it up to date, and open it — in place, or in its
 * own worktree so the work in progress here is never touched. Everything is
 * plain git; nothing here knows which pipeline produced the branch.
 */

export type RecoveryBranch = {
  /** Local branch name (no remote prefix). */
  name: string;
  existsLocally: boolean;
  /** The remote the branch was found on, or null when it is local-only. */
  remote: string | null;
};

export type RecoveryWorkspace = {
  branch: string;
  /** Where the branch is checked out — the directory to work in. */
  workdir: string;
  mode: "current" | "checkout" | "worktree";
  /** What happened, one line each, for the author. */
  notes: string[];
};

/**
 * Why `branch` cannot be the one to recover, or null when it can. The base
 * branch is where failed work is meant to land, never the failed work itself:
 * recovering it reads the wrong tree and drafts a context (and a plan) from
 * the absence of everything the pipeline wrote. A remote-qualified base
 * ("origin/main") matches its local name. Without a known base, allow it.
 */
export function recoveryBaseConflict(
  branch: string,
  baseRef: string | null,
): string | null {
  if (
    baseRef === null ||
    (branch !== baseRef && !baseRef.endsWith(`/${branch}`))
  ) {
    return null;
  }

  return `${branch} is the base branch (${baseRef}), not a branch a pipeline left behind. Pass the failed branch or its ticket: sinscribe recover <ticket|branch>.`;
}

/** Worktrees live here, under the main checkout, kept out of git status. */
export const RECOVERY_WORKTREES_DIR = ".worktrees";

export type BranchListing = {
  local: string[];
  /** Remote-tracking branches as "<remote>/<name>", HEAD aliases dropped. */
  remote: string[];
};

export async function listBranches(cwd: string): Promise<BranchListing> {
  const [local, remote] = await Promise.all([
    tryGit(cwd, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]),
    tryGit(cwd, ["for-each-ref", "--format=%(refname:short)", "refs/remotes"]),
  ]);
  const lines = (output: string | null): string[] =>
    (output ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

  return {
    local: lines(local),
    remote: lines(remote).filter(
      (ref) => ref.includes("/") && !ref.endsWith("/HEAD"),
    ),
  };
}

export async function listRemotes(cwd: string): Promise<string[]> {
  return ((await tryGit(cwd, ["remote"])) ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Branches the target names. An exact branch name (with or without its
 * remote prefix) wins; otherwise a ticket id matches every branch that
 * carries it as a whole token. Exported for tests: pure over the listing.
 */
export function matchRecoveryTarget(
  target: string,
  listing: BranchListing,
  remotes: string[],
): RecoveryBranch[] {
  const wanted = target.trim();
  const byName = new Map<string, RecoveryBranch>();

  for (const name of listing.local) {
    byName.set(name, { name, existsLocally: true, remote: null });
  }

  for (const ref of listing.remote) {
    const remote = remotes.find((candidate) => ref.startsWith(`${candidate}/`));

    if (remote === undefined) {
      continue;
    }

    const name = ref.slice(remote.length + 1);
    const known = byName.get(name);

    // Prefer origin when the branch exists on several remotes.
    if (known === undefined) {
      byName.set(name, { name, existsLocally: false, remote });
    } else if (known.remote === null || remote === "origin") {
      byName.set(name, { ...known, remote });
    }
  }

  const stripped = remotes.reduce(
    (name, remote) =>
      name.startsWith(`${remote}/`) ? name.slice(remote.length + 1) : name,
    wanted,
  );
  const exact = byName.get(wanted) ?? byName.get(stripped);

  if (exact !== undefined) {
    return [exact];
  }

  const ticket = extractTicketId(wanted);

  if (ticket === null) {
    return [];
  }

  const token = new RegExp(
    `(^|[^A-Za-z0-9])${escapeRegExp(ticket)}($|[^A-Za-z0-9])`,
    "iu",
  );

  return [...byName.values()]
    .filter((branch) => token.test(branch.name))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * One branch for the target, or a CliError-shaped message listing what
 * matched. Among several matches, the one that ends with the ticket wins —
 * pipelines name the build branch after the ticket and suffix the side
 * branches ("…/ABC-1" over "…/ABC-1-design").
 */
export function pickRecoveryBranch(
  target: string,
  matches: RecoveryBranch[],
): RecoveryBranch | string {
  if (matches.length === 1) {
    return matches[0];
  }

  if (matches.length === 0) {
    return `No branch matches "${target}". Pass the exact branch name, or fetch first (drop --no-fetch).`;
  }

  const ticket = extractTicketId(target);
  const ending =
    ticket === null
      ? []
      : matches.filter((branch) =>
          new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(ticket)}$`, "iu").test(
            branch.name,
          ),
        );

  if (ending.length === 1) {
    return ending[0];
  }

  return [
    `Several branches match "${target}" — pass the one to recover:`,
    ...matches.map((branch) => `  ${branch.name}`),
  ].join("\n");
}

/**
 * Fetches the remote the branch lives on (origin, else the first remote).
 * A failed fetch is not fatal — the recovery can still work from what is
 * already local — so it comes back as a note instead of an error.
 */
export async function fetchForRecovery(
  cwd: string,
): Promise<{ remote: string | null; note: string }> {
  const remotes = await listRemotes(cwd);
  const remote = remotes.includes("origin") ? "origin" : (remotes[0] ?? null);

  if (remote === null) {
    return {
      remote: null,
      note: "No remote configured — using local branches only.",
    };
  }

  try {
    await runGitStrict(cwd, ["fetch", "--prune", remote], {
      timeoutMs: 120_000,
    });

    return { remote, note: `Fetched ${remote}.` };
  } catch (error) {
    return {
      remote,
      note: `Could not fetch ${remote} (${firstLine(error)}) — using what is already local.`,
    };
  }
}

/**
 * Opens the branch to work on. In place, the working tree must be clean of
 * tracked changes: a checkout must never carry or clobber someone's edits.
 * A worktree avoids that entirely and is reused when the branch already has
 * one. Either way a local branch that is only behind its remote is
 * fast-forwarded; a diverged one is left alone and reported.
 */
export async function prepareRecoveryWorkspace(
  cwd: string,
  branch: RecoveryBranch,
  options: { worktree: boolean },
): Promise<RecoveryWorkspace> {
  const notes: string[] = [];
  const existing = await findWorktreeFor(cwd, branch.name);

  if (existing !== null) {
    const current = await getRepoRoot(cwd);

    notes.push(
      current !== null && samePath(current, existing)
        ? `${branch.name} is already checked out here.`
        : `${branch.name} is already checked out at ${existing} — working there.`,
    );
    await fastForward(existing, branch, notes);

    return {
      branch: branch.name,
      workdir: existing,
      mode:
        current !== null && samePath(current, existing)
          ? "current"
          : "worktree",
      notes,
    };
  }

  if (options.worktree) {
    const mainRoot = await getMainWorktreeRoot(cwd);
    const workdir = path.join(
      mainRoot,
      RECOVERY_WORKTREES_DIR,
      sanitizeBranchKey(extractTicketId(branch.name) ?? branch.name),
    );

    if (await pathExists(workdir)) {
      throw new Error(
        `${workdir} already exists and is not a worktree of ${branch.name}. Remove it or recover in place (without --worktree).`,
      );
    }

    await mkdir(path.dirname(workdir), { recursive: true });
    await runGitStrict(
      mainRoot,
      branch.existsLocally
        ? ["worktree", "add", workdir, branch.name]
        : [
            "worktree",
            "add",
            "--track",
            "-b",
            branch.name,
            workdir,
            `${branch.remote ?? "origin"}/${branch.name}`,
          ],
    );
    await excludeWorktreesDir(mainRoot);
    notes.push(`Created the worktree ${workdir} for ${branch.name}.`);

    if (branch.existsLocally) {
      await fastForward(workdir, branch, notes);
    }

    return { branch: branch.name, workdir, mode: "worktree", notes };
  }

  const dirty = await runGit(cwd, [
    "status",
    "--porcelain",
    "--untracked-files=no",
  ]);

  if (dirty.length > 0) {
    throw new Error(
      `You have uncommitted changes on ${(await getCurrentBranch(cwd)) ?? "this checkout"}. Commit or stash them, or recover in a separate worktree with --worktree.`,
    );
  }

  await runGitStrict(
    cwd,
    branch.existsLocally
      ? ["checkout", branch.name]
      : [
          "checkout",
          "--track",
          "-b",
          branch.name,
          `${branch.remote ?? "origin"}/${branch.name}`,
        ],
  );
  notes.push(`Checked out ${branch.name}.`);

  if (branch.existsLocally) {
    await fastForward(cwd, branch, notes);
  }

  return {
    branch: branch.name,
    workdir: (await getRepoRoot(cwd)) ?? cwd,
    mode: "checkout",
    notes,
  };
}

async function fastForward(
  workdir: string,
  branch: RecoveryBranch,
  notes: string[],
): Promise<void> {
  if (branch.remote === null) {
    return;
  }

  const upstream = `${branch.remote}/${branch.name}`;
  const counts = await tryGit(workdir, [
    "rev-list",
    "--left-right",
    "--count",
    `${branch.name}...${upstream}`,
  ]);
  const [ahead = 0, behind = 0] = (counts ?? "")
    .split(/\s+/u)
    .map((value) => Number.parseInt(value, 10) || 0);

  if (behind === 0) {
    return;
  }

  if (ahead > 0) {
    notes.push(
      `${branch.name} has diverged from ${upstream} (${ahead} local, ${behind} remote commits) — left as is; reconcile it before pushing.`,
    );
    return;
  }

  if ((await tryGit(workdir, ["merge", "--ff-only", upstream])) === null) {
    notes.push(
      `${branch.name} is ${behind} commits behind ${upstream} and could not fast-forward — pull it before you start.`,
    );
    return;
  }

  notes.push(`Fast-forwarded ${branch.name} to ${upstream} (+${behind}).`);
}

/** The path of the worktree that has `branch` checked out, if any. */
async function findWorktreeFor(
  cwd: string,
  branch: string,
): Promise<string | null> {
  const listing = await tryGit(cwd, ["worktree", "list", "--porcelain"]);
  let current: string | null = null;

  for (const line of (listing ?? "").split("\n")) {
    if (line.startsWith("worktree ")) {
      current = line.slice("worktree ".length);
    } else if (line === `branch refs/heads/${branch}` && current !== null) {
      return current;
    }
  }

  return null;
}

/**
 * The main checkout's root, also from inside a linked worktree — so
 * recovering from a worktree never nests a new one inside it.
 */
async function getMainWorktreeRoot(cwd: string): Promise<string> {
  const listing = await tryGit(cwd, ["worktree", "list", "--porcelain"]);
  const first = (listing ?? "")
    .split("\n")
    .find((line) => line.startsWith("worktree "));

  return first?.slice("worktree ".length) ?? (await getRepoRoot(cwd)) ?? cwd;
}

/**
 * Keeps `.worktrees/` out of `git status` through the repository's local
 * exclude file — never the committed .gitignore, which is the team's.
 */
async function excludeWorktreesDir(mainRoot: string): Promise<void> {
  if (await isPathIgnored(mainRoot, `${RECOVERY_WORKTREES_DIR}/`)) {
    return;
  }

  const commonDir = await tryGit(mainRoot, ["rev-parse", "--git-common-dir"]);

  if (commonDir === null) {
    return;
  }

  const excludePath = path.join(
    path.resolve(mainRoot, commonDir),
    "info",
    "exclude",
  );
  const current = await readFile(excludePath, "utf8").catch(() => "");
  const entry = `/${RECOVERY_WORKTREES_DIR}/`;

  if (current.split("\n").includes(entry)) {
    return;
  }

  await mkdir(path.dirname(excludePath), { recursive: true });
  await appendFile(
    excludePath,
    `${current.length > 0 && !current.endsWith("\n") ? "\n" : ""}${entry}\n`,
  );
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  return message.split("\n")[0] ?? message;
}
