# multi-agent-runtime

Control plane and agent runtime that turns independent coding agents — Claude Code, Antigravity (`agy`), Codex and others — into one coordinated software engineering team: shared task graph, isolated git worktrees, structured artifacts, validation, human approval and GitHub PRs.

> Status: **Phase 0 complete** — adapter contract, Claude Code and Antigravity adapters (parsers verified against recorded CLI runs), task state machine. Next: M1 walking skeleton.

## Layout

```text
docs/
  product-spec.md          product specification
  development-plan.md      phases, milestones, risks
  adr/                     architecture decision records
  spikes/                  CLI capability findings
packages/
  core/                    domain: task state machine, adapter contract, events
  adapter-claude-code/     Claude Code CLI (claude -p --output-format stream-json)
  adapter-antigravity/     Antigravity CLI (agy -p --output-format stream-json)
apps/                      control-plane, runner, web (from M1)
```

## Development

Requires Node 22+ and pnpm 10.

```sh
pnpm install
pnpm test
pnpm typecheck
```
