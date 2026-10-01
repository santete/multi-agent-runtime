-- Agent console controls (spec §43): pause / resume and instructions to a task's agent.

-- Why a person stopped a running execution: 'pause' or 'instruction' (cancel stays cancel_requested).
alter table executions add column stop_reason text;

create table instructions (
  id uuid primary key,
  task_id uuid not null references tasks(id) on delete cascade,
  text text not null,
  author text not null,
  -- The execution that received it; null until the agent runs again.
  execution_id uuid references executions(id),
  created_at timestamptz not null default now()
);
create index instructions_task_idx on instructions (task_id, created_at);
