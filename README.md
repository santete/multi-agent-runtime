# multi-agent-runtime

Control plane and agent runtime that turns independent coding agents — Claude Code, Antigravity (`agy`), Codex and others — into one coordinated software engineering team: shared task graph, isolated git worktrees, structured artifacts, validation, human approval and GitHub PRs.

> Status: **MVP (M1–M5) complete** — task DAGs across Claude Code and Antigravity agents with shared handoffs, parallel branches, a policy hook on every tool call and a human approval gateway, validation with automatic rework, review and a merge queue for GitHub pull requests, role-based access with audit, restart recovery, and a live web dashboard. Next: Phase 2 (see the development plan).

![Task graph in the dashboard](docs/images/ui-graph.png)

## Task lifecycle

```text
CREATED ─(dependencies merged)→ READY → ASSIGNED → RUNNING ─(agent done)→ VALIDATING ─pass→ REVIEW (PR opened)
                                   ▲                  │                        └─fail→ REWORK ─┐
                                   │                  ├─ HIGH-risk call → WAITING_FOR_HUMAN ─(approvals decided)┤
                                   │                  └─ crash / lost runner → RETRYING ───────────────────────┤
                                   └────────────── requeued (context + resumed session) ◄──────────────────────┘
REVIEW ─approve→ APPROVED → MERGING ─merged→ COMPLETED (unlocks dependents)
   └─reject→ REWORK            └─conflict→ REWORK (base merged in, agent resolves)
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
  web/                     dashboard (React + Vite), served by the control plane at /ui/
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
# 0. Build the dashboard once (served at http://127.0.0.1:7700/ui/)
pnpm --filter @mar/web build

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
| POST | `/projects` | create project (`key`, `name`, `repoUrl`, `defaultBranch?`, `validation?: [{name, command, timeoutSeconds?}]`, `maxParallel?`) |
| GET | `/projects`, `/projects/:id` | list / get projects |
| PUT | `/projects/:id/validation` | replace the project's validation steps |
| POST | `/projects/:id/tasks` | create task (`title`, `objective`, `agent`, `maxAttempts?`, `dependsOn?: [id or key]`) |
| GET | `/projects/:id/tasks`, `/tasks/:id` | list / get tasks |
| GET | `/projects/:id/graph` | task DAG (`nodes`, `edges`) |
| POST | `/tasks/:id/cancel` | cancel a task (a running agent is stopped on its next heartbeat) |
| POST | `/tasks/:id/review` | `{decision: "approve" \| "reject", comment?}` for a task in `REVIEW` |
| POST | `/tasks/:id/retry` | send a `WAITING_FOR_HUMAN` or `BLOCKED` task back to the queue |
| GET | `/approvals?status=pending`, `/tasks/:id/approvals` | approval requests for risky actions |
| POST | `/approvals/:id/approve`, `/approvals/:id/reject` | decide an approval (`{comment?}`) |
| GET | `/tasks/:id/executions` | execution attempts |
| GET | `/tasks/:id/artifacts` | `handoff` (agent's structured report) and `validation_result` artifacts |
| GET | `/projects/:id/events`, `/tasks/:id/events`, `/executions/:id/events` | event log (`?after=<seq>&limit=`), incl. `ToolCallChecked` audit |
| GET | `/runners` | agent registry: runners, their agents and capabilities, online status, active executions |
| GET | `/me` | the calling user and role |
| GET | `/stream?projectId=&after=` | live events (server-sent events) |
| GET | `/events/recent?projectId=&limit=` | recent events, newest first |
| POST | `/runners/:id/gc` | runner protocol: which task worktrees can be removed |
| POST | `/runners/register`, `/runners/:id/claim` | runner protocol |
| POST | `/executions/:id/start`, `/heartbeat`, `/events`, `/complete`, `/validation`, `/delivery` | runner protocol |
| POST | `/executions/:id/tool-check` | policy check for the agent's PreToolUse hook (execution token) |

### Security

- **Users and roles** ([ADR-0009](docs/adr/0009-roles-recovery-ui.md)): `MAR_USERS_FILE` points at a JSON array of `{ "name", "role", "token" }` (tokens ≥ 16 chars); `MAR_API_TOKEN` adds an owner named `admin`. Roles: `viewer` (read) < `member` (create/cancel/retry/review tasks) < `senior` (decide HIGH-risk approvals) < `owner` (projects, validation), plus `runner` for runner machines (runner protocol only; set `apiToken` in the runner config). Actors are recorded in the event log. With no users configured the API runs in open mode and refuses to listen on a non-loopback address.
- Agents never receive an API token. Their policy hook uses a per-execution token that only authorizes `tool-check`.
- Policy (`packages/core/src/policy.ts`): HIGH-risk actions (network, secrets, destructive git, writes outside the worktree) need a human approval; CRITICAL ones (push, remote/credential changes, publishing, infrastructure, `.git`) are always denied. See [ADR-0004](docs/adr/0004-policy-enforcement.md) and [ADR-0008](docs/adr/0008-dag-approvals-merge-queue.md).

### Control plane settings

| Env | Default | |
|---|---|---|
| `DATABASE_URL` | – | Postgres; unset = embedded PGlite in `PGLITE_DIR` (`./.data/pglite`) |
| `HOST` / `PORT` | `127.0.0.1` / `7700` | |
| `MAR_LEASE_SECONDS` | `60` | execution lease; a runner silent for longer is considered lost |
| `MAR_SWEEP_INTERVAL_MS` | `5000` | lost-execution detection and RETRYING/REWORK → READY/BLOCKED |
| `GITHUB_TOKEN` | – | opens pull requests for delivered tasks (e.g. `GITHUB_TOKEN=$(gh auth token)`); without it the branch is pushed and the PR is skipped |

The runner pushes task branches with its machine's own git credentials; agents never can (the policy denies `git push`).
