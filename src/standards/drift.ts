import { createHash } from "node:crypto";
import {
  STANDARDS,
  trackKey,
  type StandardId,
  type TrackSource,
} from "./registry.js";

/**
 * Upstream drift detection: fetch the current value of every tracked source
 * (latest commit, latest release tag, or a page's content hash) and compare it
 * with the last value recorded in standards.lock.json. A difference does not
 * mean our output is wrong — it means a human has to re-read that source.
 */

/** Last seen value per trackKey(). */
export type StandardsLock = Record<string, string>;

export type Drift = {
  key: string;
  standards: StandardId[];
  previous: string | null;
  current: string;
  /** Where a reviewer reads what changed. */
  link: string;
};

export type FetchFailure = { key: string; error: string };

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

function githubHeaders(token: string | undefined): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    "user-agent": "sinscribe-standards-check",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

async function fetchOk(
  fetcher: Fetcher,
  url: string,
  init?: RequestInit,
): Promise<Response> {
  const response = await fetcher(url, init);

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} for ${url}`);
  }

  return response;
}

/** The value a source has right now. */
export async function readSource(
  source: TrackSource,
  fetcher: Fetcher = fetch,
  token = process.env.GITHUB_TOKEN,
): Promise<string> {
  switch (source.kind) {
    case "github-commit": {
      const query = `per_page=1${source.path ? `&path=${encodeURIComponent(source.path)}` : ""}`;
      const response = await fetchOk(
        fetcher,
        `https://api.github.com/repos/${source.repo}/commits?${query}`,
        { headers: githubHeaders(token) },
      );
      const commits = (await response.json()) as Array<{ sha?: string }>;
      const sha = commits[0]?.sha;

      if (typeof sha !== "string") {
        throw new Error(`no commits returned for ${source.repo}`);
      }

      return sha.slice(0, 12);
    }
    case "github-release": {
      const response = await fetchOk(
        fetcher,
        `https://api.github.com/repos/${source.repo}/releases/latest`,
        { headers: githubHeaders(token) },
      );
      const release = (await response.json()) as { tag_name?: string };

      if (typeof release.tag_name !== "string") {
        throw new Error(`no release tag returned for ${source.repo}`);
      }

      return release.tag_name;
    }
    case "page": {
      const response = await fetchOk(fetcher, source.url, {
        headers: { "user-agent": "sinscribe-standards-check" },
      });
      // Trailing whitespace and line endings vary between deploys of the
      // same content; they are not a change worth a human's time.
      const text = (await response.text())
        .replace(/\r\n/gu, "\n")
        .replace(/[ \t]+$/gmu, "")
        .trim();

      return `sha256:${createHash("sha256").update(text).digest("hex").slice(0, 16)}`;
    }
  }
}

function linkFor(source: TrackSource): string {
  switch (source.kind) {
    case "github-commit":
      return source.path
        ? `https://github.com/${source.repo}/commits/HEAD/${source.path}`
        : `https://github.com/${source.repo}/commits`;
    case "github-release":
      return `https://github.com/${source.repo}/releases`;
    case "page":
      return source.url;
  }
}

/** Every distinct tracked source, with the standards that depend on it. */
export function collectSources(): Array<{
  key: string;
  source: TrackSource;
  standards: StandardId[];
}> {
  const byKey = new Map<
    string,
    { key: string; source: TrackSource; standards: StandardId[] }
  >();

  for (const standard of Object.values(STANDARDS)) {
    for (const source of standard.track) {
      const key = trackKey(source);
      const entry = byKey.get(key) ?? { key, source, standards: [] };

      entry.standards.push(standard.id);
      byKey.set(key, entry);
    }
  }

  return [...byKey.values()];
}

export async function checkDrift(
  lock: StandardsLock,
  fetcher: Fetcher = fetch,
): Promise<{
  drift: Drift[];
  failures: FetchFailure[];
  current: StandardsLock;
}> {
  const drift: Drift[] = [];
  const failures: FetchFailure[] = [];
  const current: StandardsLock = {};

  for (const { key, source, standards } of collectSources()) {
    try {
      const value = await readSource(source, fetcher);

      current[key] = value;

      if (lock[key] !== value) {
        drift.push({
          key,
          standards,
          previous: lock[key] ?? null,
          current: value,
          link: linkFor(source),
        });
      }
    } catch (error) {
      failures.push({
        key,
        error: error instanceof Error ? error.message : String(error),
      });

      // Keep the old value so one flaky fetch never erases history.
      if (lock[key] !== undefined) {
        current[key] = lock[key];
      }
    }
  }

  return { drift, failures, current };
}

/** Markdown report, used both on the terminal and as the issue body. */
export function formatDriftReport(
  drift: Drift[],
  failures: FetchFailure[],
): string {
  if (drift.length === 0 && failures.length === 0) {
    return "All tracked agent standards match standards.lock.json — no changes upstream.";
  }

  const lines: string[] = [];

  if (drift.length > 0) {
    lines.push(
      "## Upstream changes",
      "",
      "| Source | Affects | Was | Now |",
      "| --- | --- | --- | --- |",
      ...drift.map(
        (entry) =>
          `| [${entry.key}](${entry.link}) | ${entry.standards.join(", ")} | ${entry.previous ?? "—"} | ${entry.current} |`,
      ),
      "",
      "For each row: read the source, then either adjust `rules`/prompts and bump",
      "`verifiedOn`/`verifiedAgainst` in `src/standards/registry.ts` (with a changeset),",
      'or note "no impact". In both cases run `pnpm standards:check --update` and commit',
      "the refreshed `standards.lock.json`.",
    );
  }

  if (failures.length > 0) {
    lines.push(
      ...(lines.length > 0 ? [""] : []),
      "## Could not check",
      "",
      ...failures.map((failure) => `- ${failure.key}: ${failure.error}`),
    );
  }

  return lines.join("\n");
}
