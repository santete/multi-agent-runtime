-- The run failed because the agent was unavailable (quota, session limit, login): it does not use up the task's attempts.
alter table executions add column agent_unavailable boolean not null default false;
