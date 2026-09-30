-- Phase 2: shared project knowledge base (spec §20, §35).

create table knowledge (
  id uuid primary key,
  project_id uuid not null references projects(id),
  -- architecture | business_rule | api_contract | data_model | convention | decision | known_issue
  kind text not null,
  title text not null,
  body text not null,
  -- proposed (by an agent) | accepted (shared with every task) | archived
  status text not null,
  source_task_id uuid references tasks(id),
  source_agent text,
  created_by text,
  decided_by text,
  superseded_by uuid references knowledge(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index knowledge_project on knowledge (project_id, status);
create index knowledge_source_task on knowledge (source_task_id);
