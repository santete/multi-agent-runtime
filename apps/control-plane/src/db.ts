import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";

export interface Queryable {
  // Rows are untyped database records unless the caller names a row type.
  query<T = Record<string, any>>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface Db extends Queryable {
  /** Runs `fn` in a transaction; rolls back if it throws. */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function createPgDb(connectionString: string): Db {
  const pool = new pg.Pool({ connectionString });
  return {
    async query(sql, params) {
      return (await pool.query(sql, params as unknown[])).rows;
    },
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const result = await fn({ query: async (sql, params) => (await client.query(sql, params as unknown[])).rows });
        await client.query("commit");
        return result;
      } catch (err) {
        await client.query("rollback");
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

/** In-process Postgres (WASM) for tests and zero-setup local runs. */
export async function createPgliteDb(dataDir?: string): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite(dataDir);
  return {
    async query(sql, params) {
      return (await db.query(sql, params)).rows as never;
    },
    tx(fn) {
      return db.transaction((t) => fn({ query: async (sql, params) => (await t.query(sql, params)).rows as never }));
    },
    close: () => db.close(),
  };
}

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));

/** Applies pending `migrations/NNN_*.sql` files in order. Returns the applied names. */
export async function migrate(db: Db): Promise<string[]> {
  await db.query(
    "create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())",
  );
  const done = new Set((await db.query<{ name: string }>("select name from schema_migrations")).map((r) => r.name));
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = await readFile(MIGRATIONS_DIR + file, "utf8");
    await db.tx(async (q) => {
      for (const statement of splitStatements(sql)) await q.query(statement);
      await q.query("insert into schema_migrations (name) values ($1)", [file]);
    });
    applied.push(file);
  }
  return applied;
}

/** Splits a migration on `;` at line ends. Migrations must not use `;` inside bodies. */
function splitStatements(sql: string): string[] {
  return sql
    .replace(/--.*$/gm, "")
    .split(/;\s*$/m)
    .map((s) => s.trim())
    .filter(Boolean);
}
