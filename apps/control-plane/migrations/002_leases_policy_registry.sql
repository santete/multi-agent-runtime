-- M2: stable runner identity, execution leases/cancellation, execution tokens, retry limits.

alter table runners add constraint runners_name_key unique (name);

alter table tasks add column max_attempts integer not null default 3;

alter table executions add column lease_expires_at timestamptz;
alter table executions add column cancel_requested boolean not null default false;
-- sha256 of the execution token handed to the agent's policy hook
alter table executions add column token_hash text;

create index executions_active_leases on executions (lease_expires_at) where status in ('assigned', 'running');
create index tasks_retrying on tasks (updated_at) where state = 'RETRYING';
