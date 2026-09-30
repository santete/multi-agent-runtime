-- M5: who decided an approval (spec §31: approvals must be audited).

alter table approvals add column decided_by text;
