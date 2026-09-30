import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../src/worktree.js";

export async function tempDir(prefix: string): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), `mar-${prefix}-`));
  return { path, cleanup: () => rm(path, { recursive: true, force: true, maxRetries: 3 }) };
}

/** Creates a local "origin" repository with one commit on `main`. */
export async function createOriginRepo(dir: string): Promise<string> {
  await git(dir, "init", "-q", "-b", "main");
  await writeFile(join(dir, "README.md"), "# sample\n");
  await git(dir, "add", ".");
  await git(dir, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "init");
  return dir;
}
