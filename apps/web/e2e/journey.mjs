#!/usr/bin/env node
// The user journey, end to end, through the dashboard only (pnpm --filter @mar/web journey).
//
// A real control plane and runner on a throwaway database, a local Git repository as the
// origin, and a scripted agent (fake-agent.mjs) that goes through the real policy hook.
// No Git provider is configured, so approved work is merged by "a person" (this script).
// Every step checks that the page shows the next thing to do: a person must never be left
// without a way forward.
//
// Needs the dashboard built (pnpm --filter @mar/web build), git, and Edge or Chrome
// (MAR_E2E_BROWSER=<path> to choose; HEADED=1 to watch).
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const windows = process.platform === "win32";
const dir = mkdtempSync(join(tmpdir(), "mar-journey-"));
const port = 7900 + Math.floor(Math.random() * 90);
const base = `http://127.0.0.1:${port}`;
const shots = join(dir, "screenshots");
mkdirSync(shots);
const children = [];

// ---- helpers ------------------------------------------------------------------------------

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function browserPath() {
  const candidates = [
    process.env.MAR_E2E_BROWSER,
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/microsoft-edge",
  ].filter(Boolean);
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error("no Edge or Chrome found: set MAR_E2E_BROWSER");
  return found;
}

/** Starts an app with tsx; its output goes to a log file next to the screenshots. */
function startApp(app, args, env) {
  const tsx = createRequire(join(root, "apps", app, "package.json")).resolve("tsx/cli");
  const env2 = { ...process.env, ...env };
  // A token in the person's shell would open real pull requests: this journey has no Git provider.
  for (const name of ["GITHUB_TOKEN", "GITLAB_TOKEN", "MAR_USERS_FILE", "MAR_API_TOKEN", "DATABASE_URL", "MAR_NOTIFY_WEBHOOKS"]) delete env2[name];
  const log = join(dir, `${app}.log`);
  writeFileSync(log, "");
  const child = spawn(process.execPath, [tsx, "src/main.ts", ...args], { cwd: join(root, "apps", app), env: env2, stdio: ["ignore", "pipe", "pipe"] });
  const append = (d) => writeFileSync(log, d, { flag: "a" });
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  children.push(child);
  return child;
}

function stopAll() {
  for (const child of children) {
    if (child.exitCode !== null) continue;
    if (windows) {
      try {
        execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      } catch {
        // already gone
      }
    } else {
      child.kill("SIGTERM");
    }
  }
}

