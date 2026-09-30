-- Phase 2: cross-agent code review.

alter table projects add column review_agents jsonb not null default '[]'::jsonb;
alter table projects add column auto_approve_on_agent_review boolean not null default false;

-- 'work' tasks produce code; 'review' tasks review another task's delivery.
alter table tasks add column kind text not null default 'work';
alter table tasks add column review_of uuid references tasks(id);
create index tasks_reviews on tasks (review_of) where review_of is not null;
