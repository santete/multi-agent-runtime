-- Phase 3: autonomous planning with a critic agent (multi-agent debate, spec §53).
alter table projects add column planning jsonb not null
  default '{"critics": [], "maxRounds": 2, "autoApprove": false, "maxAutoTasks": 5}'::jsonb;
alter table plans add column round int not null default 1;
alter table plans add column critique jsonb;
