import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolveLaunchPath, stripBom } from "@mar/core/launch-path";
import { z } from "zod";
import { StartupError } from "./startup.js";

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
  if (env.MAR_USERS_FILE) users.push(...readUsersFile(resolveLaunchPath(env.MAR_USERS_FILE, { env })));
  if (env.MAR_API_TOKEN) users.push(userSchema.parse({ name: "admin", role: "owner", token: env.MAR_API_TOKEN, org: ALL_ORGS }));
  return users;
}

const USERS_EXAMPLE = '[{ "name": "me", "role": "owner", "token": "<at least 16 characters>" }]';

function readUsersFile(path: string): UserConfig[] {
  if (!existsSync(path)) {
    throw new StartupError(
      `MAR_USERS_FILE: ${path} does not exist. Relative paths start from the directory you ran the command in. ` +
        `The file is a JSON array, e.g. ${USERS_EXAMPLE}`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(stripBom(readFileSync(path, "utf8")));
  } catch (err) {
    throw new StartupError(`MAR_USERS_FILE: ${path} is not valid JSON (${err instanceof Error ? err.message : String(err)}).`);
  }
  const parsed = z.array(userSchema).safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new StartupError(`MAR_USERS_FILE: ${path}: ${issue.path.join(".") || "(root)"}: ${issue.message}. Expected e.g. ${USERS_EXAMPLE}`);
  }
  return parsed.data;
}
