import { fileURLToPath } from "node:url";
import { resolveLaunchPath } from "@mar/core/launch-path";
import { initTelemetry } from "@mar/telemetry";
import { buildApp } from "./app.js";
import { loadUsers } from "./auth.js";
import { createPgDb, createPgliteDb, migrate } from "./db.js";
import { type GitProvider, GitHubProvider, RoutingGitProvider } from "./git-provider.js";
import { GitLabProvider } from "./gitlab-provider.js";
import { Notifier, notifierOptionsFromEnv } from "./notifier.js";
import { Background } from "./background.js";
import { explainStartupError, StartupError } from "./startup.js";
import { Store } from "./store.js";

// Traces and metrics over OTLP when OTEL_EXPORTER_OTLP_ENDPOINT is set (spec §41).
const telemetry = initTelemetry({ serviceName: "mar-control-plane" });

// DATABASE_URL=postgres://... for Postgres; unset = embedded PGlite under ./.data/pglite.
const databaseUrl = process.env.DATABASE_URL;
const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 7700);
/** Stops with one line saying what went wrong and what to do. */
const fail = (err: unknown): never => {
  console.error(explainStartupError(err, { databaseUrl, host, port }));
  process.exit(1);
};

// Users from MAR_USERS_FILE and/or MAR_API_TOKEN (owner). None = open mode.
const users = (() => {
  try {
    return loadUsers();
  } catch (err) {
    return fail(err);
  }
})();

if (!users.length && !["127.0.0.1", "localhost", "::1"].includes(host)) {
  fail(new StartupError(`Refusing to listen on ${host} without API users (set MAR_USERS_FILE or MAR_API_TOKEN).`));
}

// An explicit PGLITE_DIR is relative to where the command was run; the default stays inside apps/control-plane.
const db = databaseUrl
  ? createPgDb(databaseUrl)
  : await createPgliteDb(process.env.PGLITE_DIR ? resolveLaunchPath(process.env.PGLITE_DIR) : "./.data/pglite").catch(fail);
const applied = await migrate(db).catch(fail);
// Organizations named in the users file exist (spec §49).
await new Store(db).ensureOrgs([...new Set(users.map((u) => u.org ?? "default").filter((o) => o !== "*"))]);

// Hosting providers for pull/merge requests: GITHUB_TOKEN (e.g. $(gh auth token)) and/or GITLAB_TOKEN (+ GITLAB_URL when self-hosted).
const githubToken = process.env.GITHUB_TOKEN || undefined;
const gitlabToken = process.env.GITLAB_TOKEN || undefined;
const providers: GitProvider[] = [
  ...(githubToken ? [new GitHubProvider(githubToken, process.env.GITHUB_API_URL)] : []),
  ...(gitlabToken ? [new GitLabProvider(gitlabToken, process.env.GITLAB_URL)] : []),
];
const store = new Store(db, {
  leaseSeconds: Number(process.env.MAR_LEASE_SECONDS ?? 60),
  // Encrypts stored project secrets (spec §48); without it only runner-env secrets can be defined.
  secretsKey: process.env.MAR_SECRETS_KEY || undefined,
  gitProvider: providers.length > 1 ? new RoutingGitProvider(providers) : providers[0],
});
let background: Background | undefined;
const app = buildApp(store, {
  // Whether this instance runs the background work (ADR-0033), for /health.
  role: () => (background?.isLeader ? "leader" : "standby"),
  users,
  webRoot: process.env.MAR_WEB_ROOT ?? fileURLToPath(new URL("../../web/dist/", import.meta.url)),
  logger: { level: process.env.LOG_LEVEL ?? "info" },
});
if (applied.length) app.log.info({ applied }, "migrations applied");
if (!users.length) app.log.warn("no API users configured: open mode (every caller is the local owner)");

// Slack-compatible notifications: MAR_NOTIFY_WEBHOOKS (comma separated), MAR_NOTIFY_EVENTS, MAR_PUBLIC_URL.
// Organizations can also configure their own webhooks (PUT /orgs/:id/notifications).
const notifyOptions = notifierOptionsFromEnv(process.env, `http://${host}:${port}`);
const notifier = new Notifier(store, { ...notifyOptions, log: app.log });
if (notifyOptions.webhooks.length) app.log.info({ webhooks: notifyOptions.webhooks.length, kinds: notifyOptions.kinds ?? "default" }, "platform notifications on");

// Background work (sweep, merge queue, self-healing, escalation, notifications) runs on one instance at a
// time: the leader (ADR-0033). Every instance serves the API.
background = new Background({
  store,
  notifier,
  leader: db.leaderLock("background"),
  sweepEveryMs: Number(process.env.MAR_SWEEP_INTERVAL_MS ?? 5000),
  notifyEveryMs: Number(process.env.MAR_NOTIFY_INTERVAL_MS ?? 3000),
  // Escalate READY work nobody can take after this long, and work waiting for a person after these hours.
  escalate: { readyMinutes: Number(process.env.MAR_ESCALATE_READY_MINUTES ?? 30), humanHours: Number(process.env.MAR_ESCALATE_HUMAN_HOURS ?? 8) },
  log: app.log,
});
background.start();

const shutdown = async () => {
  await background?.stop();
  await app.close();
  await db.close();
  await telemetry.shutdown();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ host, port }).catch(async (err) => {
  await background?.stop();
  fail(err);
});
