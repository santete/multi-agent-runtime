-- M1 walking skeleton schema.

create table projects (
  id             uuid primary key,
  key            text not null unique,
  name           text not null,
  repo_url       text not null,
  default_branch text not null default 'main',
  task_seq       integer not null default 0,
  created_at     timestamptz not null default now()
);

create table tasks (
  id          uuid primary key,
  project_id  uuid not null references projects(id),
  key         text not null unique,
  title       text not null,
  objective   text not null,
  -- logical agent id a runner must offer to claim this task (e.g. "claude-code", "shell")
  agent       text not null,
  state       text not null,
  version     integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index tasks_claimable on tasks (agent, created_at) where state = 'READY';

create table runners (
  id            uuid primary key,
  name          text not null,
  agents        jsonb not null,
  registered_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);

create table executions (
  id          uuid primary key,
  task_id     uuid not null references tasks(id),
  runner_id   uuid not null references runners(id),
  attempt     integer not null,
  -- assigned | running | succeeded | failed | needs_approval
  status      text not null,
  session_id  text,
  workspace   text,
  branch      text,
  exit_code   integer,
  result      jsonb,
  created_at  timestamptz not null default now(),
  started_at  timestamptz,
  finished_at timestamptz,
  unique (task_id, attempt)
);

-- Append-only event store (audit, timeline, replay).
create table events (
  seq          bigserial primary key,
  id           uuid not null unique,
  type         text not null,
  project_id   uuid references projects(id),
  task_id      uuid references tasks(id),
  execution_id uuid references executions(id),
  payload      jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);
create index events_by_task on events (task_id, seq);
create index events_by_execution on events (execution_id, seq);
create index events_by_project on events (project_id, seq);
