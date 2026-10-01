-- Phase 3: human as executor (spec §61): questions agents cannot decide, answered by people.
create table decisions (
  id uuid primary key,
  task_id uuid not null references tasks(id) on delete cascade,
  execution_id uuid not null references executions(id) on delete cascade,
  question text not null,
  options jsonb not null default '[]'::jsonb,
  context text not null default '',
  status text not null default 'pending',
  answer text,
  answered_by text,
  created_at timestamptz not null default now(),
  answered_at timestamptz
);
create index decisions_task on decisions (task_id, status);
