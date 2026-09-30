import type { ReactNode } from "react";
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

export function Json({ value }: { value: unknown }) {
  return <pre className="code">{JSON.stringify(value, null, 2)}</pre>;
}
