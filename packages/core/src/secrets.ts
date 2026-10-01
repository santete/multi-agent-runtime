/**
 * Secret management (spec §48): secrets reach the agent and the validation
 * only as environment variables at run time, never through a prompt or a
 * context file, and their values are redacted from everything recorded.
 */

/** Environment variable names. */
export const SECRET_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;

/** Who gets the secret as an environment variable. */
export type SecretScope = "agent" | "validation";

export interface SecretDto {
  name: string;
  /** stored: encrypted by the control plane; runner-env: read from the runner machine's environment. */
  source: "stored" | "runner-env";
  /** For runner-env: the variable read on the runner. */
  ref: string | null;
  exposeTo: SecretScope[];
  updatedBy: string;
  updatedAt: string;
}

export interface PutSecretRequest {
  /** The value, stored encrypted (needs MAR_SECRETS_KEY on the control plane). */
  value?: string | undefined;
  /** Or: the runner machine's environment variable that holds it; the value never leaves the runner. */
  fromRunnerEnv?: string | undefined;
  exposeTo: SecretScope[];
}

/** What a runner receives for an active execution. */
export interface ExecutionSecret {
  name: string;
  exposeTo: SecretScope[];
  value?: string | undefined;
  fromRunnerEnv?: string | undefined;
}

/** Values shorter than this are not redacted (too likely to match ordinary text). */
const MIN_REDACTED_LENGTH = 4;

export type Redactor = (text: string) => string;

/** Replaces every secret value in a text with `[secret NAME]`. */
export function redactor(secrets: Array<{ name: string; value: string }>): Redactor {
  const known = secrets.filter((s) => s.value.length >= MIN_REDACTED_LENGTH).sort((a, b) => b.value.length - a.value.length);
  if (!known.length) return (text) => text;
  return (text) => known.reduce((t, s) => (t.includes(s.value) ? t.split(s.value).join(`[secret ${s.name}]`) : t), text);
}

/** Applies a redactor to every string inside a JSON-like value. */
export function redactDeep<T>(value: T, redact: Redactor): T {
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, redact)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, redact)])) as T;
  }
  return value;
}

/** Whether any secret value appears in the value (e.g. a file the agent is about to write). */
export function containsSecret(value: unknown, secrets: Array<{ value: string }>): boolean {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return secrets.some((s) => s.value.length >= MIN_REDACTED_LENGTH && text.includes(s.value));
}
