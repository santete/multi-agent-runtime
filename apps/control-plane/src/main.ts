import { fileURLToPath } from "node:url";
import { initTelemetry } from "@mar/telemetry";
import { buildApp } from "./app.js";
import { loadUsers } from "./auth.js";
import { createPgDb, createPgliteDb, migrate } from "./db.js";
import { GitHubProvider } from "./git-provider.js";
import { Notifier, notifierOptionsFromEnv } from "./notifier.js";
import { Store } from "./store.js";

// Traces and metrics over OTLP when OTEL_EXPORTER_OTLP_ENDPOINT is set (spec §41).
const telemetry = initTelemetry({ serviceName: "mar-control-plane" });

// DATABASE_URL=postgres://... for Postgres; unset = embedded PGlite under ./.data/pglite.
const databaseUrl = process.env.DATABASE_URL;
const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 7700);
// Users from MAR_USERS_FILE and/or MAR_API_TOKEN (owner). None = open mode.
const users = loadUsers();

if (!users.length && !["127.0.0.1", "localhost", "::1"].includes(host)) {
  console.error(`Refusing to listen on ${host} without API users (set MAR_USERS_FILE or MAR_API_TOKEN).`);
  process.exit(1);
}

const db = databaseUrl ? createPgDb(databaseUrl) : await createPgliteDb(process.env.PGLITE_DIR ?? "./.data/pglite");
const applied = await migrate(db);
// Organizations named in the users file exist (spec §49).
await new Store(db).ensureOrgs([...new Set(users.map((u) => u.org ?? "default").filter((o) => o !== "*"))]);

// GitHub token for opening and merging pull requests, e.g. GITHUB_TOKEN=$(gh auth token).
const githubToken = process.env.GITHUB_TOKEN || undefined;
const store = new Store(db, {
  leaseSeconds: Number(process.env.MAR_LEASE_SECONDS ?? 60),
  // Encrypts stored project secrets (spec §48); without it only runner-env secrets can be defined.
  secretsKey: process.env.MAR_SECRETS_KEY || undefined,
  gitProvider: githubToken ? new GitHubProvider(githubToken, process.env.GITHUB_API_URL) : undefined,
});
const app = buildApp(store, {
  users,
  webRoot: process.env.MAR_WEB_ROOT ?? fileURLToPath(new URL("../../web/dist/", import.meta.url)),
  logger: { level: process.env.LOG_LEVEL ?? "info" },
});
if (applied.length) app.log.info({ applied }, "migrations applied");
if (!users.length) app.log.warn("no API users configured: open mode (every caller is the local owner)");

// Runners could not heartbeat while we were down: renew their leases before sweeping.
const extended = await store.extendActiveLeases();
if (extended) app.log.info({ executions: extended }, "active leases extended after restart");

// Housekeeping: expire lost runners' leases, requeue/block RETRYING and REWORK tasks, run the merge queue.
const sweepEveryMs = Number(process.env.MAR_SWEEP_INTERVAL_MS ?? 5000);
// Escalate READY work nobody can take after this long, and work waiting for a person after these hours.
const escalateReadyMinutes = Number(process.env.MAR_ESCALATE_READY_MINUTES ?? 30);
const escalateHumanHours = Number(process.env.MAR_ESCALATE_HUMAN_HOURS ?? 8);
let sweeping = false;
const sweeper = setInterval(async () => {
  if (sweeping) return;
  sweeping = true;
  try {
    const r = await store.sweep();
    if (r.lost || r.requeued || r.blocked) app.log.info(r, "sweep");
    const m = await store.processMergeQueue();
    if (m.merged || m.conflicts || m.failed) app.log.info(m, "merge queue");
    // Self-healing (spec §46): the base branch's CI after merges, and work that stopped moving.
    const h = await store.checkMergedCommits();
    if (h.broken) app.log.warn(h, "base branch broken after a merge");
    await store.escalateStuck({ readyMinutes: escalateReadyMinutes, humanHours: escalateHumanHours });
  } catch (err) {
    app.log.error(err, "housekeeping failed");
  } finally {
    sweeping = false;
  }
}, sweepEveryMs);

// Slack-compatible notifications: MAR_NOTIFY_WEBHOOKS (comma separated), MAR_NOTIFY_EVENTS, MAR_PUBLIC_URL.
const notifyOptions = notifierOptionsFromEnv(process.env, `http://${host}:${port}`);
const notifier = notifyOptions ? new Notifier(store, { ...notifyOptions, log: app.log }) : undefined;
let notifying = false;
const notifyTimer = notifier
  ? setInterval(async () => {
      if (notifying) return;
      notifying = true;
      try {
        await notifier.poll();
      } catch (err) {
        app.log.error(err, "notifications failed");
      } finally {
        notifying = false;
      }
    }, Number(process.env.MAR_NOTIFY_INTERVAL_MS ?? 3000))
  : undefined;
if (notifyOptions) app.log.info({ webhooks: notifyOptions.webhooks.length, kinds: notifyOptions.kinds ?? "default" }, "notifications on");

const shutdown = async () => {
  clearInterval(sweeper);
  if (notifyTimer) clearInterval(notifyTimer);
  await app.close();
  await db.close();
  await telemetry.shutdown();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ host, port });
