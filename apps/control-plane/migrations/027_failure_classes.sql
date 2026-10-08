-- Why an execution failed, beyond "failed": the machine could not run the checks
-- (not the agent's fault), and a fingerprint of the failure so the same one twice
-- in a row hands the task to another agent instead of another rework.
alter table executions add column environment_failure boolean not null default false;
alter table executions add column failure_fingerprint text;
