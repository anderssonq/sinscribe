import { runGit, runGitStrict, tryGit } from "./run.js";

export class NotAGitRepositoryError extends Error {
  constructor() {
    super("Not inside a git repository.");
    this.name = "NotAGitRepositoryError";
  }
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  return (await tryGit(cwd, ["rev-parse", "--is-inside-work-tree"])) === "true";
}

export async function ensureGitRepo(cwd: string): Promise<void> {
  if (!(await isGitRepo(cwd))) {
    throw new NotAGitRepositoryError();
  }
}

export async function getCurrentBranch(cwd: string): Promise<string | null> {
  const branch = await tryGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);

  return branch && branch !== "HEAD" ? branch : null;
}

/**
 * Resolves the base ref for PR diffs: explicit override, then origin/HEAD,
 * then common default branch names. Returns null when nothing resolves.
 */
export async function resolveBaseRef(
  cwd: string,
  override: string | null,
): Promise<string | null> {
  if (override) {
    const verified = await tryGit(cwd, [
      "rev-parse",
      "--verify",
      "--quiet",
      override,
    ]);

    return verified === null ? null : override;
  }

  const originHead = await tryGit(cwd, [
    "symbolic-ref",
    "--short",
    "refs/remotes/origin/HEAD",
  ]);

  if (originHead) {
    return originHead;
  }

  for (const candidate of [
    "origin/main",
    "origin/master",
    "origin/develop",
    "main",
    "master",
    "develop",
  ]) {
    const verified = await tryGit(cwd, [
      "rev-parse",
      "--verify",
      "--quiet",
      candidate,
    ]);

    if (verified !== null) {
      return candidate;
    }
  }

  return null;
}

export async function branchExists(
  cwd: string,
  name: string,
): Promise<boolean> {
  return (
    (await tryGit(cwd, [
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/heads/${name}`,
    ])) !== null
  );
}

/** Creates and checks out a branch from an explicit start point. */
export async function createBranchFrom(
  cwd: string,
  name: string,
  startPoint: string,
): Promise<void> {
  await runGitStrict(cwd, ["checkout", "-b", name, startPoint]);
}

export async function renameCurrentBranch(
  cwd: string,
  newName: string,
): Promise<void> {
  await runGitStrict(cwd, ["branch", "-m", newName]);
}

export async function getRepoRoot(cwd: string): Promise<string | null> {
  return tryGit(cwd, ["rev-parse", "--show-toplevel"]);
}

export async function getRecentCommits(
  cwd: string,
  maxCount = 10,
): Promise<string> {
  return runGit(cwd, ["log", `--max-count=${maxCount}`, "--oneline"]);
}

/** True when `relPath` (relative to the repo root) is excluded by gitignore. */
export async function isPathIgnored(
  repoRoot: string,
  relPath: string,
): Promise<boolean> {
  // check-ignore exits 0 when ignored and 1 when not; tryGit maps 1 to null.
  return (await tryGit(repoRoot, ["check-ignore", "-q", relPath])) !== null;
}

export type CommitSubject = { sha: string; subject: string };

/**
 * Commits on HEAD since `baseRef` (or the last `maxCount` commits when there
 * is no base), newest first. Unlike getRangeLog this is structured, so the
 * plan sync can match `[T-n]` task ids in subjects to commit SHAs.
 */
export async function getRangeSubjects(
  cwd: string,
  baseRef: string | null,
  maxCount = 200,
  /** ISO date; only commits after it (used when there is no base to range from). */
  since: string | null = null,
): Promise<CommitSubject[]> {
  const range = baseRef ? [`${baseRef}..HEAD`] : [];
  const output = await tryGit(cwd, [
    "log",
    ...range,
    ...(since ? [`--since=${since}`] : []),
    `--max-count=${maxCount}`,
    "--format=%h%x09%s",
  ]);

  if (!output) {
    return [];
  }

  return output
    .split("\n")
    .map((line) => {
      const tab = line.indexOf("\t");

      return tab === -1
        ? null
        : { sha: line.slice(0, tab), subject: line.slice(tab + 1) };
    })
    .filter((entry): entry is CommitSubject => entry !== null);
}
