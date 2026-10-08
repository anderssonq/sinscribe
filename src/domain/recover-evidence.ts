import path from "node:path";
import { tryGit } from "../git/run.js";
import { redactSecrets } from "../util/redact.js";
import { CliError } from "./errors.js";
import { isSecretPath, readCapped } from "./repo-brief.js";

/**
 * What a failed pipeline left on a branch, gathered without a model: the
 * files worth reading first and the diagnosis the developer brings along.
 * The recovery session draft (session-draft.ts) feeds this to the explorer;
 * recover.ts opens the branch it is gathered from.
 */

/** The goal pre-filled for a recovery draft; the author may rewrite it. */
export const RECOVERY_DIRECTION =
  "Recover this branch: an automated pipeline worked on it and could not finish. Find out what it was building, what is already done, why it failed, and what is left to make it pass.";

export type RecoveryInput = {
  /** Absolute path of the diagnosis file, or null when none was given. */
  diagnosisPath: string | null;
};

export type RecoveryDiagnosis = { source: string; text: string };

export type RecoveryEvidence = {
  /** Tracked files on the branch that likely describe the work or the failure. */
  candidates: string[];
  diagnosis: RecoveryDiagnosis | null;
};

const MAX_CANDIDATES = 40;
const MAX_DIAGNOSIS_BYTES = 20_000;
/** Documents and machine-written reports a pipeline tends to leave behind. */
const EVIDENCE_EXTENSION = /\.(md|mdx|markdown|txt|log|json|ya?ml|xml)$/iu;
const EVIDENCE_NAME =
  /(spec|plan|design|requirement|diagnos|fail|error|report|handoff|recover|lock|notes?|todo|summary|result)/iu;

/**
 * The files worth reading first, without opening any of them: everything
 * whose path carries the ticket, then the documents and reports the branch
 * added or changed against its base. Secrets never make the list.
 */
export async function listRecoveryCandidates(
  repoRoot: string,
  options: { ticket: string | null; baseRef: string | null; ref?: string },
): Promise<string[]> {
  const ref = options.ref ?? "HEAD";
  const [tree, changed] = await Promise.all([
    listNul(repoRoot, ["ls-tree", "-r", "--name-only", "-z", ref]),
    options.baseRef === null
      ? Promise.resolve([])
      : listNul(repoRoot, [
          "diff",
          "--name-only",
          "-z",
          `${options.baseRef}...${ref}`,
        ]),
  ]);
  const inTree = new Set(tree);
  const ticket = options.ticket?.toLowerCase() ?? null;
  const byTicket =
    ticket === null
      ? []
      : tree.filter((file) => file.toLowerCase().includes(ticket));
  const changedEvidence = changed.filter(
    (file) =>
      inTree.has(file) &&
      (EVIDENCE_EXTENSION.test(file) ||
        EVIDENCE_NAME.test(path.posix.basename(file))),
  );
  // Prose first: a spec or a report explains more per byte than a manifest.
  const ordered = [...byTicket, ...changedEvidence].sort(
    (a, b) => rank(a) - rank(b),
  );

  return [...new Set(ordered)]
    .filter((file) => !isSecretPath(file))
    .slice(0, MAX_CANDIDATES);
}

function rank(file: string): number {
  return /\.(md|mdx|markdown|txt)$/iu.test(file) ? 0 : 1;
}

/** The diagnosis file, capped and redacted. Missing or empty is an error. */
export async function readDiagnosis(
  diagnosisPath: string,
): Promise<RecoveryDiagnosis> {
  const text = await readCapped(diagnosisPath, MAX_DIAGNOSIS_BYTES);

  if (text === null) {
    throw new CliError(
      `Cannot read the diagnosis file ${diagnosisPath} (missing or empty).`,
    );
  }

  return { source: diagnosisPath, text: redactSecrets(text).text };
}

export async function gatherRecoveryEvidence(
  repoRoot: string,
  options: {
    ticket: string | null;
    baseRef: string | null;
    diagnosisPath: string | null;
  },
): Promise<RecoveryEvidence> {
  const [candidates, diagnosis] = await Promise.all([
    listRecoveryCandidates(repoRoot, options),
    options.diagnosisPath === null
      ? Promise.resolve(null)
      : readDiagnosis(options.diagnosisPath),
  ]);

  return { candidates, diagnosis };
}

async function listNul(cwd: string, args: string[]): Promise<string[]> {
  return ((await tryGit(cwd, ["-c", "core.quotePath=false", ...args])) ?? "")
    .split("\0")
    .filter((file) => file.length > 0);
}
