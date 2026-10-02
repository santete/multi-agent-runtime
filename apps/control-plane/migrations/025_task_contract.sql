-- Collaboration contract (spec §62): what a task starts from, its constraints, expected output,
-- acceptance criteria, and the person who owns it.
alter table tasks add column inputs jsonb not null default '[]'::jsonb;
alter table tasks add column constraints jsonb not null default '[]'::jsonb;
alter table tasks add column expected_output text not null default '';
alter table tasks add column acceptance_criteria jsonb not null default '[]'::jsonb;
alter table tasks add column owner text;
