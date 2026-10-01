/**
 * Path ownership (spec §27): a task declares the parts of the repository it
 * works on as globs ("src/payments/**", "README.md"). Tasks whose areas
 * overlap do not run at the same time, and an agent does not write into an
 * area another unmerged task owns.
 */

/** Repository-relative, forward slashes, no leading "./" or "/". */
export function normalizePath(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/^\.?\//, "").replace(/\/+/g, "/");
}

/** The part of a glob before its first wildcard: "src/payments/**" → "src/payments/". */
function literalPrefix(glob: string): string {
  const i = glob.search(/[*?[{]/);
  return i === -1 ? glob : glob.slice(0, i);
}

/** Whether a repository-relative file matches a glob (* within a segment, ** across segments). */
export function matchesGlob(file: string, glob: string): boolean {
  const f = normalizePath(file);
  const g = normalizePath(glob);
  // A bare directory owns everything under it.
  if (!/[*?]/.test(g) && (f === g || f.startsWith(g.endsWith("/") ? g : `${g}/`))) return true;
  const pattern = g
    .split(/(\*\*\/?|\*|\?)/)
    .map((part) => {
      if (part === "**/" || part === "**") return ".*";
      if (part === "*") return "[^/]*";
      if (part === "?") return "[^/]";
      return part.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    })
    .join("");
  return new RegExp(`^${pattern}$`).test(f);
}

/**
 * Whether two globs can match a common file. Conservative: two areas overlap
 * when one's literal prefix lies inside the other's (so "src/**" overlaps
 * "src/payments/x.js", while "src/a/**" and "src/b/**" do not).
 */
export function globsOverlap(a: string, b: string): boolean {
  const ga = normalizePath(a);
  const gb = normalizePath(b);
  if (ga === gb) return true;
  if (!/[*?]/.test(ga)) return matchesGlob(ga, gb) || matchesGlob(gb, ga);
  if (!/[*?]/.test(gb)) return matchesGlob(gb, ga);
  const pa = literalPrefix(ga);
  const pb = literalPrefix(gb);
  return pa.startsWith(pb) || pb.startsWith(pa);
}

/** The first pair of overlapping globs between two areas, if any. */
export function areasOverlap(a: string[], b: string[]): [string, string] | null {
  for (const x of a) for (const y of b) if (globsOverlap(x, y)) return [x, y];
  return null;
}
