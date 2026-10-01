-- Path ownership (spec §27): globs of the repository a task works on.
alter table tasks add column paths jsonb not null default '[]'::jsonb;
