-- Phase 3: automatic reprioritization (spec §53): a person's priority, raised by the critical path and waiting time.
alter table tasks add column priority int not null default 50;
