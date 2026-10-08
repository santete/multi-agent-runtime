import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureDependencies, installPlan } from "../src/deps.js";
import { withFailureText } from "../src/process.js";
import { unreadableStructuredResult } from "../src/repair.js";

let dir: string;
let home: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mar-deps-"));
  home = mkdtempSync(join(tmpdir(), "mar-home-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("installPlan", () => {
  it("picks the install for the lockfile, and nothing without a package.json", () => {
    expect(installPlan(dir)).toBeNull();
    writeFileSync(join(dir, "package.json"), "{}");
    expect(installPlan(dir)).toBeNull();
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: 9");
    expect(installPlan(dir)).toMatchObject({ command: "pnpm install --frozen-lockfile", lockfile: "pnpm-lock.yaml" });
  });

  it("uses the runner's own command when one is configured", () => {
    writeFileSync(join(dir, "package.json"), "{}");
    expect(installPlan(dir, "make deps")).toMatchObject({ command: "make deps" });
  });
});

describe("ensureDependencies", () => {
  it("installs once per lockfile and again when the lockfile changes", async () => {
    writeFileSync(join(dir, "package.json"), "{}");
    writeFileSync(join(dir, "package-lock.json"), "v1");
    // "Installing" creates node_modules/dep, like a real install would.
    writeFileSync(join(dir, "install.cjs"), "require('fs').mkdirSync('node_modules/dep', { recursive: true });");
    const options = { home, command: "node install.cjs" };

    const first = await ensureDependencies(dir, options);
    expect(first).toMatchObject({ skipped: false, step: { passed: true } });
    expect(await ensureDependencies(dir, options)).toMatchObject({ skipped: true });

    writeFileSync(join(dir, "package-lock.json"), "v2");
    expect(await ensureDependencies(dir, options)).toMatchObject({ skipped: false });
  });

  it("reports a failing install without leaving a marker", async () => {
    writeFileSync(join(dir, "package.json"), "{}");
    mkdirSync(join(dir, "node_modules"));
    const result = await ensureDependencies(dir, { home, command: "node -e process.exit(3)" });
    expect(result?.step).toMatchObject({ passed: false, exitCode: 3 });
    expect(await ensureDependencies(dir, { home, command: "node -e process.exit(3)" })).toMatchObject({ skipped: false });
  });
});

describe("withFailureText", () => {
  const completed = (extra: object) => ({ kind: "completed", sessionId: "s", success: false, deniedActions: [] as string[], result: undefined as unknown, ...extra }) as never as Parameters<typeof withFailureText>[0];

  it("gives a bare unsuccessful run the agent's last message as its result", () => {
    const e = withFailureText(completed({}), "You've reached your credit usage limit.");
    expect(e).toMatchObject({ result: "You've reached your credit usage limit." });
  });

  it("leaves successful runs, existing results and failures alone", () => {
    const ok = completed({ success: true });
    expect(withFailureText(ok, "hello")).toBe(ok);
    const withResult = completed({ result: { summary: "x" } });
    expect(withFailureText(withResult, "hello")).toBe(withResult);
    const failed = { kind: "failed", reason: "boom" } as const;
    expect(withFailureText(failed, "hello")).toBe(failed);
  });
});

describe("unreadableStructuredResult", () => {
  it("does not ask an unsuccessful run to reformat its answer", () => {
    const adapter = { capabilities: { promptedSchema: true, resume: true } } as never;
    const request = { outputSchema: { required: ["summary"] } } as never;
    const outcome = (success: boolean) => ({ exitCode: 0, terminal: { kind: "completed", sessionId: "s", success, deniedActions: [], result: "limit reached" } }) as never;
    expect(unreadableStructuredResult(request, outcome(true), adapter)).toBeDefined();
    expect(unreadableStructuredResult(request, outcome(false), adapter)).toBeUndefined();
  });
});
