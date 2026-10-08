/**
 * `pnpm standards:check [--update]` — maintainer tool, not part of the CLI.
 *
 * Exit codes: 0 no drift, 1 drift found (the scheduled workflow opens an
 * issue), 2 nothing changed but some sources could not be fetched.
 * `--update` rewrites standards.lock.json with the current values and exits 0.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { checkDrift, formatDriftReport, type StandardsLock } from "./drift.js";

const LOCK_PATH = path.resolve(process.cwd(), "standards.lock.json");

async function readLock(): Promise<StandardsLock> {
  try {
    return JSON.parse(await readFile(LOCK_PATH, "utf8")) as StandardsLock;
  } catch {
    return {};
  }
}

const update = process.argv.includes("--update");
const lock = await readLock();
const { drift, failures, current } = await checkDrift(lock);

if (update) {
  const sorted = Object.fromEntries(
    Object.entries(current).sort(([a], [b]) => a.localeCompare(b)),
  );

  await writeFile(LOCK_PATH, `${JSON.stringify(sorted, null, 2)}\n`);
  console.log(
    `standards.lock.json updated (${Object.keys(sorted).length} sources).`,
  );

  if (failures.length > 0) {
    console.log(formatDriftReport([], failures));
  }

  process.exit(0);
}

console.log(formatDriftReport(drift, failures));
process.exit(drift.length > 0 ? 1 : failures.length > 0 ? 2 : 0);
