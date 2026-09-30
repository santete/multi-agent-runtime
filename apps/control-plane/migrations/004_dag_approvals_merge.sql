-- M4: task dependencies (DAG), human approvals for risky actions, merge queue.

alter table projects add column max_parallel integer;

-- Dependencies are fixed at creation and may only point at existing tasks of
-- the same project, so the graph is acyclic by construction.
alter table tasks add column depends_on uuid[] not null default '{}';
create index tasks_waiting on tasks (project_id) where state = 'CREATED';

create table approvals (
  id           uuid primary key,
  project_id   uuid not null references projects(id),
  task_id      uuid not null references tasks(id),
  execution_id uuid not null references executions(id),
  tool         text not null,
  input        jsonb not null,
  -- approvalKey(): matches the same action on later attempts
  action_key   text not null,
  summary      text not null,
  risk         text not null,
  reason       text not null,
  -- pending | approved | rejected
  status       text not null default 'pending',
  comment      text,
  created_at   timestamptz not null default now(),
  decided_at   timestamptz
);
create index approvals_by_task on approvals (task_id, created_at);
create index approvals_pending on approvals (created_at) where status = 'pending';

create index tasks_merge_queue on tasks (updated_at) where state in ('APPROVED', 'MERGING');
