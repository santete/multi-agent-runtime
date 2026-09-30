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
- [x] Spike Claude PreToolUse hook qua `--settings` ở headless (làm ở M2: allow mở được shell, deny được báo trong `permission_denials`)
- [ ] Spike agy `--sandbox` + cách ly config theo runner (chuyển sang M3)

## Phase 1 — MVP

### M1 Walking skeleton — trạng thái

- [x] `apps/control-plane`: Fastify + zod, Postgres (`pg`) hoặc PGlite nhúng, migrations SQL, event store append-only
- [x] Project/Task API; task mới → `READY` (chưa có dependency ở M1)
- [x] Runner protocol: register, claim (`FOR UPDATE SKIP LOCKED`, lọc theo agent), start, events, complete
- [x] Kết quả execution → state: success → `VALIDATING`, denied actions → `WAITING_FOR_HUMAN`, lỗi → `RETRYING`
- [x] `apps/runner`: WorktreeManager (clone theo project, worktree + branch `task/<KEY>` theo task, khóa git theo repo), process runner (timeout, cancel, stderr → diagnostic), gom event theo batch, poll loop có `maxConcurrent`
- [x] `packages/adapter-generic-cli`
- [x] E2E test: task tạo qua API → runner chạy trong worktree riêng → log và timeline xem được qua API
- Chưa làm (chuyển sang M2): auth API, cancel một execution đang chạy từ control plane, heartbeat/lease cho runner bị mất, retry tự động từ `RETRYING`

### M2 Adapter thật — trạng thái ✅

- [x] Policy engine (`packages/core/src/policy.ts`): shell (Bash/PowerShell/run_command) và file tools, mức rủi ro LOW → CRITICAL, ghi ra ngoài workspace, `.git`, secrets
- [x] Policy hook chung `apps/runner/hook/mar-policy-hook.mjs` (dialect claude/agy, fail-closed) → `POST /executions/:id/tool-check` bằng execution token; mọi quyết định ghi `ToolCallChecked` (ADR-0004)
- [x] Inject hook: Claude qua `--settings`; agy qua `.agents/hooks.json` + `%MAR_POLICY_HOOK%` trên Windows
- [x] Agent registry: runner đăng ký agent kèm capability, upsert theo tên máy, `GET /runners` (online/offline)
- [x] Lease + heartbeat + cancel (kill cả cây process), sweep: `lost` → `RETRYING` → `READY`/`BLOCKED` theo `maxAttempts` (ADR-0006)
- [x] Resume session của chính runner đó sau khi bị gián đoạn
- [x] Tìm binary thật của npm shim trên Windows (`claude.cmd` → `claude.exe`)
- [x] API token (`MAR_API_TOKEN`); control plane từ chối chạy trên địa chỉ không phải loopback nếu thiếu token
- [x] E2E (fake Claude): hook allow/deny, cancel, runner mất → resume
- [x] **Chạy thật** (2026-09-30): cùng một task
  - Claude Code: `Write` + `PowerShell` được policy cho phép và audit, xong → `VALIDATING` ($0.07)
  - agy: `write_to_file` + `run_command` được policy cho phép và audit, file được tạo; `run_command` vẫn bị tầng quyền của agy chặn (#548) → `WAITING_FOR_HUMAN`
  - Kill cây process runner giữa task Claude → lease hết hạn → `READY` → runner restart resume đúng session, hoàn thành task
- Phát hiện khi chạy thật và đã sửa: hook agy trên Windows không chạy được vì `cmd /c` làm hỏng dấu nháy; agy báo `SUCCESS` dù mọi tool fail → control plane dùng audit của chính nó làm nguồn sự thật
- Chưa làm: agy `unattendedShell` (sandbox), cách ly config của agy theo runner, dọn worktree khi task kết thúc

### M3 Context · Validation · Git — trạng thái ✅ ([ADR-0007](adr/0007-validation-rework-delivery.md))

- [x] Context cho agent: `.orchestrator/context/TASK.md` và `REWORK.md` (git-exclude); prompt ngắn trỏ tới context; placeholder `{objective}` cho agent không phải LLM
- [x] Handoff artifact qua `--json-schema` (Claude và agy đều trả `structured_output`), lưu thành artifact `handoff`; `GET /tasks/:id/artifacts`
- [x] Validation theo project (`validation` khi tạo project, `PUT /projects/:id/validation`), runner chạy tuần tự trong worktree, có timeout, không lộ biến `MAR_*`; artifact `validation_result`
- [x] Rework tự động: validation fail → `REWORK` → requeue (tối đa `maxAttempts`) → lần sau nhận `rework` và resume session
- [x] Delivery: runner commit và push `task/<KEY>`; control plane mở PR qua `GitHubProvider` (`GITHUB_TOKEN`), nội dung PR lấy từ handoff và validation; ghi event cho các trường hợp không có thay đổi, provider lỗi, push lỗi
- [x] Execution có pha `validating` và `delivering` được lease; mất runner khi validating thì retry, khi delivering thì ghi `DeliveryLost` và giữ `REVIEW`
- [x] E2E (generic agent): validation fail → rework → pass → commit, push vào git thật → PR (provider giả)
- [x] **Chạy thật** trên `santete/mar-sandbox` (private): Claude Code viết `refund()` và test, `npm test` pass, runner push, **PR #1 và #2 được mở tự động** (tổng khoảng $0.5)
- Phát hiện khi chạy thật và đã sửa: danh sách file đổi mất ký tự đầu (do `trim()` output porcelain); cancel đến trước khi agent kịp spawn thì bị bỏ qua (lỗi có từ M2)
- Chưa làm (M4): merge PR và merge queue, dependency giữa các task (task sau phải nhìn thấy thay đổi của task trước)

### M4 DAG & Approval — trạng thái ✅ ([ADR-0008](adr/0008-dag-approvals-merge-queue.md))

- [x] Task DAG: `dependsOn` (id/key, cùng project, không thể có chu trình), task chờ ở `CREATED` tới khi dependency đã merge, tự mở khóa; `GET /projects/:id/graph`
- [x] Shared context: handoff của dependency được đưa vào `DEPENDENCIES.md`
- [x] Chạy song song có giới hạn: `maxParallel` theo project cộng `maxConcurrent` theo runner
- [x] Approval gateway: action HIGH tạo approval request → `WAITING_FOR_HUMAN` → approve/reject → requeue kèm quyết định + resume; action đã duyệt được phép (khớp theo `approvalKey`); CRITICAL vẫn deny cứng; `POST /tasks/:id/retry`
- [x] Review: `POST /tasks/:id/review` approve/reject (reject → rework kèm comment)
- [x] Merge queue: mỗi project merge tuần tự; GitHub squash merge + xóa branch; conflict → rework (runner merge base, agent resolve, validation kiểm tra marker conflict); lỗi khác → retry rồi `BLOCKED`
- [x] Worktree dựng từ branch task đã có trên remote nếu có (rework trên máy khác)
- [x] E2E với git thật: 2 nhánh song song, merge conflict thật → rework → resolve → merge, task phụ thuộc chạy trên base đã có cả hai thay đổi
- [x] **Demo thật** (tiêu chí xong của M4) trên `santete/mar-sandbox`: DAG 4 task PAY-1 → (PAY-2 ∥ PAY-3) → PAY-4, 1 lần approval (`curl`), 4 PR (#3–#6) được merge tự động theo thứ tự, `main` có 32/32 test pass, khoảng $1.00
- Chưa làm (M5 / Phase 2): UI, phân quyền người duyệt theo mức rủi ro, merge queue re-validate trên base mới, dọn worktree khi task `COMPLETED`

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
