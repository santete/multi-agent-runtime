-- Phase 2: assisted planning (a planner agent proposes a task DAG, a human approves it).

create table plans (
  id uuid primary key,
  project_id uuid not null references projects(id),
  goal text not null,
  -- planning | proposed | approved | rejected | revised (failed is derived from the planner task)
  status text not null default 'planning',
  proposal jsonb,
  -- [{ref, taskId, key}] once approved
  created_tasks jsonb not null default '[]'::jsonb,
  previous_plan_id uuid references plans(id),
  feedback text,
  created_by text,
  decided_by text,
  comment text,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
create index plans_project on plans (project_id, created_at desc);

-- plan tasks run the planner; work tasks remember the plan they came from
alter table tasks add column plan_id uuid references plans(id);
