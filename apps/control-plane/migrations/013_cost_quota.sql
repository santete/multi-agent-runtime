-- Phase 3: cost and quota (spec §39).

-- what each execution used and cost (reported by the agent, or estimated from pricing)
alter table executions add column input_tokens bigint;
alter table executions add column output_tokens bigint;
alter table executions add column cost_usd numeric(12, 6);
alter table executions add column cost_estimated boolean not null default false;

-- {dailyUsd, perTaskUsd}; null = unlimited
alter table projects add column budget jsonb;

-- an agent that hit its quota rests on that runner until `until`
create table agent_cooldowns (
  runner_id uuid not null references runners(id) on delete cascade,
  agent text not null,
  until timestamptz not null,
  reason text not null,
  created_at timestamptz not null default now(),
  primary key (runner_id, agent)
);
