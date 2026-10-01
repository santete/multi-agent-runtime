-- Per-organization notification webhooks (spec §31, §49): { "webhooks": [...], "kinds": [...] }.
alter table orgs add column notifications jsonb not null default '{}'::jsonb;
