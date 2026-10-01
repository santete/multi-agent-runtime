# multi-agent-runtime

Control plane and agent runtime that turns independent coding agents — Claude Code, Antigravity (`agy`), OpenAI Codex and others — into one coordinated software engineering team: shared task graph, isolated git worktrees, structured artifacts, validation, human approval and GitHub PRs.

> Status: **MVP, Phase 2 and Phase 3 complete.** Task DAGs across Claude Code, Antigravity and Codex agents with a policy hook on every tool call, validation, review, CI-gated merge queue and GitHub pull requests; assisted and autonomous planning with a critic agent; capability routing by measured results; shared knowledge; cost, quota and budgets; self-healing (revert or fix a broken base branch, escalation); human decisions and tasks for people; organizations and an agent marketplace; Slack-compatible notifications, OpenTelemetry and a live dashboard. See the development plan.

![Task graph in the dashboard](docs/images/ui-graph.png)

## Task lifecycle

```text
CREATED ─(dependencies merged)→ READY → ASSIGNED → RUNNING ─(agent done)→ VALIDATING ─pass→ REVIEW (PR opened)
                                   ▲                  │                        └─fail→ REWORK ─┐
                                   │                  ├─ HIGH-risk call → WAITING_FOR_HUMAN ─(approvals decided)┤
                                   │                  └─ crash / lost runner → RETRYING ───────────────────────┤
                                   └────────────── requeued (context + resumed session) ◄──────────────────────┘
REVIEW (agent review by another agent, then human) ─approve→ APPROVED → MERGING ─merged→ COMPLETED (unlocks dependents)
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
  adapter-codex/           OpenAI Codex CLI (codex exec --json), sandboxed + audited
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
| POST | `/projects` | create project (`key`, `name`, `repoUrl`, `defaultBranch?`, `validation?: [{name, command, timeoutSeconds?}]`, `maxParallel?`, `reviewAgents?`, `autoApproveOnAgentReview?`, `routingPolicy?: "balanced" \| "reliability" \| "cost"`, `revalidateOnBaseChange?` (default true), `waitForChecks?`) |
| GET | `/projects`, `/projects/:id` | list / get projects |
| PUT | `/projects/:id/validation` | replace the project's validation steps |
| PUT | `/projects/:id/validation-sandbox` | `{image, network?, memory?, cpus?}` or `null`: run validation steps in a container ([ADR-0018](docs/adr/0018-sandboxed-validation-and-agy-unattended.md)) |
| PUT | `/projects/:id/merge-policy` | `{revalidateOnBaseChange, waitForChecks}`: re-validate on a moved base and wait for CI before merging ([ADR-0015](docs/adr/0015-ci-and-revalidation.md)) |
| PUT | `/projects/:id/review` | `{reviewAgents: [agent ids], autoApproveOnAgentReview}`: cross-agent review of every delivery ([ADR-0011](docs/adr/0011-cross-agent-review.md)) |
| POST | `/projects/:id/tasks` | create task (`title`, `objective`, `agent` — an agent id or `"auto"`, `requires?: [skills]`, `fallbackAgents?`, `priority?` (0..100, default 50), `maxAttempts?`, `dependsOn?: [id or key]`); see [ADR-0012](docs/adr/0012-capability-routing.md) |
| GET | `/projects/:id/tasks`, `/tasks/:id` | list / get tasks |
| GET | `/projects/:id/queue` | READY tasks in the order the scheduler takes them, with reasons ([ADR-0023](docs/adr/0023-automatic-reprioritization.md)) |
| PUT | `/tasks/:id/priority` | `{priority: 0..100}` |
| POST | `/projects/:id/plans` | `{goal, agent}`: a planner agent proposes a task DAG ([ADR-0013](docs/adr/0013-assisted-planning.md)) |
| GET | `/projects/:id/plans`, `/plans/:id` | plans with their proposal and status |
| GET | `/projects/:id/knowledge?status=` | shared project knowledge: facts agents reported (accepted when their work merges) and people wrote ([ADR-0014](docs/adr/0014-shared-knowledge-base.md)) |
| POST | `/projects/:id/knowledge` | `{kind, title, body}`: write a fact down (accepted right away) |
| PUT | `/knowledge/:id` | edit an entry, or `{status: "accepted" \| "archived"}` |
| POST | `/plans/:id/approve`, `/plans/:id/revise`, `/plans/:id/reject` | approve (optionally `{tasks}` as edited) to create the tasks, send back with `{feedback}`, or reject |
| GET | `/projects/:id/graph` | task DAG (`nodes`, `edges`) |
| POST | `/tasks/:id/cancel` | cancel a task (a running agent is stopped on its next heartbeat) |
| POST | `/tasks/:id/review` | `{decision: "approve" \| "reject", comment?}` for a task in `REVIEW` |
| POST | `/tasks/:id/retry` | send a `WAITING_FOR_HUMAN` or `BLOCKED` task back to the queue |
| GET | `/approvals?status=pending`, `/tasks/:id/approvals` | approval requests for risky actions |
| GET | `/decisions?status=&taskId=` | questions agents could not decide alone; `POST /decisions/:id/answer {answer}` resumes the agent ([ADR-0024](docs/adr/0024-human-as-executor.md)) |
| GET | `/human-tasks` | READY tasks for `agent: "human"`; `POST /tasks/:id/done {summary}` completes one |
| POST | `/approvals/:id/approve`, `/approvals/:id/reject` | decide an approval (`{comment?}`) |
| GET | `/tasks/:id/executions` | execution attempts |
| GET | `/tasks/:id/artifacts` | `handoff` (agent's structured report) and `validation_result` artifacts |
| GET | `/projects/:id/events`, `/tasks/:id/events`, `/executions/:id/events` | event log (`?after=<seq>&limit=`), incl. `ToolCallChecked` audit |
| GET | `/runners` | agent registry: runners, their agents and capabilities, online status, active executions |
| PUT | `/projects/:id/planning` | `{critics, maxRounds, autoApprove, maxAutoTasks}`: a critic agent debates each plan; small plans the critic approves can approve themselves ([ADR-0022](docs/adr/0022-plan-debate-and-autonomy.md)) |
| PUT | `/projects/:id/self-healing` | `{onBrokenMain: "notify" | "revert" | "fix"}`: reaction when the base branch CI fails on a merge ([ADR-0021](docs/adr/0021-self-healing.md)) |
| PUT | `/projects/:id/budget` | `{dailyUsd?, perTaskUsd?}` or `null`: spending limits ([ADR-0019](docs/adr/0019-cost-and-quota.md)) |
| GET | `/projects/:id/costs?days=` | spend per day and agent (reported, or estimated from runner `pricing`) |
| GET | `/agents/cooldowns` | agents resting after a quota hit; `DELETE /runners/:id/cooldowns/:agent` makes one available again |
| GET | `/agents/stats?projectId=` | per-agent track record (spec §40): runs, success, validation pass, review rejects, human interventions, tasks merged/blocked, rework, duration, tokens, cost |
| GET | `/agents/skill-stats?projectId=` | the same per required skill; the scheduler routes by it ([ADR-0020](docs/adr/0020-agent-performance-routing.md)) |
| PUT | `/projects/:id/routing-policy` | `{routingPolicy: "balanced" | "reliability" | "cost" | "speed"}` |
| GET | `/me` | the calling user, role and organization |
| GET/POST | `/orgs` | organizations; platform admins (`org: "*"`) create them ([ADR-0025](docs/adr/0025-organizations-and-marketplace.md)) |
| PUT | `/projects/:id/agents` | `{allowedAgents}`: agents allowed on the project (empty = any) |
| GET/POST | `/agent-profiles` | agent marketplace: versioned profiles (adapter, skills, cost, pricing, instructions); runners use them with `"profile": "name"`; `POST /agent-profiles/:id/deprecate` |
| GET | `/stream?projectId=&after=` | live events (server-sent events) |
| GET | `/events/recent?projectId=&limit=` | recent events, newest first |
| POST | `/runners/:id/gc` | runner protocol: which task worktrees can be removed |
| POST | `/runners/register`, `/runners/:id/claim` | runner protocol |
| POST | `/executions/:id/start`, `/heartbeat`, `/events`, `/complete`, `/validation`, `/delivery` | runner protocol |
| POST | `/executions/:id/tool-check` | policy check for the agent's PreToolUse hook (execution token) |

### Security

- **Users and roles** ([ADR-0009](docs/adr/0009-roles-recovery-ui.md)): `MAR_USERS_FILE` points at a JSON array of `{ "name", "role", "token", "org"? }` (`org` defaults to `default`; `"*"` is a platform admin across organizations) (tokens ≥ 16 chars); `MAR_API_TOKEN` adds an owner named `admin`. Roles: `viewer` (read) < `member` (create/cancel/retry/review tasks) < `senior` (decide HIGH-risk approvals) < `owner` (projects, validation), plus `runner` for runner machines (runner protocol only; set `apiToken` in the runner config). Actors are recorded in the event log. With no users configured the API runs in open mode and refuses to listen on a non-loopback address.
- Agents never receive an API token. Their policy hook uses a per-execution token that only authorizes `tool-check`.
- Policy (`packages/core/src/policy.ts`): HIGH-risk actions (network, secrets, destructive git, writes outside the worktree) need a human approval; CRITICAL ones (push, remote/credential changes, publishing, infrastructure, `.git`) are always denied. See [ADR-0004](docs/adr/0004-policy-enforcement.md) and [ADR-0008](docs/adr/0008-dag-approvals-merge-queue.md).

### Control plane settings

| Env | Default | |
|---|---|---|
| `DATABASE_URL` | – | Postgres; unset = embedded PGlite in `PGLITE_DIR` (`./.data/pglite`) |
| `HOST` / `PORT` | `127.0.0.1` / `7700` | |
| `MAR_LEASE_SECONDS` | `60` | execution lease; a runner silent for longer is considered lost |
| `MAR_SWEEP_INTERVAL_MS` | `5000` | lost-execution detection and RETRYING/REWORK → READY/BLOCKED |
| `MAR_NOTIFY_WEBHOOKS` | – | comma-separated Slack-compatible incoming webhook URLs (Slack, Mattermost, Rocket.Chat, Discord `/slack`); unset = no notifications ([ADR-0016](docs/adr/0016-notifications.md)) |
| `MAR_NOTIFY_EVENTS` | `approval,review,plan,blocked,budget,quota,main` | also `ci`, `merged` |
| `MAR_ESCALATE_READY_MINUTES` / `MAR_ESCALATE_HUMAN_HOURS` | `30` / `8` | escalate work that has not moved (`TaskStuck`, with the reason) |
| `MAR_PUBLIC_URL` | `http://HOST:PORT` | dashboard base URL used in notification links |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | – | OTLP/HTTP collector for traces and metrics (control plane and runner); one trace per execution ([ADR-0017](docs/adr/0017-opentelemetry.md)) |
| `GITHUB_TOKEN` | – | opens pull requests for delivered tasks (e.g. `GITHUB_TOKEN=$(gh auth token)`); without it the branch is pushed and the PR is skipped |

The runner pushes task branches with its machine's own git credentials; agents never can (the policy denies `git push`).
