import type { TaskDto } from "@mar/core";
import { layoutGraph, stateLabel, toneOf } from "../lib/model.js";
import { href } from "../lib/router.js";

const W = 200;
const H = 64;
const GAP_X = 70;
const GAP_Y = 22;
const PAD = 16;

/** The task DAG (spec §13), laid out left to right by dependency depth. */
export function Graph({ tasks }: { tasks: TaskDto[] }) {
  const nodes = layoutGraph(tasks);
  const pos = new Map(nodes.map((n) => [n.task.id, { x: PAD + n.layer * (W + GAP_X), y: PAD + n.row * (H + GAP_Y) }]));
  const width = PAD * 2 + (Math.max(...nodes.map((n) => n.layer)) + 1) * (W + GAP_X) - GAP_X;
  const height = PAD * 2 + (Math.max(...nodes.map((n) => n.row)) + 1) * (H + GAP_Y) - GAP_Y;

  return (
    <div className="graph-wrap">
      <svg className="graph" width={width} height={height} role="img" aria-label="Task dependency graph">
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M0,0 L10,5 L0,10 z" className="edge-head" />
          </marker>
        </defs>
        {nodes.flatMap(({ task }) =>
          task.dependsOn
            .filter((d) => pos.has(d))
            .map((d) => {
              const a = pos.get(d)!;
              const b = pos.get(task.id)!;
              const x1 = a.x + W;
              const y1 = a.y + H / 2;
              const x2 = b.x - 2;
              const y2 = b.y + H / 2;
              const mid = (x1 + x2) / 2;
              return (
                <path
                  key={`${d}-${task.id}`}
                  className="edge"
                  d={`M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`}
                  markerEnd="url(#arrow)"
                />
              );
            }),
        )}
        {nodes.map(({ task }) => {
          const p = pos.get(task.id)!;
          return (
            <a key={task.id} href={href.task(task.id)}>
              <g transform={`translate(${p.x},${p.y})`} className={`node tone-${toneOf(task.state)}`}>
                <rect width={W} height={H} rx="8" />
                <text x="12" y="22" className="node-key">
                  {task.key} · {stateLabel(task.state)}
                </text>
                <text x="12" y="44" className="node-title">
                  {task.title.length > 26 ? `${task.title.slice(0, 25)}…` : task.title}
                </text>
              </g>
            </a>
          );
        })}
      </svg>
    </div>
  );
}
