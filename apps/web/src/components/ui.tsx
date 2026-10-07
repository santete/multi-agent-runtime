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

export function Json({ value }: { value: unknown }) {
  return <pre className="code">{JSON.stringify(value, null, 2)}</pre>;
}
