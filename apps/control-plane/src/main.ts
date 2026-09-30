import { buildApp } from "./app.js";
import { createPgDb, createPgliteDb, migrate } from "./db.js";
import { GitHubProvider } from "./git-provider.js";
import { Store } from "./store.js";

// DATABASE_URL=postgres://... for Postgres; unset = embedded PGlite under ./.data/pglite.
const databaseUrl = process.env.DATABASE_URL;
const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 7700);
const apiToken = process.env.MAR_API_TOKEN || undefined;

if (!apiToken && !["127.0.0.1", "localhost", "::1"].includes(host)) {
  console.error(`Refusing to listen on ${host} without MAR_API_TOKEN.`);
  process.exit(1);
}

const db = databaseUrl ? createPgDb(databaseUrl) : await createPgliteDb(process.env.PGLITE_DIR ?? "./.data/pglite");
const applied = await migrate(db);

// GitHub token for opening pull requests, e.g. GITHUB_TOKEN=$(gh auth token).
const githubToken = process.env.GITHUB_TOKEN || undefined;
const store = new Store(db, {
  leaseSeconds: Number(process.env.MAR_LEASE_SECONDS ?? 60),
  gitProvider: githubToken ? new GitHubProvider(githubToken, process.env.GITHUB_API_URL) : undefined,
});
const app = buildApp(store, { apiToken, logger: { level: process.env.LOG_LEVEL ?? "info" } });
if (applied.length) app.log.info({ applied }, "migrations applied");

// Housekeeping: expire lost runners' leases and requeue/block RETRYING tasks.
const sweepEveryMs = Number(process.env.MAR_SWEEP_INTERVAL_MS ?? 5000);
let sweeping = false;
const sweeper = setInterval(async () => {
  if (sweeping) return;
  sweeping = true;
  try {
    const r = await store.sweep();
    if (r.lost || r.requeued || r.blocked) app.log.info(r, "sweep");
  } catch (err) {
    app.log.error(err, "sweep failed");
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
