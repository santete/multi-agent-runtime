import { type ReactNode, useState } from "react";
import { proseBlocks } from "../lib/prose.js";
import { stateLabel, type Tone, toneOf } from "../lib/model.js";
import type { TaskState } from "@mar/core";

export function StateBadge({ state }: { state: TaskState }) {
  return <span className={`badge tone-${toneOf(state)}`}>{stateLabel(state)}</span>;
}

export function Pill({ tone = "neutral", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={`badge tone-${tone}`} title={title}>
      {children}
    </span>
  );
}

export function Section({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="section">
      <header className="section-head">
        <h2>{title}</h2>
        {actions}
      </header>
      {children}
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

export function ErrorBox({ error }: { error: Error | undefined }) {
  if (!error) return null;
  return <div className="error">{error.message}</div>;
}

export function Loading() {
  return <p className="empty">Loading…</p>;
}

/** **bold** and `code` inside agent-written text. */
function Inline({ text }: { text: string }) {
  return (
    <>
      {text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) =>
        part.startsWith("**") && part.endsWith("**") && part.length > 4 ? (
          <strong key={i}>{part.slice(2, -2)}</strong>
        ) : part.startsWith("`") && part.endsWith("`") && part.length > 2 ? (
          <code key={i} className="chip">
            {part.slice(1, -1)}
          </code>
        ) : (
          part
        ),
      )}
    </>
  );
}

/** Long agent-written text as short paragraphs and bullets. */
export function Prose({ text, small, collapsible }: { text: string; small?: boolean; collapsible?: boolean }) {
  const blocks = proseBlocks(text);
  const long = collapsible && (text.length > 360 || blocks.length > 4);
  const [open, setOpen] = useState(false);
  return (
    <div>
      <div className={`prose-block${small ? " small" : ""}${long && !open ? " clamped" : ""}`}>
        {blocks.map((b, i) =>
          b.kind === "p" ? (
            <p key={i}>
              <Inline text={b.text} />
            </p>
          ) : (
            <ul key={i}>
              {b.items.map((it, j) => (
                <li key={j}>
                  <Inline text={it} />
                </li>
              ))}
            </ul>
          ),
        )}
      </div>
      {long && (
        <button type="button" className="link small" onClick={() => setOpen(!open)}>
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

/**
 * A trend line without axes: the shape over time, with the last point marked. Gaps (null) break
 * the line. Each point has a tooltip; refLine draws a dashed limit such as a budget.
 */
export function Sparkline({
  values,
  labels,
  format = String,
  refLine,
  height = 36,
}: {
  values: (number | null)[];
  labels?: string[];
  format?: (n: number) => string;
  refLine?: number;
  height?: number;
}) {
  const real = values.filter((v): v is number => v !== null);
  if (real.length < 2) return null;
  const w = 160;
  const pad = 3;
  const max = Math.max(...real, refLine ?? -Infinity);
  const min = Math.min(...real, refLine ?? Infinity);
  const span = max - min || 1;
  const x = (i: number) => pad + (i * (w - 2 * pad)) / (values.length - 1);
  const y = (v: number) => height - pad - ((v - min) / span) * (height - 2 * pad);
  let d = "";
  let prev = false;
  values.forEach((v, i) => {
    if (v === null) {
      prev = false;
      return;
    }
    d += `${prev ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
    prev = true;
  });
  const first = values.findIndex((v) => v !== null);
  const last = values.reduce<number>((a, v, i) => (v === null ? a : i), -1);
  const area = `${d} L${x(last).toFixed(1)} ${height} L${x(first).toFixed(1)} ${height}Z`;
  const slot = (w - 2 * pad) / (values.length - 1);
  return (
    <div className="spark-wrap">
      <svg className="spark" viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" role="img" aria-label="trend">
        {refLine !== undefined && <line className="spark-ref" x1={0} x2={w} y1={y(refLine)} y2={y(refLine)} />}
        <path className="spark-area" d={area} />
        <path className="spark-line" d={d} vectorEffect="non-scaling-stroke" />
        {values.map((v, i) =>
          v === null ? null : (
            <rect key={i} className="spark-hit" x={x(i) - slot / 2} y={0} width={slot} height={height}>
              <title>{`${labels?.[i] ? labels[i] + ": " : ""}${format(v)}`}</title>
            </rect>
          ),
        )}
      </svg>
      <span className="spark-dot" style={{ left: `${(x(last) / w) * 100}%`, top: `${(y(values[last]!) / height) * 100}%` }} />
    </div>
  );
}

export function Json({ value }: { value: unknown }) {
  return <pre className="code">{JSON.stringify(value, null, 2)}</pre>;
}
