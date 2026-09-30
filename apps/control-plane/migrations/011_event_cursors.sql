-- Phase 2: positions of event log consumers (notifications) so restarts neither repeat nor skip.

create table event_cursors (
  name text primary key,
  seq bigint not null,
  updated_at timestamptz not null default now()
);
