/**
 * Postgres text and jsonb cannot hold the NUL character, and one in an agent's
 * output (a UTF-16 error message, a binary file in a diff) would make every
 * write of that execution fail. NULs are dropped from query parameters: as raw
 * characters in text, and as the JSON escape inside serialized JSON (only an
 * unescaped one; an escaped backslash followed by "u0000" is ordinary text).
 */
const NUL = String.fromCharCode(0);
const JSON_NUL = /(?<![\\])((?:[\\][\\])*)[\\]u0000/g;

export function storable(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const text = value.includes(NUL) ? value.split(NUL).join("") : value;
  return text.includes("u0000") ? text.replace(JSON_NUL, "$1") : text;
}

export const storableParams = (params: unknown[] | undefined): unknown[] | undefined => params?.map(storable);
