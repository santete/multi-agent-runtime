-- Phase 3: organizations (spec §49) and the agent marketplace (spec §53).

create table orgs (
  id text primary key,
  name text not null,
  created_at timestamptz not null default now()
);
insert into orgs (id, name) values ('default', 'Default');

-- every project and runner belongs to one organization
alter table projects add column org_id text not null default 'default' references orgs(id);
alter table runners add column org_id text not null default 'default' references orgs(id);
-- project-level agents (spec §49): empty = any agent the org's runners offer
alter table projects add column allowed_agents jsonb not null default '[]'::jsonb;

-- agent profiles published to an organization's catalog, or to everyone (org_id null)
create table agent_profiles (
  id uuid primary key,
  org_id text references orgs(id),
  name text not null,
  version int not null,
  adapter text not null,
  description text not null default '',
  skills jsonb not null default '[]'::jsonb,
  cost text not null default 'medium',
  pricing jsonb,
  instructions text not null default '',
  published_by text,
  deprecated boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index agent_profiles_version on agent_profiles (coalesce(org_id, ''), name, version);

-- which profile (name@version) an execution's agent was built from
alter table executions add column profile text;
