import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

/** Windows PowerShell 5 writes UTF-8 files with a byte order mark, which JSON.parse rejects. */
export const stripBom = (text: string): string => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

/**
 * A path the user typed, resolved from the directory they ran the command in.
 * `pnpm --filter <pkg> start` runs scripts inside the package directory and
 * passes the original directory as INIT_CWD, so `MAR_USERS_FILE=./users.json`
 * means the file next to the user, not inside apps/control-plane.
 *
 * With `fallbackToCwd`, a relative path missing there is looked up in the
 * package directory instead (where older instructions put the file).
 */
export function resolveLaunchPath(path: string, options: { env?: NodeJS.ProcessEnv; fallbackToCwd?: boolean } = {}): string {
  if (isAbsolute(path)) return path;
  const launchDir = options.env?.INIT_CWD ?? process.env.INIT_CWD;
  const fromLaunch = resolve(launchDir ?? process.cwd(), path);
  if (options.fallbackToCwd && !existsSync(fromLaunch)) {
    const fromCwd = resolve(process.cwd(), path);
    if (existsSync(fromCwd)) return fromCwd;
  }
  return fromLaunch;
}
