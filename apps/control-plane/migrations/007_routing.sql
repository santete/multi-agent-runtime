-- Phase 2: capability-based routing and reassignment.

-- 'fixed': the task names its agent; 'auto': the scheduler picks one by skills
-- (tasks.agent is 'auto' until an agent is selected).
alter table tasks add column routing text not null default 'fixed';
alter table tasks add column requires jsonb not null default '[]'::jsonb;
-- fixed tasks: agents to switch to when the agent keeps failing or is unavailable
alter table tasks add column fallback_agents jsonb not null default '[]'::jsonb;
-- agents that failed this task and must not get it again
alter table tasks add column excluded_agents jsonb not null default '[]'::jsonb;

alter table projects add column routing_policy text not null default 'balanced';

-- the agent that ran an execution (a task can move between agents)
alter table executions add column agent text;
update executions e set agent = t.agent from tasks t where t.id = e.task_id;
