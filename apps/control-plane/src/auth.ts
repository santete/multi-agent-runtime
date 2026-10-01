import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";

/**
 * Who is calling the API (spec §32: approvals are tiered and audited).
 * Human roles are ordered; `runner` is a separate machine identity that may
 * only use the runner protocol.
 */
export const HUMAN_ROLES = ["viewer", "member", "senior", "owner"] as const;
export type HumanRole = (typeof HUMAN_ROLES)[number];
export type Role = HumanRole | "runner";

export interface Actor {
  name: string;
  role: Role;
  /** Organization the caller belongs to (spec §49); "*" = platform admin across organizations. */
  org: string;
}

/** The organization of everything created before organizations existed. */
export const DEFAULT_ORG = "default";
export const ALL_ORGS = "*";

const userSchema = z.object({
  name: z.string().min(1),
  role: z.enum([...HUMAN_ROLES, "runner"]),
  token: z.string().min(16, "tokens must be at least 16 characters"),
  org: z
    .string()
    .regex(/^(\*|[a-z0-9][a-z0-9-]{0,39})$/, "an organization id (lowercase letters, digits, dashes) or *")
    .default(DEFAULT_ORG),
});
export type UserConfig = z.input<typeof userSchema>;

const sha = (s: string) => createHash("sha256").update(s).digest();

export class Authenticator {
  private readonly users: Array<{ name: string; role: Role; org: string; digest: Buffer }>;

  /** No users = open mode: every caller acts as the local owner (only allowed on loopback). */
  constructor(users: UserConfig[]) {
    this.users = users.map((u) => ({ name: u.name, role: u.role, org: u.org ?? DEFAULT_ORG, digest: sha(u.token) }));
  }

  get open(): boolean {
    return this.users.length === 0;
  }

  /** Resolves `Authorization: Bearer <token>`; null when unknown. */
  authenticate(header: string | undefined): Actor | null {
    if (this.open) return { name: "local", role: "owner", org: ALL_ORGS };
    const m = /^Bearer (.+)$/.exec(header ?? "");
    if (!m) return null;
    const digest = sha(m[1]!);
    // Compare digests (fixed length) in constant time against every user.
    let found: Actor | null = null;
    for (const u of this.users) {
      if (timingSafeEqual(u.digest, digest)) found = { name: u.name, role: u.role, org: u.org };
    }
    return found;
  }
}

/** True if `actor` has at least `min` (runners only satisfy "runner"; owners satisfy everything). */
export function hasRole(actor: Pick<Actor, "role">, min: Role): boolean {
  if (actor.role === "owner") return true;
  if (min === "runner" || actor.role === "runner") return actor.role === min;
  return HUMAN_ROLES.indexOf(actor.role) >= HUMAN_ROLES.indexOf(min);
}

/**
 * Users from `MAR_USERS_FILE` (JSON array of {name, role, token}) plus the
 * legacy single `MAR_API_TOKEN`, which acts as an owner named "admin".
 */
export function loadUsers(env: NodeJS.ProcessEnv = process.env): UserConfig[] {
  const users: UserConfig[] = [];
  if (env.MAR_USERS_FILE) users.push(...z.array(userSchema).parse(JSON.parse(readFileSync(env.MAR_USERS_FILE, "utf8"))));
  if (env.MAR_API_TOKEN) users.push(userSchema.parse({ name: "admin", role: "owner", token: env.MAR_API_TOKEN, org: ALL_ORGS }));
  return users;
}
