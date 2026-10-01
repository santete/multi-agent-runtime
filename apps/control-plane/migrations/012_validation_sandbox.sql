-- Phase 2: validation in a container ({image, network, memory, cpus}); null = on the runner's host.
alter table projects add column validation_sandbox jsonb;
