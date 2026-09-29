# Development Plan — Multi-Agent Runtime

Nguồn yêu cầu: [`product-spec.md`](product-spec.md). Quyết định kiến trúc: [`adr/`](adr/). Kết quả spike: [`spikes/adapter-capability-matrix.md`](spikes/adapter-capability-matrix.md).

## Quyết định đã chốt

| ID | Quyết định | ADR |
|---|---|---|
| D1 | Backend TypeScript (Node 22), pnpm monorepo | [0001](adr/0001-typescript-monorepo.md) |
| D2 | Control Plane tập trung + Runner daemon | [0002](adr/0002-control-plane-and-runner.md) |
| D3 | State machine tự viết trên Postgres (MVP), đánh giá Temporal ở Phase 2 | [0002](adr/0002-control-plane-and-runner.md), [0005](adr/0005-task-state-machine.md) |
| D4 | GitHub trước, qua interface `GitProvider` | [0002](adr/0002-control-plane-and-runner.md) |
| D5 | Approval qua Web UI (Slack/Telegram để Phase 2) | [0004](adr/0004-policy-enforcement.md) |
| D6 | Thứ tự adapter: **Claude Code → Antigravity (agy) → Codex** | [0003](adr/0003-adapter-contract.md) |

## Kiến trúc MVP

```text
Web UI (dashboard, task board, agent console, approvals)
        │ REST + SSE
Control Plane — project · task DAG · scheduler · policy · approval · GitHub · event store
        │ PostgreSQL (state + events + outbox)
        │ HTTP long-poll / WebSocket
Runner (mỗi máy) — workspace manager (git worktree) · adapter host · validator · policy hook endpoint
        ├─ ClaudeCodeAdapter   (claude -p, stream-json)
        ├─ AntigravityAdapter  (agy -p, stream-json)
        └─ GenericCliAdapter
```

## Phase 0 — Discovery & spike ✅

- [x] Spike Claude Code headless: stream-json, accept-edits, resume, cost, permission_denials
- [x] Spike agy headless: stream-json, accept-edits, resume, denied_actions, PreToolUse hook
- [x] ADR 0001–0005
- [x] Adapter contract + parser cho Claude Code và agy, test bằng fixture thật
- [x] Task state machine chuẩn hóa + test
- [ ] Spike Claude PreToolUse hook qua `--settings` ở headless (chuyển sang M2)
- [ ] Spike agy `--sandbox` + cách ly config theo runner (chuyển sang M2)

## Phase 1 — MVP

| Milestone | Nội dung | Tiêu chí xong |
|---|---|---|
| **M1 Walking skeleton** | `apps/control-plane` (Fastify + Postgres + migrations), Project/Task CRUD, event store append-only, `apps/runner` đăng ký với control plane, `GenericCliAdapter`, worktree manager | Tạo task qua API, runner chạy lệnh trong worktree riêng, log và event hiện qua API |
| **M2 Adapter thật** | Chạy `ClaudeCodeAdapter` và `AntigravityAdapter` end-to-end trong runner; stop/cancel/resume; agent registry và capability; policy hook endpoint | Cùng một task chạy được bằng Claude hoặc agy chỉ bằng cách đổi agent; resume sau khi kill runner |
| **M3 Context · Validation · Git** | Đưa context vào `.orchestrator/context/`, thu artifact qua `--json-schema`; validator (build/test/diff); platform commit, push và mở PR trên GitHub; vòng REWORK (tối đa N lần) | Task fail test thì tự rework rồi pass; PR được tạo tự động |
| **M4 DAG & Approval** | Task dependency, READY tự động, chạy song song có giới hạn, approval gateway (LOW/HIGH), merge queue | Demo DAG 4 task (§13), 2 nhánh chạy song song, 1 lần approval |
| **M5 UI & hardening** | Dashboard, task board, agent console (log, diff, approve); khôi phục sau khi control plane hoặc runner restart | Demo §54 rút gọn trên repo mẫu |

**Demo MVP:** "Thêm refund API" trên repo mẫu. Architecture chạy bằng Claude, DB và API chạy song song bằng agy và Claude, Test do Runner validate. Có ít nhất 1 lần rework, 1 lần approval, và merge qua PR.

## Phase 2

Codex adapter · planner hỗ trợ (LLM đề xuất DAG, người duyệt) · review agent chéo · shared knowledge base · scheduler theo capability, policy và cost · reassign khi agent lỗi · container sandbox · Slack/Telegram approval · OpenTelemetry · CI integration.

## Phase 3

Planner tự động · chọn agent dựa trên metric thực tế (§40) · self-healing · tối ưu cost và quota · multi-org · marketplace.

## Rủi ro đang theo dõi

| Rủi ro | Giảm thiểu |
|---|---|
| CLI thay đổi format output | Test dựa trên fixture, pin phiên bản CLI, contract test chạy hằng đêm với CLI thật |
| agy headless không cho phép chạy lệnh shell (upstream #548/#619) | ADR-0004: Runner chạy build/test thay agent; chế độ unattended chỉ bật khi có sandbox và owner cho phép |
| Config cá nhân lọt vào lượt chạy (hook, plugin) | Claude: `--setting-sources project,local --strict-mcp-config`; agy: cách ly config theo runner (M2) |
| Merge conflict khi chạy song song | Path ownership + merge queue |
| Quota subscription | Theo dõi `rate_limit_event` (Claude); scheduler giới hạn concurrency theo agent |
