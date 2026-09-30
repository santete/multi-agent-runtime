# multi-agent-runtime

Control plane and agent runtime that turns independent coding agents — Claude Code, Antigravity (`agy`), Codex and others — into one coordinated software engineering team: shared task graph, isolated git worktrees, structured artifacts, validation, human approval and GitHub PRs.

> Status: **M1 walking skeleton** — control plane API with event store, runner that claims tasks and executes them in per-task git worktrees. Next: M2 (real Claude Code / Antigravity runs, cancel/resume, policy hook).

## Layout

```text
docs/
  product-spec.md          product specification
  development-plan.md      phases, milestones, risks
  adr/                     architecture decision records
  spikes/                  CLI capability findings
packages/
  core/                    task state machine, adapter contract, API wire types
  adapter-claude-code/     Claude Code CLI (claude -p --output-format stream-json)
  adapter-antigravity/     Antigravity CLI (agy -p --output-format stream-json)
  adapter-generic-cli/     any command-line tool (stdout lines + exit code)
apps/
  control-plane/           Fastify API, Postgres/PGlite, append-only event store
  runner/                  claims tasks, prepares git worktrees, runs adapters, streams events
```

## Development

Requires Node 22+, pnpm 10 and git.

```sh
pnpm install
pnpm test
pnpm typecheck
```

## Run locally

```sh
# 1. Control plane on http://127.0.0.1:7700
#    Without DATABASE_URL it uses embedded PGlite in ./.data/pglite.
#    With Postgres: docker compose up -d && export DATABASE_URL=postgres://mar:mar@localhost:5432/mar
pnpm --filter @mar/control-plane start

# 2. Runner (copy and edit the example config: agents available on this machine)
cp apps/runner/runner.config.example.json apps/runner/runner.config.json
pnpm --filter @mar/runner start runner.config.json

# 3. Create a project and a task
curl -s -X POST localhost:7700/projects -H 'content-type: application/json' \
  -d '{"key":"DEMO","name":"Demo","repoUrl":"https://github.com/<you>/<repo>.git"}'
curl -s -X POST localhost:7700/projects/<projectId>/tasks -H 'content-type: application/json' \
  -d '{"title":"List files","objective":"ls -la","agent":"shell"}'

# 4. Watch it
curl -s localhost:7700/tasks/<taskId>
curl -s localhost:7700/tasks/<taskId>/events
```

## API (M1)

| Method | Path | Purpose |
|---|---|---|
| POST | `/projects` | create project (`key`, `name`, `repoUrl`, `defaultBranch?`) |
| GET | `/projects`, `/projects/:id` | list / get projects |
| POST | `/projects/:id/tasks` | create task (`title`, `objective`, `agent`) → `READY` |
| GET | `/projects/:id/tasks`, `/tasks/:id` | list / get tasks |
| POST | `/tasks/:id/cancel` | cancel a task |
| GET | `/tasks/:id/executions` | execution attempts |
| GET | `/projects/:id/events`, `/tasks/:id/events`, `/executions/:id/events` | event log (`?after=<seq>&limit=`) |
| POST | `/runners/register`, `/runners/:id/claim` | runner protocol |
| POST | `/executions/:id/start`, `/events`, `/complete` | runner protocol |

The API has **no authentication yet** and binds to `127.0.0.1` by default.
