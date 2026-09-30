import { fileURLToPath } from "node:url";
import { buildApp } from "./app.js";
import { loadUsers } from "./auth.js";
import { createPgDb, createPgliteDb, migrate } from "./db.js";
import { GitHubProvider } from "./git-provider.js";
import { Store } from "./store.js";

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

// GitHub token for opening and merging pull requests, e.g. GITHUB_TOKEN=$(gh auth token).
const githubToken = process.env.GITHUB_TOKEN || undefined;
const store = new Store(db, {
  leaseSeconds: Number(process.env.MAR_LEASE_SECONDS ?? 60),
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
let sweeping = false;
const sweeper = setInterval(async () => {
  if (sweeping) return;
  sweeping = true;
  try {
    const r = await store.sweep();
    if (r.lost || r.requeued || r.blocked) app.log.info(r, "sweep");
    const m = await store.processMergeQueue();
    if (m.merged || m.conflicts || m.failed) app.log.info(m, "merge queue");
  } catch (err) {
    app.log.error(err, "housekeeping failed");
  } finally {
    sweeping = false;
  }
}, sweepEveryMs);

const shutdown = async () => {
  clearInterval(sweeper);
  await app.close();
  await db.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ host, port });
