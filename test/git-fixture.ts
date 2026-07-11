import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

export async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/** Runs git with identity/signing pinned so global config can't break tests. */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Test",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd },
  );

  return stdout.trim();
}

/** Initializes a repo with one commit on the given branch. */
export async function initRepo(cwd: string, branch = "main"): Promise<void> {
  await git(cwd, "init", "-b", branch);
  await writeFile(path.join(cwd, "file.txt"), "hello\n");
  await git(cwd, "add", ".");
  await git(cwd, "commit", "-m", "init");
}