async function waitFor(check, what, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await check()) return;
    } catch {
      // not yet
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

const api = async (path) => (await fetch(`${base}${path}`)).json();

let page;
let stepNo = 0;
async function step(name, fn) {
  stepNo++;
  const label = `${String(stepNo).padStart(2, "0")} ${name}`;
  const started = Date.now();
  try {
    await fn();
    await page.screenshot({ path: join(shots, `${label.replace(/[^\w-]+/g, "-")}.png`), fullPage: true });
    console.log(`ok   ${label} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  } catch (err) {
    await page.screenshot({ path: join(shots, `FAILED-${label.replace(/[^\w-]+/g, "-")}.png`), fullPage: true }).catch(() => undefined);
    console.log(`FAIL ${label}: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
}

/** The page shows this text (a visible next step), within the timeout. */
const sees = (text, timeout = 30_000) => page.getByText(text).first().waitFor({ state: "visible", timeout });
const click = (name) => page.getByRole("button", { name, exact: true }).first().click();
const go = async (hash) => {
  await page.goto(`${base}/ui/${hash}`);
};

// ---- the world: an origin repository, an agent, a runner config ---------------------------------

const origin = join(dir, "origin.git");
git(dir, "init", "--bare", "-q", "-b", "main", origin);
const seed = join(dir, "seed");
mkdirSync(seed);
git(seed, "init", "-q", "-b", "main");
writeFileSync(join(seed, "README.md"), "# Journey\n");
git(seed, "add", ".");
git(seed, "-c", "user.name=journey", "-c", "user.email=journey@example.com", "commit", "-q", "-m", "init");
git(seed, "remote", "add", "origin", origin);
git(seed, "push", "-q", "origin", "main");
const repoUrl = pathToFileURL(origin).href;

/** What a person does when there is no pull request: merge the branch into main and push. */
function mergeByHand(branch) {
  git(seed, "fetch", "-q", "origin");
  git(seed, "checkout", "-q", "main");
  git(seed, "pull", "-q", "origin", "main");
  git(seed, "-c", "user.name=person", "-c", "user.email=person@example.com", "merge", "-q", "--no-ff", "-m", `Merge ${branch}`, `origin/${branch}`);
  git(seed, "push", "-q", "origin", "main");
  return git(seed, "rev-parse", "HEAD");
}
const onMain = (file) => {
  git(seed, "fetch", "-q", "origin");
  return git(seed, "ls-tree", "--name-only", "origin/main").split("\n").includes(file);
};

const bin = join(dir, "bin");
mkdirSync(bin);
copyFileSync(fileURLToPath(new URL("./fake-agent.mjs", import.meta.url)), join(bin, "fake-agent.mjs"));
let executable = join(bin, "fake-agent.mjs");
if (windows) {
  // Like an npm shim: the runner unwraps it to `node fake-agent.mjs`.
  executable = join(bin, "fake-agent.cmd");
  writeFileSync(executable, '@ECHO off\r\n"%dp0%\\fake-agent.mjs" %*\r\n');
} else {
  chmodSync(executable, 0o755);
}
const runnerConfig = join(dir, "runner.config.json");
writeFileSync(
  runnerConfig,
  JSON.stringify({
    controlPlaneUrl: base,
    name: "journey-runner",
    home: join(dir, "runner-home"),
    pollIntervalMs: 500,
    heartbeatIntervalMs: 2000,
    maxConcurrent: 1,
    timeoutSeconds: 120,
    agents: { "claude-code": { adapter: "claude-code", executable, skills: ["typescript"], cost: "high" } },
  }),
);

// ---- the journey ---------------------------------------------------------------------------------

let browser;
let failed = false;
try {
  startApp("control-plane", [], { PORT: String(port), PGLITE_DIR: join(dir, "pglite"), MAR_SWEEP_INTERVAL_MS: "1000" });
  await waitFor(async () => (await fetch(`${base}/health`)).ok, "the control plane", 90_000);

  browser = await chromium.launch({ executablePath: browserPath(), headless: !process.env.HEADED });
  page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  await step("a new installation says no runner is online and how to start one", async () => {
    await go("#/");
    await sees("No runner is online");
    await sees("runner.config.example.json");
  });

  await step("starting a runner clears that", async () => {
    startApp("runner", [runnerConfig], {});
    await page.getByText("No runner is online").waitFor({ state: "detached", timeout: 60_000 });
    await sees("runners online");
  });

  await step("create a project from the dashboard", async () => {
    await click("New project");
    await page.getByLabel("Name").fill("Journey");
    await page.getByLabel(/^Key/).fill("JRN");
    await page.getByLabel(/^Repository/).fill(repoUrl);
    await page.getByLabel(/^Validation/).fill(`test: node -e "process.exit(require('fs').readdirSync('.').some(f=>f.endsWith('.txt'))?0:1)"`);
    await click("Create project");
    await sees("New task");
    // No Git provider: the page says how approved work will be merged.
    await sees("Approved work is not merged automatically here");
  });

  await step("settings: the validation is there; allow only the trusted agent", async () => {
    await page.getByRole("link", { name: "Settings" }).click();
    await page.getByLabel("Command").first().waitFor();
    if (!(await page.getByLabel("Command").first().inputValue()).includes("readdirSync")) throw new Error("validation step missing");
    const agents = page.locator("form", { hasText: "Routing policy" });
    await agents.getByLabel("claude-code").check();
    await agents.getByRole("button", { name: "Save" }).click();
    await agents.getByText("Saved").waitFor();
  });

  await step("give a task with acceptance criteria", async () => {
    await page.getByRole("link", { name: "Board" }).click();
    await click("New task");
    await page.getByLabel("Title").fill("Journey file");
    await page.getByLabel("Objective").fill("write journey.txt");
    await page.getByLabel("Agent").selectOption("claude-code");
    await page.getByLabel(/Acceptance criteria/).fill("journey.txt exists");
    await click("Create task");
    await sees("Journey file");
  });

  await step("the agent works, validation passes, the task waits for review with its next step", async () => {
    await sees("Approve & merge", 120_000);
    await sees("journey.txt exists");
  });

  await step("the Inbox lists the work to review and leads to it", async () => {
    await go("#/approvals");
    await sees("Work to review (1)");
    await page.getByRole("link", { name: "Review", exact: true }).click();
    await click("Approve & merge");
  });

  await step("with no pull request, the Inbox asks a person to merge the branch", async () => {
    await go("#/approvals");
    await sees("merge by hand", 60_000);
    await sees("task/JRN-1");
    // The task's own page says the same, and offers no retry (that would redo the approved work).
    await page.getByRole("link", { name: "JRN-1" }).first().click();
    await sees("I merged it");
    if (await page.getByRole("button", { name: "Retry", exact: true }).count()) throw new Error("the task page offers a retry");
    await go("#/approvals");
    await sees("merge by hand");
  });

  await step("a person merges it and confirms; the task is completed", async () => {
    const sha = mergeByHand("task/JRN-1");
    await page.getByPlaceholder("merge commit (optional)").fill(sha);
    await click("I merged it");
    await page.getByText("merge by hand").waitFor({ state: "detached" });
    if (!onMain("journey.txt")) throw new Error("journey.txt is not on main");
    const [task] = (await api(`/projects/${(await api("/projects"))[0].id}/tasks`)).filter((t) => t.key === "JRN-1");
    if (task.state !== "COMPLETED") throw new Error(`JRN-1 is ${task.state}`);
  });

  await step("a refused call stops the task, and the Inbox says why and offers a way out", async () => {
    const project = (await api("/projects"))[0];
    await go(`#/projects/${project.id}`);
    await click("New task");
    await page.getByLabel("Title").fill("Push it");
    await page.getByLabel("Objective").fill("run: git push origin main");
    await page.getByLabel("Agent").selectOption("claude-code");
    await click("Create task");
    // The dialog opens the new task's page.
    await sees("run: git push origin main");
    await go("#/approvals");
    await sees("Stopped: needs you to act", 90_000);
    await sees("git push origin main");
    await click("Cancel task");
    await page.getByText("Stopped: needs you to act").waitFor({ state: "detached" });
  });

  await step("plan a goal; the Inbox lists the plan to approve", async () => {
    const project = (await api("/projects"))[0];
    await go(`#/projects/${project.id}`);
    await click("New plan");
    await page.getByLabel("Goal").fill("Write two files, one after the other.");
    await page.getByLabel("Planner agent").selectOption("claude-code");
    await click("Plan it");
    await page.waitForURL(/#\/plans\//);
    await go("#/approvals");
    await sees("Plans to approve (1)", 90_000);
    await page.getByRole("link", { name: "Review the plan" }).click();
    await sees("Write plan-a.txt");
    await click("Approve and create tasks");
    // The plan page says what happens next.
    await sees("Approved: 2 tasks were created");
  });

  for (const [n, file] of [
    [4, "plan-a.txt"],
    [5, "plan-b.txt"],
  ]) {
    await step(`plan task JRN-${n}: review, merge by hand, then the next one starts`, async () => {
      await go("#/approvals");
      await sees("Work to review (1)", 120_000);
      await sees(`JRN-${n}`);
      await page.getByRole("link", { name: "Review", exact: true }).click();
      await click("Approve & merge");
      await go("#/approvals");
      await sees("merge by hand", 60_000);
      const sha = mergeByHand(`task/JRN-${n}`);
      await page.getByPlaceholder("merge commit (optional)").fill(sha);
      await click("I merged it");
      await page.getByText("merge by hand").waitFor({ state: "detached" });
      if (!onMain(file)) throw new Error(`${file} is not on main`);
    });
  }

  await step("nothing is left waiting; the overview says so", async () => {
    await go("#/approvals");
    await sees("Nothing waits for you");
    await go("#/");
    await waitFor(async () => (await page.locator(".stat", { hasText: "waiting for you" }).locator(".stat-value").innerText()) === "0", "an empty inbox");
    if (pageErrors.length) throw new Error(`page errors: ${pageErrors.join(" | ")}`);
  });

  console.log(`\nThe journey passed. Screenshots: ${shots}`);
} catch (err) {
  failed = true;
  console.log(`\nThe journey failed. Screenshots and logs: ${dir}`);
  console.log(err instanceof Error ? err.stack : String(err));
} finally {
  await browser?.close().catch(() => undefined);
  stopAll();
  if (!failed && !process.env.KEEP) {
    await new Promise((r) => setTimeout(r, 1000));
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
  process.exit(failed ? 1 : 0);
}
