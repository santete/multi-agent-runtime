-- Phase 2: CI integration and re-validation on a moved base branch (spec §27, §34).

alter table projects add column revalidate_on_base_change boolean not null default true;
alter table projects add column wait_for_checks boolean not null default false;

-- the runner only merged the moved base in and re-validated (no agent run)
alter table executions add column revalidation boolean not null default false;
