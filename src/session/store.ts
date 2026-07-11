import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export type SessionContext = {
  feature: string;
  ticket: string | null;
  requirements: string | null;
  /**
   * Target branch this feature will merge into — chosen when the context is
   * created and used as the default base for `pr`'s diff. Optional so sessions
   * written before this field parse fine (treated as "no stored target").
   */
  baseRef?: string | null;
};

export type GeneratedPr = {
  template: string;
  description: string;
  baseRef: string;
  generatedAt: string;
};

export type BranchSession = {
  version: 1;
  /** Raw branch name — source of truth; the filename is only a lookup key. */
  branch: string;
  /** Null when the session was created implicitly by a direct `pr` run. */
  context: SessionContext | null;
  pr: GeneratedPr | null;
  createdAt: string;
  updatedAt: string;
};

const SESSIONS_DIRNAME = ".sinscribe";
const MAX_KEY_LENGTH = 100;

/** Turns a branch name into a safe session filename key. */
export function sanitizeBranchKey(branch: string): string {
  const key = branch
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^[-.]+|[-.]+$/gu, "")
    .slice(0, MAX_KEY_LENGTH);

  return key.length > 0 ? key : "detached-head";
}

export function getSessionsDir(repoRoot: string): string {
  return path.join(repoRoot, SESSIONS_DIRNAME, "sessions");
}

export function getSessionPath(repoRoot: string, branch: string): string {
  return path.join(
    getSessionsDir(repoRoot),
    `${sanitizeBranchKey(branch)}.json`,
  );
}

/**
 * Loads the session for a branch. Returns null when the file is missing,
 * unparseable, or was written for a different branch (lossy key collision).
 */
export async function loadSession(
  repoRoot: string,
  branch: string,
): Promise<BranchSession | null> {
  let raw: string;

  try {
    raw = await readFile(getSessionPath(repoRoot, branch), "utf8");
  } catch {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(raw);

    if (!isBranchSession(parsed) || parsed.branch !== branch) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

/** Upserts the session file and makes sure `.sinscribe/` ignores itself. */
export async function saveSession(
  repoRoot: string,
  session: BranchSession,
): Promise<void> {
  const dir = getSessionsDir(repoRoot);

  await mkdir(dir, { recursive: true });
  await ensureSelfIgnore(path.join(repoRoot, SESSIONS_DIRNAME));

  const payload: BranchSession = {
    ...session,
    updatedAt: new Date().toISOString(),
  };

  await writeFile(
    getSessionPath(repoRoot, session.branch),
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf8",
  );
}

/**
 * Removes a branch's session file. A no-op when the file is missing or was
 * written for a different branch (the same lossy-key safety as loadSession),
 * so a key collision never deletes another branch's session.
 */
export async function deleteSession(
  repoRoot: string,
  branch: string,
): Promise<void> {
  if ((await loadSession(repoRoot, branch)) === null) {
    return;
  }

  await rm(getSessionPath(repoRoot, branch), { force: true });
}

/**
 * Writes `.sinscribe/.gitignore` ignoring `sessions/` unless one already
 * exists. Only sessions are ignored (not `*`): `.sinscribe/` is also home to
 * the project template tier (`.sinscribe/templates/`), which teams commit.
 */
async function ensureSelfIgnore(sinscribeDir: string): Promise<void> {
  const gitignorePath = path.join(sinscribeDir, ".gitignore");

  try {
    await readFile(gitignorePath, "utf8");
  } catch {
    await writeFile(gitignorePath, "sessions/\n", "utf8");
  }
}

function isBranchSession(value: unknown): value is BranchSession {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;

  return (
    record.version === 1 &&
    typeof record.branch === "string" &&
    (record.context === null || isSessionContext(record.context)) &&
    (record.pr === null || isGeneratedPr(record.pr)) &&
    typeof record.createdAt === "string" &&
    typeof record.updatedAt === "string"
  );
}

function isSessionContext(value: unknown): value is SessionContext {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;

  return (
    typeof record.feature === "string" &&
    (record.ticket === null || typeof record.ticket === "string") &&
    (record.requirements === null || typeof record.requirements === "string") &&
    (record.baseRef === undefined ||
      record.baseRef === null ||
      typeof record.baseRef === "string")
  );
}

function isGeneratedPr(value: unknown): value is GeneratedPr {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;

  return (
    typeof record.template === "string" &&
    typeof record.description === "string" &&
    typeof record.baseRef === "string" &&
    typeof record.generatedAt === "string"
  );
}
