-- Phase 3: self-healing (spec §46): reaction to a merge that breaks the base branch's CI.
alter table projects add column on_broken_main text not null default 'notify';
