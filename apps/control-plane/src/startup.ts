/** Startup failures explained in one line, with what to do about them (no stack trace). */

export class StartupError extends Error {}

const codes = (err: unknown): string[] => {
  const e = err as { code?: string; errors?: unknown[] };
  return [e?.code, ...(Array.isArray(e?.errors) ? e.errors.map((x) => (x as { code?: string })?.code) : [])].filter(
    (c): c is string => typeof c === "string",
  );
};

const where = (databaseUrl: string): string => {
  try {
    const u = new URL(databaseUrl);
    return `${u.hostname}:${u.port || 5432}${u.pathname}`;
  } catch {
    return "DATABASE_URL";
  }
};

export function explainStartupError(err: unknown, context: { databaseUrl?: string | undefined; host: string; port: number }): string {
  if (err instanceof StartupError) return err.message;
  const c = codes(err);
  const message = err instanceof Error ? err.message : String(err);
  if (context.databaseUrl) {
    const db = where(context.databaseUrl);
    if (c.includes("ECONNREFUSED") || c.includes("ENOTFOUND") || c.includes("ETIMEDOUT")) {
      return (
        `Cannot connect to Postgres at ${db} (${c[0]}). Is it running? Start the bundled one with ` +
        "`docker compose up -d` in the repository, or unset DATABASE_URL to use embedded PGlite."
      );
    }
    if (c.includes("28P01")) return `Postgres at ${db} rejected the user or password in DATABASE_URL.`;
    if (c.includes("3D000")) return `Database missing at ${db}: ${message}. Create it, or check DATABASE_URL.`;
  }
  if (c.includes("EADDRINUSE")) {
    return `Port ${context.port} on ${context.host} is already in use (another control plane?). Stop it or set PORT.`;
  }
  return `Control plane failed to start: ${message}`;
}
