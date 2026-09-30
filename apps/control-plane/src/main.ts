import { buildApp } from "./app.js";
import { createPgDb, createPgliteDb, migrate } from "./db.js";
import { Store } from "./store.js";

// DATABASE_URL=postgres://... for Postgres; unset = embedded PGlite under ./.data/pglite.
const databaseUrl = process.env.DATABASE_URL;
const db = databaseUrl ? createPgDb(databaseUrl) : await createPgliteDb(process.env.PGLITE_DIR ?? "./.data/pglite");
const applied = await migrate(db);

const app = buildApp(new Store(db), { logger: { level: process.env.LOG_LEVEL ?? "info" } });
if (applied.length) app.log.info({ applied }, "migrations applied");

// No auth yet (M1): bind to loopback unless explicitly overridden.
const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 7700);

const shutdown = async () => {
  await app.close();
  await db.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ host, port });
