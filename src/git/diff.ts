import { runGit, tryGit } from "./run.js";

const MAX_DIFF_BYTES = 50_000;

export type DiffInfo = {
  /** Unified diff, size-capped for prompt safety. */
  patch: string;
  /** `git diff --name-status` output. */
  nameStatus: string;
  /** `git diff --stat` summary line(s). */
  stat: string;
  /** True when the patch was truncated to fit the size cap. */
  truncated: boolean;
  /** True when the diff is empty. */
  isEmpty: boolean;
};

export async function getStagedDiff(cwd: string): Promise<DiffInfo> {
  return collectDiff(cwd, ["--staged"]);
}

/** Diff of tracked worktree changes against HEAD (for `commit --all`). */
export async function getWorktreeDiff(cwd: string): Promise<DiffInfo> {
  return collectDiff(cwd, ["HEAD"]);
}

/**
 * Merge base of `baseRef` and HEAD, or `baseRef` itself when there is no
 * common ancestor (unrelated histories). This is the point the branch diverged
 * from its target; diffing from here keeps commits that landed on the target
 * *after* divergence out of the branch's own diff.
 */
async function resolveDiffBase(cwd: string, baseRef: string): Promise<string> {
  const mergeBase = await tryGit(cwd, ["merge-base", baseRef, "HEAD"]);

  return mergeBase?.trim() || baseRef;
}

/**
 * Diff of the branch's local state against its target branch, measured from
 * the merge base up (for `pr`). Includes uncommitted work so a PR can be
 * described before it is committed: by default the whole worktree (committed +
 * staged + unstaged tracked changes); with `staged`, only the index (committed
 * + staged). When nothing is staged and everything is committed, the default
 * form is identical to a classic `base...HEAD` range diff.
 */
export async function getLocalDiff(
  cwd: string,
  baseRef: string,
  options: { staged: boolean },
): Promise<DiffInfo> {
  const diffBase = await resolveDiffBase(cwd, baseRef);
  const selector = options.staged ? ["--cached", diffBase] : [diffBase];

  return collectDiff(cwd, selector);
}

export async function getRangeLog(
  cwd: string,
  baseRef: string,
): Promise<string> {
  return runGit(cwd, ["log", `${baseRef}..HEAD`, "--oneline"]);
}

async function collectDiff(cwd: string, selector: string[]): Promise<DiffInfo> {
  const [patch, nameStatus, stat] = await Promise.all([
    runGit(cwd, ["diff", ...selector, "--unified=3"]),
    runGit(cwd, ["diff", ...selector, "--name-status"]),
    runGit(cwd, ["diff", ...selector, "--stat"]),
  ]);
  const { text, truncated } = capText(patch, MAX_DIFF_BYTES);

  return {
    patch: text,
    nameStatus,
    stat,
    truncated,
    isEmpty: nameStatus.trim().length === 0,
  };
}

export type ShortStat = {
  files: number;
  insertions: number;
  deletions: number;
};

/**
 * Parses `git diff --numstat` output (one "<added>\t<deleted>\t<path>" line
 * per file, "-" counts for binary files). Numstat is locale-independent,
 * unlike --shortstat's translated summary line. Returns null when the diff
 * is empty or the output is unrecognized.
 */
export function parseNumStat(output: string): ShortStat | null {
  let files = 0;
  let insertions = 0;
  let deletions = 0;

  for (const line of output.split("\n")) {
    const match = /^(\d+|-)\t(\d+|-)\t/u.exec(line);

    if (!match) {
      continue;
    }

    files += 1;
    insertions += match[1] === "-" ? 0 : Number(match[1]);
    deletions += match[2] === "-" ? 0 : Number(match[2]);
  }

  return files === 0 ? null : { files, insertions, deletions };
}

/** Uncommitted tracked changes vs HEAD; null when clean or git fails. */
export async function getWorktreeShortStat(
  cwd: string,
): Promise<ShortStat | null> {
  const output = await tryGit(cwd, ["diff", "HEAD", "--numstat"]);

  return output === null ? null : parseNumStat(output);
}

/** Three-dot branch diff vs a base ref; null when empty or git fails. */
export async function getRangeShortStat(
  cwd: string,
  baseRef: string,
): Promise<ShortStat | null> {
  const output = await tryGit(cwd, ["diff", `${baseRef}...HEAD`, "--numstat"]);

  return output === null ? null : parseNumStat(output);
}

export function capText(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return { text, truncated: false };
  }

  const buffer = Buffer.from(text, "utf8").subarray(0, maxBytes);
  const capped = buffer.toString("utf8");
  const lastNewline = capped.lastIndexOf("\n");

  return {
    text: `${lastNewline > 0 ? capped.slice(0, lastNewline) : capped}\n[diff truncated to ${maxBytes} bytes]`,
    truncated: true,
  };
}
