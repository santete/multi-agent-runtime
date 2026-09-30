-- M3: per-project validation, structured artifacts, pull request delivery.

alter table projects add column validation jsonb not null default '[]'::jsonb;

alter table tasks add column pull_request_url text;
alter table tasks add column pull_request_number integer;

create table artifacts (
  id           uuid primary key,
  project_id   uuid not null references projects(id),
  task_id      uuid not null references tasks(id),
  execution_id uuid references executions(id),
  -- handoff | validation_result
  type         text not null,
  content      jsonb not null,
  created_at   timestamptz not null default now()
);
create index artifacts_by_task on artifacts (task_id, created_at);

drop index tasks_retrying;
create index tasks_requeue on tasks (updated_at) where state in ('RETRYING', 'REWORK');
