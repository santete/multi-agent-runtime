export type ProseBlock = { kind: "p"; text: string } | { kind: "ul"; items: string[] };

const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+/;
const ENUM = /\s*\(\d+\)\s+/;
const SENTENCE_END = /(?<=[.!?;])\s+(?=[\p{Lu}(\d])/u;
const LONG = 260;

/**
 * Breaks the long run-on text agents write (a plan summary, an objective) into short paragraphs and
 * bullet lists: explicit bullets and "(1) … (2) …" enumerations become items, and a long paragraph
 * of several sentences is cut at its sentence ends.
 */
export function proseBlocks(text: string): ProseBlock[] {
  const blocks: ProseBlock[] = [];
  const pushItem = (item: string) => {
    const last = blocks[blocks.length - 1];
    if (last?.kind === "ul") last.items.push(item);
    else blocks.push({ kind: "ul", items: [item] });
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (BULLET.test(line)) {
      pushItem(line.replace(BULLET, ""));
      continue;
    }
    const parts = line.split(ENUM);
    if (parts.length >= 4) {
      if (parts[0]!.trim()) blocks.push({ kind: "p", text: parts[0]!.trim() });
      for (const item of parts.slice(1)) pushItem(item.trim());
      continue;
    }
    const sentences = line.length > LONG ? line.split(SENTENCE_END) : [line];
    if (sentences.length >= 3) {
      for (const s of sentences) pushItem(s.trim());
    } else {
      blocks.push({ kind: "p", text: line });
    }
  }
  return blocks;
}

/** Wave of each task: 1 when it depends on nothing in the plan, else one more than its latest dependency. */
export function planWaves(tasks: { ref: string; dependsOn: string[] }[]): Map<string, number> {
  const byRef = new Map(tasks.map((t) => [t.ref, t]));
  const waves = new Map<string, number>();
  const visit = (ref: string, seen: Set<string>): number => {
    const known = waves.get(ref);
    if (known) return known;
    const task = byRef.get(ref);
    if (!task || seen.has(ref)) return 0;
    seen.add(ref);
    const wave = 1 + Math.max(0, ...task.dependsOn.map((d) => visit(d, seen)));
    waves.set(ref, wave);
    return wave;
  };
  for (const t of tasks) visit(t.ref, new Set());
  return waves;
}
