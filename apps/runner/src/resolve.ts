import { existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";

export interface ResolvedCommand {
  command: string;
  /** Arguments to put before the adapter's own arguments. */
  prefixArgs: string[];
}

/**
 * Resolves a command for `spawn` without a shell. On Windows, npm installs CLIs
 * as `.cmd` shims (e.g. `claude.cmd` -> `claude.exe`), which cannot be spawned
 * directly; passing the adapter's JSON arguments through `cmd.exe` would be
 * fragile, so the shim is unwrapped to the real target instead.
 */
export function resolveCommand(command: string, env: NodeJS.ProcessEnv = process.env): ResolvedCommand {
  if (process.platform !== "win32") return { command, prefixArgs: [] };

  const found = findOnPath(command, env);
  if (!found) return { command, prefixArgs: [] };
  if (isWslLauncher(found)) {
    const gitBash = findGitBash(env);
    if (gitBash) return { command: gitBash, prefixArgs: [] };
  }
  if (/\.(cmd|bat)$/i.test(found)) {
    const target = unwrapNpmShim(found);
    if (target) return target;
    throw new Error(
      `${command} resolves to ${found}, a batch shim that cannot be run without a shell; ` +
        `set "executable" in the runner config to the real .exe or .js`,
    );
  }
  return { command: found, prefixArgs: [] };
}

/**
 * `bash` in a PowerShell or cmd PATH is usually the WSL launcher in System32
 * (or its WindowsApps alias), not Git Bash: it runs the command in a Linux
 * distribution, or prints a UTF-16 error when WSL is not set up.
 */
function isWslLauncher(path: string): boolean {
  return /[\\/](bash|wsl)\.exe$/i.test(path) && /[\\/](system32|WindowsApps)[\\/]/i.test(path);
}

/** Git for Windows' bash, which agents and runner configs mean by `bash` on Windows. */
function findGitBash(env: NodeJS.ProcessEnv): string | undefined {
  const roots = [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Programs")];
  return roots.filter((r): r is string => Boolean(r)).map((r) => join(r, "Git", "bin", "bash.exe")).find(existsSync);
}

function findOnPath(command: string, env: NodeJS.ProcessEnv): string | undefined {
  const exts = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const hasExt = /\.[a-z0-9]+$/i.test(command);
  const withExts = (base: string) => (hasExt ? [base] : exts.map((e) => base + e.toLowerCase()));

  if (isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    return withExts(resolve(command)).find(existsSync);
  }
  const pathVar = env.PATH ?? env.Path ?? "";
  for (const dir of pathVar.split(delimiter).filter(Boolean)) {
    const hit = withExts(join(dir, command)).find(existsSync);
    if (hit) return hit;
  }
  return undefined;
}

/** npm shims end with a line like `"%dp0%\node_modules\pkg\bin\tool.exe"   %*` (or `node  "%dp0%\...\cli.js" %*`). */
function unwrapNpmShim(shimPath: string): ResolvedCommand | undefined {
  const dir = dirname(shimPath);
  const text = readFileSync(shimPath, "utf8");
  // Both `"%dp0%\x"` (npm's own variable) and `"%~dp0\x"` appear in the wild.
  const targets = [...text.matchAll(/"%(?:~dp0|dp0%)\\?([^"]+)"/gi)].map((m) => join(dir, m[1]!));
  const target = targets.find((t) => existsSync(t) && /\.(exe|js|cjs|mjs)$/i.test(t));
  if (!target) return undefined;
  if (/\.exe$/i.test(target)) return { command: target, prefixArgs: [] };
  return { command: process.execPath, prefixArgs: [target] };
}
