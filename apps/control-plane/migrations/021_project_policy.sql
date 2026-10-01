-- Project policy (spec §47): the project's own rules on top of the built-in ones.
alter table projects add column policy jsonb not null default '{}'::jsonb;
