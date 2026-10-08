-- What a runner found when it tried each of its agents on a small task (preflight):
-- ready, cannot run shell commands (e.g. Antigravity headless), or unavailable
-- (no credit, not logged in). Tasks are not handed to agents that cannot do them.
create table agent_health (
  runner_id uuid not null references runners(id) on delete cascade,
  agent text not null,
  status text not null,
  reason text not null default '',
  checked_at timestamptz not null default now(),
  primary key (runner_id, agent)
);
