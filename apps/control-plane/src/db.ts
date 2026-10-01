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
  /** A lock only one control plane instance holds at a time (leader election, ADR-0033). */
  leaderLock(name: string): LeaderLock;
  close(): Promise<void>;
}

/**
 * Leadership among control plane instances sharing a database. `hold()` is
 * called before each round of background work: it takes the lock when free,
 * and checks that a held lock is still held (its connection is alive).
 */
export interface LeaderLock {
  hold(): Promise<boolean>;
  release(): Promise<void>;
}

/** A stable signed 64-bit advisory lock key for a name (FNV-1a). */
export function advisoryKey(name: string): string {
  let h = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(`mar:${name}`, "utf8")) h = BigInt.asUintN(64, (h ^ BigInt(byte)) * 0x100000001b3n);
  return BigInt.asIntN(64, h).toString();
}

/**
 * Postgres: a session advisory lock on a dedicated connection (not one of the
 * pool's). If that connection dies, Postgres releases the lock and another
 * instance takes over; this one notices on its next `hold()`.
 */
class PgLeaderLock implements LeaderLock {
  private client: pg.Client | undefined;
  private held = false;

  constructor(
    private readonly connectionString: string,
    private readonly key: string,
  ) {}

  async hold(): Promise<boolean> {
    try {
      if (!this.client) {
        const client = new pg.Client({ connectionString: this.connectionString });
        // A dropped connection loses the lock: forget it and start over next time.
        client.on("error", () => this.drop(client));
        await client.connect();
        this.client = client;
      }
      if (this.held) {
        await this.client.query("select 1");
        return true;
      }
      const [row] = (await this.client.query("select pg_try_advisory_lock($1::bigint) as locked", [this.key])).rows;
      this.held = Boolean(row?.locked);
      return this.held;
    } catch {
      if (this.client) this.drop(this.client);
      return false;
    }
  }

  async release(): Promise<void> {
    const client = this.client;
    if (!client) return;
    this.drop(client);
    // Closing the session releases the lock.
    await client.end().catch(() => undefined);
  }

  private drop(client: pg.Client): void {
    if (this.client !== client) return;
    this.client = undefined;
    this.held = false;
    void client.end().catch(() => undefined);
  }
}

export function createPgDb(connectionString: string): Db {
  const pool = new pg.Pool({ connectionString });
  return {
    leaderLock: (name) => new PgLeaderLock(connectionString, advisoryKey(name)),
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
    // In-process: only this process can use the database, so it always leads.
    leaderLock: () => ({ hold: async () => true, release: async () => undefined }),
    close: () => db.close(),
  };
}

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));

/** Applies pending `migrations/NNN_*.sql` files in order. Returns the applied names. */
export async function migrate(db: Db): Promise<string[]> {
  // Several instances may start at once (ADR-0033): each step runs under a transaction-scoped lock and
  // re-checks what is already applied, so a migration is applied exactly once.
  const lock = (q: Queryable) => q.query("select pg_advisory_xact_lock($1::bigint)", [advisoryKey("migrations")]);
  await db.tx(async (q) => {
    await lock(q);
    await q.query("create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())");
  });
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];
  for (const file of files) {
    const sql = await readFile(MIGRATIONS_DIR + file, "utf8");
    const done = await db.tx(async (q) => {
      await lock(q);
      if ((await q.query("select 1 from schema_migrations where name = $1", [file])).length) return false;
      for (const statement of splitStatements(sql)) await q.query(statement);
      await q.query("insert into schema_migrations (name) values ($1)", [file]);
      return true;
    });
    if (done) applied.push(file);
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
