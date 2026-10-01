-- Secret management (spec §48): project secrets given to agents and validation as environment variables.
create table secrets (
  project_id uuid not null references projects(id) on delete cascade,
  name text not null,
  -- 'stored': AES-256-GCM ciphertext here; 'runner-env': the runner reads `ref` from its own environment.
  source text not null,
  ciphertext bytea,
  iv bytea,
  auth_tag bytea,
  ref text,
  expose_to text[] not null,
  updated_by text not null,
  updated_at timestamptz not null default now(),
  primary key (project_id, name)
);
