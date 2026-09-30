# multi-agent-runtime

Control plane and agent runtime that turns independent coding agents — Claude Code, Antigravity (`agy`), Codex and others — into one coordinated software engineering team: shared task graph, isolated git worktrees, structured artifacts, validation, human approval and GitHub PRs.

> Status: **M3** — real Claude Code and Antigravity runs in per-task git worktrees with task context, a policy hook on every tool call, structured handoffs, project validation with automatic rework, and delivery as a GitHub pull request. Next: M4 (task DAG, approval gateway, merge queue).

## Task lifecycle

```text
READY → ASSIGNED → RUNNING ──(agent done)──→ VALIDATING ──pass──→ REVIEW  (branch pushed, PR opened)
                     │                           └──fail──→ REWORK → READY (retry with failure context + resumed session)
                     ├─ policy denial ─→ WAITING_FOR_HUMAN
                     └─ crash / lost runner ─→ RETRYING → READY … BLOCKED after maxAttempts
```

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

## API

| Method | Path | Purpose |
|---|---|---|
| POST | `/projects` | create project (`key`, `name`, `repoUrl`, `defaultBranch?`, `validation?: [{name, command, timeoutSeconds?}]`) |
| GET | `/projects`, `/projects/:id` | list / get projects |
| PUT | `/projects/:id/validation` | replace the project's validation steps |
| POST | `/projects/:id/tasks` | create task (`title`, `objective`, `agent`, `maxAttempts?`) → `READY` |
| GET | `/projects/:id/tasks`, `/tasks/:id` | list / get tasks |
| POST | `/tasks/:id/cancel` | cancel a task (a running agent is stopped on its next heartbeat) |
| GET | `/tasks/:id/executions` | execution attempts |
| GET | `/tasks/:id/artifacts` | `handoff` (agent's structured report) and `validation_result` artifacts |
| GET | `/projects/:id/events`, `/tasks/:id/events`, `/executions/:id/events` | event log (`?after=<seq>&limit=`), incl. `ToolCallChecked` audit |
| GET | `/runners` | agent registry: runners, their agents and capabilities, online status |
| POST | `/runners/register`, `/runners/:id/claim` | runner protocol |
| POST | `/executions/:id/start`, `/heartbeat`, `/events`, `/complete`, `/validation`, `/delivery` | runner protocol |
| POST | `/executions/:id/tool-check` | policy check for the agent's PreToolUse hook (execution token) |

### Security

- `MAR_API_TOKEN`: when set, every route except `/health` and `tool-check` requires `Authorization: Bearer <token>` (runner: `apiToken` in its config or the same env var). Without it the control plane refuses to listen on a non-loopback address.
- Agents never receive the API token. Their policy hook uses a per-execution token that only authorizes `tool-check`.
- Policy (`packages/core/src/policy.ts`) denies HIGH/CRITICAL actions (push, remote/credential changes, publishing, infra changes, secrets, network, writes outside the worktree or into `.git`); a denied call parks the task in `WAITING_FOR_HUMAN`. See [ADR-0004](docs/adr/0004-policy-enforcement.md).

### Control plane settings

| Env | Default | |
|---|---|---|
| `DATABASE_URL` | – | Postgres; unset = embedded PGlite in `PGLITE_DIR` (`./.data/pglite`) |
| `HOST` / `PORT` | `127.0.0.1` / `7700` | |
| `MAR_LEASE_SECONDS` | `60` | execution lease; a runner silent for longer is considered lost |
| `MAR_SWEEP_INTERVAL_MS` | `5000` | lost-execution detection and RETRYING/REWORK → READY/BLOCKED |
| `GITHUB_TOKEN` | – | opens pull requests for delivered tasks (e.g. `GITHUB_TOKEN=$(gh auth token)`); without it the branch is pushed and the PR is skipped |

The runner pushes task branches with its machine's own git credentials; agents never can (the policy denies `git push`).
