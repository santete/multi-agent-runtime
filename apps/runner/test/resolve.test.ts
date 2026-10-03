import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveCommand } from "../src/resolve.js";
import { tempDir } from "./helpers.js";

let bin: Awaited<ReturnType<typeof tempDir>>;

beforeEach(async () => {
  bin = await tempDir("bin");
});
afterEach(() => bin.cleanup());

describe.runIf(process.platform === "win32")("resolveCommand (Windows)", () => {
  const env = () => ({ PATH: bin.path, PATHEXT: ".EXE;.CMD" });

  it("unwraps an npm shim to the real .exe", async () => {
    await writeFile(join(bin.path, "tool.exe"), "");
    await writeFile(join(bin.path, "tool.cmd"), '@ECHO off\r\n"%dp0%\\tool.exe"   %*\r\n');
    expect(resolveCommand("tool", { ...env(), PATHEXT: ".CMD" })).toEqual({
      command: join(bin.path, "tool.exe"),
      prefixArgs: [],
    });
  });

  it("unwraps a shim to a script run with node", async () => {
    await writeFile(join(bin.path, "cli.js"), "");
    await writeFile(join(bin.path, "tool.cmd"), '@ECHO off\r\nnode  "%~dp0\\cli.js" %*\r\n');
    expect(resolveCommand("tool", env())).toEqual({ command: process.execPath, prefixArgs: [join(bin.path, "cli.js")] });
  });

  it("accepts an absolute path to a shim", async () => {
    await writeFile(join(bin.path, "cli.mjs"), "");
    await writeFile(join(bin.path, "tool.cmd"), '"%dp0%\\cli.mjs" %*\r\n');
    expect(resolveCommand(join(bin.path, "tool.cmd"), env()).prefixArgs).toEqual([join(bin.path, "cli.mjs")]);
  });

  it("prefers a real executable and leaves unknown commands alone", async () => {
    await writeFile(join(bin.path, "tool.exe"), "");
    expect(resolveCommand("tool", env()).command).toBe(join(bin.path, "tool.exe"));
    expect(resolveCommand("nope", env())).toEqual({ command: "nope", prefixArgs: [] });
  });

  it("uses Git Bash instead of the WSL launcher in System32", async () => {
    const { mkdir } = await import("node:fs/promises");
    const system32 = join(bin.path, "Windows", "System32");
    const gitBin = join(bin.path, "Programs", "Git", "bin");
    await mkdir(system32, { recursive: true });
    await mkdir(gitBin, { recursive: true });
    await writeFile(join(system32, "bash.exe"), "");
    await writeFile(join(gitBin, "bash.exe"), "");
    const wslOnly = { PATH: system32, PATHEXT: ".EXE" };
    expect(resolveCommand("bash", { ...wslOnly, ProgramFiles: join(bin.path, "Programs") }).command).toBe(join(gitBin, "bash.exe"));
    // Without Git Bash, the launcher is all there is.
    expect(resolveCommand("bash", { ...wslOnly, ProgramFiles: join(bin.path, "none") }).command).toBe(join(system32, "bash.exe"));
  });

  it("explains shims it cannot unwrap", async () => {
    await writeFile(join(bin.path, "tool.cmd"), "@ECHO off\r\ncall something-else %*\r\n");
    expect(() => resolveCommand("tool", env())).toThrow(/set "executable"/);
  });
});
