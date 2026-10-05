# Development Plan — Multi-Agent Runtime

Nguồn yêu cầu: [`product-spec.md`](product-spec.md). Quyết định kiến trúc: [`adr/`](adr/). Kết quả spike: [`spikes/adapter-capability-matrix.md`](spikes/adapter-capability-matrix.md).

## Quyết định đã chốt

| ID | Quyết định | ADR |
|---|---|---|
| D1 | Backend TypeScript (Node 22), pnpm monorepo | [0001](adr/0001-typescript-monorepo.md) |
| D2 | Control Plane tập trung + Runner daemon | [0002](adr/0002-control-plane-and-runner.md) |
| D3 | State machine tự viết trên Postgres; đã đánh giá Temporal và chưa dùng | [0002](adr/0002-control-plane-and-runner.md), [0005](adr/0005-task-state-machine.md), [0032](adr/0032-temporal-evaluation.md) |
| D4 | GitHub trước, qua interface `GitProvider` | [0002](adr/0002-control-plane-and-runner.md) |
| D5 | Approval qua Web UI; Phase 2 thêm thông báo qua webhook tương thích Slack ([ADR-0016](adr/0016-notifications.md)) | [0004](adr/0004-policy-enforcement.md) |
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
- [x] Spike agy `--sandbox` (ADR-0018) + cách ly config theo runner (xem mục "Các việc còn sót")

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

### M5 UI & hardening — trạng thái ✅ ([ADR-0009](adr/0009-roles-recovery-ui.md))

- [x] Vai trò viewer/member/senior/owner + runner, quyền theo từng route, approval HIGH cần senior, audit `actor`/`decidedBy`
- [x] Phục hồi: gia hạn lease khi control plane khởi động; runner retry kết quả công việc; policy hook chịu được control plane gián đoạn ngắn
- [x] Dọn worktree + branch local của task đã xong
- [x] SSE `/stream`, `/events/recent`, runner đang làm gì
- [x] Dashboard `apps/web` tại `/ui/`: overview, board, DAG, task (agent console realtime, review, retry, approval), approvals, agents
- [x] **Demo thật** (tiêu chí xong của M5, §54 rút gọn) trên `mar-sandbox`: DAG RFD-1 → (RFD-2 ∥ RFD-3); kill control plane 40 giây lúc Claude đang chạy mà không mất execution; retry + review + approve đều qua UI; PR #7–#9 được merge, `main` đạt 44/44 test
- Phát hiện khi chạy thật và đã sửa: hook fail-closed ngay khi control plane restart (giờ retry 90 giây)

## Phase 1 (MVP) — hoàn tất

Toàn bộ M1–M5 đã xong. Việc tiếp theo thuộc Phase 2 (xem bên dưới), ưu tiên đề xuất: Codex adapter, planner hỗ trợ (LLM đề xuất DAG), review agent chéo, OpenTelemetry, merge queue re-validate trên base mới, agy `unattendedShell` trong sandbox.

| Milestone | Nội dung | Tiêu chí xong |
|---|---|---|
| **M1 Walking skeleton** | `apps/control-plane` (Fastify + Postgres + migrations), Project/Task CRUD, event store append-only, `apps/runner` đăng ký với control plane, `GenericCliAdapter`, worktree manager | Tạo task qua API, runner chạy lệnh trong worktree riêng, log và event hiện qua API |
| **M2 Adapter thật** | Chạy `ClaudeCodeAdapter` và `AntigravityAdapter` end-to-end trong runner; stop/cancel/resume; agent registry và capability; policy hook endpoint | Cùng một task chạy được bằng Claude hoặc agy chỉ bằng cách đổi agent; resume sau khi kill runner |
| **M3 Context · Validation · Git** | Đưa context vào `.orchestrator/context/`, thu artifact qua `--json-schema`; validator (build/test/diff); platform commit, push và mở PR trên GitHub; vòng REWORK (tối đa N lần) | Task fail test thì tự rework rồi pass; PR được tạo tự động |
| **M4 DAG & Approval** | Task dependency, READY tự động, chạy song song có giới hạn, approval gateway (LOW/HIGH), merge queue | Demo DAG 4 task (§13), 2 nhánh chạy song song, 1 lần approval |
| **M5 UI & hardening** | Dashboard, task board, agent console (log, diff, approve); khôi phục sau khi control plane hoặc runner restart | Demo §54 rút gọn trên repo mẫu |

**Demo MVP:** "Thêm refund API" trên repo mẫu. Architecture chạy bằng Claude, DB và API chạy song song bằng agy và Claude, Test do Runner validate. Có ít nhất 1 lần rework, 1 lần approval, và merge qua PR.

## Phase 2

### Codex adapter — trạng thái ✅ ([ADR-0010](adr/0010-codex-adapter.md))

- [x] `packages/adapter-codex`: `codex exec --json`, resume, output schema, sandbox `workspace-write` (không mạng), cách ly config (+ workaround sandbox Windows)
- [x] Capability `approval: "sandbox"` + control plane audit sau khi chạy (`ToolCallChecked { audit: true }`); vi phạm → `WAITING_FOR_HUMAN`
- [x] Policy hiểu `apply_patch` (đường dẫn trong patch)
- [x] **Chạy thật**: DAG CDX-1 (Codex) → CDX-2 (Claude, dùng handoff của Codex) trên `mar-sandbox`, PR #10–#11 được merge, `main` đạt 47/47 test
- Giới hạn: trên Windows không duyệt trước được tool call của Codex (upstream #24453), chỉ audit sau khi chạy


Codex adapter · planner hỗ trợ (LLM đề xuất DAG, người duyệt) · review agent chéo · shared knowledge base · scheduler theo capability, policy và cost · reassign khi agent lỗi · container sandbox · Slack/Telegram approval · OpenTelemetry · CI integration.

### Review agent chéo — trạng thái ✅ ([ADR-0011](adr/0011-cross-agent-review.md))

- [x] Project `reviewAgents` + `autoApproveOnAgentReview`; mỗi lần deliver tạo review task cho một agent khác tác giả
- [x] Reviewer chạy read-only trên branch đã push, context `REVIEW.md` + `DIFF.patch`, output `REVIEW_SCHEMA` (verdict + findings)
- [x] `request_changes` → rework của tác giả kèm findings; `approve` → người duyệt hoặc tự approve; comment review lên PR
- [x] **Chạy thật**: Codex ↔ Claude review lẫn nhau (PR #12, #13 merged), Codex bắt đúng 3 lỗi của một agent cố tình làm sai

### Scheduler theo capability · reassign — trạng thái ✅ ([ADR-0012](adr/0012-capability-routing.md))

- [x] Agent khai báo `skills` và `cost` trong config runner; task `agent: "auto"` + `requires` được route lúc claim theo skill, độ tin cậy đo được, cost và tải (`routingPolicy` của project: balanced / reliability / cost), ghi `AgentSelected` kèm lý do
- [x] Reassign khi agent hết quota/rate limit/chưa đăng nhập hoặc fail 2 lần liên tiếp: task auto loại agent đó và route lại, task cố định chuyển sang `fallbackAgents`; event `TaskReassigned`
- [x] Resume chỉ trong cùng agent (`executions.agent`); review task có fallback reviewer và không bao giờ giao cho tác giả
- [x] `GET /agents/stats` (runs, success, fail, thời gian trung bình, rework rate) + bảng Track record trên UI; hộp thoại tạo task hỗ trợ auto/required skills/fallback

### Planner hỗ trợ — trạng thái ✅ ([ADR-0013](adr/0013-assisted-planning.md))

- [x] `POST /projects/:id/plans {goal, agent}`: planner task `kind: "plan"` chạy read-only trên base branch với `PLAN.md` (goal, agent online + skill, task đang mở) và `PLAN_SCHEMA`
- [x] `checkPlan`: ref duy nhất, không vòng, thứ tự topo, dependency tới task có sẵn theo key; đọc được JSON trong text với agent không có structured output
- [x] Người duyệt: approve (có thể sửa task trước), revise kèm feedback (plan mới có context proposal cũ), reject; approve tạo DAG trong một transaction, `agent: null` → auto routing
- [x] UI: tab Plans, trang plan chỉnh sửa và duyệt; event `Plan*` trên timeline
- [x] **Chạy thật** trên `mar-sandbox`:
  - Claude lập kế hoạch cho goal "void payment + CSV export" và tự tách thành 2 task song song để tránh conflict. Người duyệt đổi agent của một task trước khi approve.
  - Codex (LP-4) và Claude (LP-5) chạy song song. PR #15 và #16 merge không conflict, `main` đạt 72/72 test.
  - Với goal đã được làm xong, Claude trả về 0 task kèm giải thích. Platform nhận đây là kết quả hợp lệ ("không còn gì để làm"), không tính là lỗi. Codex với cùng goal chỉ đề xuất 1 task cập nhật tài liệu còn thiếu.

### Shared knowledge base — trạng thái ✅ ([ADR-0014](adr/0014-shared-knowledge-base.md))

- [x] Handoff và plan có `knowledge: [{kind, title, body}]` (architecture, business rule, API contract, data model, convention, decision, known issue)
- [x] Note của agent ở trạng thái `proposed`; được `accepted` khi task merge hoặc khi plan được approve; entry cùng fact bị supersede; người có thể thêm, sửa, accept, archive
- [x] Mọi task (work, review, plan) nhận knowledge đã accepted qua `.orchestrator/context/KNOWLEDGE.md` (ngân sách 40.000 ký tự)
- [x] UI: tab Knowledge; event `Knowledge*` trên timeline
- [x] **Chạy thật** trên `mar-sandbox`: Claude (LP-6, PR #17) báo 2 fact về project (một business rule, một convention testing). Khi PR merge, 2 fact này tự chuyển accepted. Task Codex tiếp theo (LP-7) nhận chúng trong `KNOWLEDGE.md`, đọc file ngay khi bắt đầu, và không báo trùng lại.

### CI integration · merge queue re-validate — trạng thái ✅ ([ADR-0015](adr/0015-ci-and-revalidation.md))

- [x] `GitProvider.pullRequestStatus`: base có đổi không, check runs + commit statuses (kèm annotations của check fail); merge policy theo project (`revalidateOnBaseChange`, `waitForChecks`)
- [x] Base đổi sau khi validate → rework `base_changed`: runner merge base; sạch thì không chạy agent, chỉ validate lại rồi quay về `APPROVED`; conflict hoặc fail thì agent sửa, người review lại; không tính vào `maxAttempts`
- [x] CI pending giữ hàng đợi; CI fail → rework `ci` với check và thông điệp lỗi; không có CI sau thời gian chờ → merge, ghi `CiSkipped`
- [x] Sửa cấu hình CI cần approval (HIGH); không tự approve thay đổi chạm CI; PR có cảnh báo; không cho cancel khi đang `MERGING`
- [x] **Chạy thật** trên `mar-sandbox` với GitHub Actions: re-validate LP-9 trên `main` mới mà không chạy agent; CI fail → rework `ci`; phát hiện agent nới lỏng CI để pass (đã chặn bằng policy) và lỗi cancel lúc đang merge (đã sửa)

### Thông báo (webhook tương thích Slack) — trạng thái ✅ ([ADR-0016](adr/0016-notifications.md))

- [x] Notifier đọc event log theo cursor lưu trong DB (`event_cursors`), không gửi lặp, không bỏ sót khi restart; lần đầu bắt đầu từ cuối log
- [x] Báo approval HIGH, task cần review (kèm PR), plan chờ duyệt, task bị chặn; tùy chọn CI fail và merged; link về dashboard (`MAR_PUBLIC_URL`)
- [x] Retry lỗi mạng/5xx/429; webhook hỏng không làm kẹt các event khác; log không chứa URL webhook
- [x] **Chạy thật** với một webhook giả lập Slack chạy local: nhận đủ 3 thông báo từ lượt chạy thật của Claude: "Approval needed (HIGH)" khi agent định chạy `curl`, "waiting for a person", và "Plan ready for review" (3 task). Link dashboard đúng, log không chứa URL webhook.

### OpenTelemetry — trạng thái ✅ ([ADR-0017](adr/0017-opentelemetry.md))

- [x] `@mar/telemetry`: OTLP/HTTP traces + metrics khi có `OTEL_EXPORTER_OTLP_ENDPOINT`, no-op khi không
- [x] Một trace mỗi execution: `workspace.prepare`, `agent.run` (token, cost), `validation` + từng bước, `delivery`; span server của control plane và span `github …` nằm trong cùng trace qua `traceparent`; tool check của agent nằm dưới `agent.run` nhờ `TRACEPARENT` trong policy hook
- [x] Metrics: executions, duration, tokens, cost, task transitions; merge queue có span riêng cho mỗi task
- [x] **Chạy thật** (Claude, LP-13, với một OTLP collector chạy local): trace có 54 span, gồm `workspace.prepare` 5,5 giây, `agent.run` 35 giây (2.655 output token, $0,30) với 11 tool check của Claude nằm bên dưới, bước validation `test`, và `delivery` → `github POST /pulls`. Span heartbeat và event batch bị bỏ vì gây nhiễu.

### Validation trong container · agy unattended — trạng thái ✅ ([ADR-0018](adr/0018-sandboxed-validation-and-agy-unattended.md))

- [x] `validationSandbox` theo project: mỗi bước validation chạy trong `docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges`, mount worktree; fail closed khi không có runtime
- [x] agy `unattended` (opt-in theo runner): `--sandbox --dangerously-skip-permissions`, chỉ khi có policy hook
- [x] **Chạy thật** agy unattended (LP-14, PR #24): agy tự chạy `npm test`/`git`, hook vẫn chặn `curl` thành approval
- [x] **Chạy thật** validation trong container (LP-39, PR #39, ngày 2026-10-01, sau khi Docker được khởi động lại): `npm test` chạy trong `node:22-alpine`, 136 test và 0 skipped. Secret dành cho validation đi vào container qua `-e NAME`. Không còn container nào sót lại (`--rm`)

## Phase 2 — hoàn tất

Đã xong toàn bộ các mục của Phase 2: Codex adapter, review agent chéo, scheduler theo capability + reassign, planner hỗ trợ, shared knowledge base, CI gate + re-validate, thông báo, OpenTelemetry, validation trong container + agy unattended. Mỗi mục đều có ADR, test, và đã chạy thật trên `mar-sandbox` (riêng validation trong container được chạy thật sau, ở LP-39).

## Phase 3

Thứ tự đã thực hiện: (1) cost & quota → (2) agent performance + chọn agent theo kết quả thực tế → (3) self-healing → (4) planner tự động + multi-agent debate → (5) tự động ưu tiên lại task → (6) human as executor (§61) → (7) multi-org + agent marketplace.

### Cost · quota · budget — trạng thái ✅ ([ADR-0019](adr/0019-cost-and-quota.md))

- [x] Ghi token và cost cho mỗi execution: lấy cost agent báo, nếu không có thì ước tính từ `pricing` trong config runner
- [x] Agent hết quota sẽ cooldown trên runner đó, với thời gian đọc từ thông báo lỗi; task auto route sang agent khác hoặc chờ; người có thể gỡ cooldown sớm
- [x] `maxConcurrent` theo agent; budget theo project (`dailyUsd`: task chờ, `perTaskUsd`: task bị BLOCKED); thông báo `budget` và `quota`
- [x] `GET /projects/:id/costs`, tab Costs, cột cost và trạng thái cooldown trên trang Agents
- [x] **Chạy thật** trên `mar-sandbox`:
  - Claude báo cost của nó ($0,32). Codex được ước tính từ pricing (89.743 input + 1.110 output token ≈ $0,12, hiển thị kèm ≈).
  - Hạ budget ngày xuống $0,30 thì task mới đứng ở READY, `BudgetExceeded` được ghi đúng một lần và thông báo được gửi.
  - Notifier không gửi lại event cũ hơn 60 phút khi được bật lại.
- [ ] Cooldown do quota mới được kiểm bằng test; trong lúc chạy thật không có agent nào hết quota

### Agent performance · chọn agent theo kết quả thực tế — trạng thái ✅ ([ADR-0020](adr/0020-agent-performance-routing.md))

- [x] Chỉ số §40: validation pass, review rejects, cần người, task merged/blocked, cùng các chỉ số runs/rework/thời gian/cost đã có; thống kê theo skill (`/agents/skill-stats`)
- [x] Router dùng reliability theo skill (kéo về tỉ lệ tổng), trừ điểm theo rework và lần cần người; policy `speed`; `PUT /projects/:id/routing-policy`
- [x] UI: bảng Track record mở rộng, bảng By skill
- [x] **Chạy thật**: trên lịch sử thật của project LP, task `auto` cần javascript+backend được giao cho Codex với lý do "reliability 94% (8/8 runs; 2/2 on javascript, backend) … avg 73s"

### Self-healing — trạng thái ✅ ([ADR-0021](adr/0021-self-healing.md))

- [x] Theo dõi CI của base sau mỗi merge (`commitChecks`): `MainHealthy` / `MainBroken`; policy `onBrokenMain`: notify, revert (mở PR revert qua `revertPullRequest` của GitHub, người merge), hoặc fix (tạo task fix-forward kèm lỗi CI)
- [x] Escalate việc bị kẹt (`TaskStuck`) kèm lý do: không runner nào nhận, agent đang cooldown, hết budget, chờ người, chờ review
- [x] Workspace hỏng thì tạo lại worktree, nếu vẫn lỗi thì tạo lại clone; mất session thì bắt đầu session mới (`SessionDiscarded`)
- [x] **Diễn tập thật** trên `mar-sandbox`:
  - Gắn một status lỗi giả lập lên merge commit của LP-19, với policy revert. Platform ghi `MainBroken` và mở PR revert #28 qua GitHub (đã đóng PR, không merge, vì `main` không hỏng thật). Các task merge khác được ghi `MainHealthy`.
  - Task cho agent `gemini` (không runner nào có) bị escalate sau 1 phút với lý do "no online runner offers gemini".
  - Cả hai đều có thông báo.

### Planner tự động · multi-agent debate — trạng thái ✅ ([ADR-0022](adr/0022-plan-debate-and-autonomy.md))

- [x] Critic agent (khác planner) chạy read-only, critique plan theo `CRITIQUE_SCHEMA`; `revise` dẫn đến vòng sửa mới (tối đa `maxRounds`); critic bỏ cuộc thì người quyết định
- [x] Tự duyệt (opt-in): critic approve, không có blocker, tối đa `maxAutoTasks` task, mọi task có agent online nhận được; nếu không thì ghi lý do và để người duyệt
- [x] UI: trạng thái critic reviewing, phần Critique, form cài đặt planning
- [x] **Chạy thật** trên `mar-sandbox`: từ goal "CSV tổng hợp refund theo lý do", Claude lập plan 1 task; Codex critique (approve, 0 issue); plan tự duyệt bởi `platform`; Codex làm LP-23 và tạo PR #29. Từ goal đến lúc PR được mở, không bước nào cần người. Người chỉ review code trước khi merge.

### Tự động ưu tiên lại task — trạng thái ✅ ([ADR-0023](adr/0023-automatic-reprioritization.md))

- [x] `priority` cho mỗi task (do người đặt); scheduler sắp theo priority, cộng thêm theo số task đang chờ nó (trực tiếp hoặc gián tiếp), thời gian chờ, và loại việc gỡ chặn (review, critique, plan)
- [x] `GET /projects/:id/queue` kèm lý do; board xếp cột Ready theo thứ tự đó; chỉnh priority ngay trên trang task

### Human as executor — trạng thái ✅ ([ADR-0024](adr/0024-human-as-executor.md))

- [x] Agent báo `openQuestions` → task chờ người (`decisions`) → người trả lời → agent resume session kèm `DECISIONS.md`
- [x] Executor `human` (được dành riêng, không runner nào có): task cho người nằm trong Inbox; khi xong, summary trở thành handoff cho các task phụ thuộc; planner có thể giao việc cho `human`
- [x] UI Inbox (câu hỏi, task cho người, approval); thông báo
- [x] **Chạy thật** (LP-28, PR #30): với task "áp dụng refund window của công ty", Claude không tự đoán mà hỏi: độ dài window là bao nhiêu, và có tính ngày cuối không (kèm 4 option). Câu hỏi được trả lời bằng một click trong Inbox. Claude resume đúng session và làm đúng câu trả lời (30 ngày, ngày thứ 30 vẫn được refund).
- [x] Trong lần chạy đó, Claude chạm giới hạn session thật, và lộ ra 4 lỗi của phần quota, đều đã sửa (xem ADR-0019).

### Multi-org · agent marketplace — trạng thái ✅ ([ADR-0025](adr/0025-organizations-and-marketplace.md))

- [x] Org cho project, runner và user (`*` = platform admin); API trả 404 cho tài nguyên của org khác; các danh sách và event được lọc theo org; runner chỉ nhận việc của org mình
- [x] Agent theo project (`allowedAgents`)
- [x] Marketplace: profile có version (adapter, skills, cost, pricing, instructions), publish theo org hoặc public; runner build agent từ `profile`; mọi task của agent nhận `AGENT.md`; thống kê usage; trang Marketplace
- [x] **Chạy thật** trên DB thật, với các user thuộc 2 org: Bob (org globex) không thấy project LP, và GET thẳng vào LP trả 404. Lan publish profile `careful-coder` (Claude kèm quy tắc ghi CHANGELOG). Runner build agent `claude-code` từ profile này (`careful-coder@1`), và Claude làm LP-29 đúng theo quy tắc: tạo `CHANGELOG.md` với mục `## Unreleased`, mỗi dòng bắt đầu bằng `LP-29` (PR #31). Usage của profile ghi 1 lượt chạy, thành công.

## Phase 3 — hoàn tất

Đã xong cả 7 mục: cost và quota, performance kèm chọn agent theo kết quả, self-healing, planner tự động với debate, tự động ưu tiên lại task, human as executor, multi-org và marketplace.

## Hoàn thiện spec (sau Phase 3)

Các phần của spec chưa làm ở Phase 1–3, theo thứ tự ưu tiên: path ownership, policy theo project, điều khiển agent từ console, quản lý secret, các success metric còn thiếu, GitLab, và các việc còn sót.

### Path ownership — trạng thái ✅ ([ADR-0026](adr/0026-path-ownership.md))

- [x] `paths` (file và glob) cho task, do người khai báo hoặc planner đề xuất (sửa được trên trang Plans); critic kiểm tra vùng
- [x] Scheduler không chạy song song hai task có vùng chồng nhau; `blockedBy` trong queue, badge trên board, event `TaskWaitingForPaths`
- [x] Ghi vào vùng của task khác chưa merge thành deny HIGH (cần người duyệt), ở cả hook lẫn audit; `TASK.md` báo vùng cho agent
- [x] **Chạy thật** trên `mar-sandbox`, 3 task:
  - LP-31 chờ LP-30 vì chung `src/payments.js`, còn LP-32 chạy song song.
  - LP-32 ghi vào `src/payments.js` thì bị chặn thành approval. Claude hỏi người thay vì ép ghi.
  - LP-31 chạy sau khi LP-30 merge. Cả 3 PR (#32, #34, #33) đều merge.

### Policy theo project — trạng thái ✅ ([ADR-0027](adr/0027-project-policy.md))

- [x] Rule `command`, `write` và `access` của project với các action allow, approve, deny. `allow` chỉ có tác dụng khi phủ mọi phần bị chặn của call, và không bao giờ gỡ được secret, `.git`, file ngoài worktree hay CRITICAL
- [x] `allowedHosts` cho network; `approveMedium`; vai trò duyệt theo mức rủi ro, và CRITICAL có thể cho owner duyệt (spec §32)
- [x] Áp dụng ở cả hook lẫn audit; `TASK.md` liệt kê rule; tab Policy trên trang project
- [x] **Chạy thật** (LP-33, PR #35):
  - Lệnh curl tới host được phép thì chạy luôn, còn sửa `package.json` thì bị chặn chờ duyệt. Owner duyệt, Claude hoàn tất.
  - Lộ ra một vấn đề: agent vừa bị chặn vừa hỏi lại đúng chuyện đó, nên người phải trả lời hai lần. Đã sửa brief.

### Điều khiển agent từ console — trạng thái ✅ ([ADR-0028](adr/0028-console-controls.md))

- [x] Pause / Resume (state PAUSED): agent đang chạy được dừng qua heartbeat; resume tiếp tục đúng session, và lần chạy bị ngắt không tính là attempt
- [x] Send instruction: giao ở lần chạy sau (`INSTRUCTIONS.md`, nằm đầu prompt); mặc định ngắt agent đang chạy rồi resume ngay với instruction
- [x] Open diff: runner gửi diff của worktree sau mỗi lần chạy, kể cả khi bị ngắt; trang task có Diff, Instructions, Pause/Resume
- [x] **Chạy thật** (LP-34, PR #36):
  - Instruction giữa chừng ("đổi thành `formatMoney`, mã tiền tệ đứng trước"): agent bị dừng sau khoảng 6 giây, rồi resume cùng session và làm theo.
  - Pause: diff lúc pause đúng như instruction. Resume thì task hoàn tất và merge.

### Quản lý secret — trạng thái ✅ ([ADR-0029](adr/0029-secret-management.md))

- [x] Secret của project, gồm hai loại: stored (mã hóa AES-256-GCM bằng `MAR_SECRETS_KEY`) hoặc runner-env (giá trị không rời máy runner); `exposeTo` agent và/hoặc validation; API không bao giờ trả giá trị
- [x] Claim chỉ chứa tên; runner lấy giá trị khi execution còn active (có audit `SecretsIssued`), rồi inject thành biến môi trường cho agent và validation (kể cả trong container)
- [x] Redact ở runner, hook và control plane; policy chặn in secret (HIGH) và tool call chứa giá trị (CRITICAL); bước validation `secret-scan` đưa task về REWORK
- [x] UI: mục Secrets trong tab Policy
- [x] **Chạy thật** (LP-37, PR #38):
  - Codex ghi giá trị secret vào test, `secret-scan` bắt được, task về REWORK và Codex sửa. Validation pass với secret thật (0 test bị skip).
  - Codex từ chối in 4 ký tự đầu của key. Giá trị không xuất hiện ở đâu trong DB.

### Success metrics — trạng thái ✅ ([ADR-0030](adr/0030-success-metrics.md))

- [x] `GET /metrics`: đủ 5 nhóm metric của spec §64 (collaboration, engineering, automation, reliability, platform), mỗi tỉ lệ kèm tử số và mẫu số
- [x] Trang Metrics (chọn project và cửa sổ thời gian; mỗi số có định nghĩa)
- [x] Tính trên dữ liệu thật của LP: các con số khớp với những gì đã xảy ra (19/19 merge, 5/19 cần người, 0/19 tự động hoàn toàn vì mọi PR đều do người review)

### GitLab — trạng thái 🟡 code xong, chưa chạy thật ([ADR-0031](adr/0031-gitlab-provider.md))

- [x] `GitLabProvider` (API v4, gitlab.com hoặc self-hosted, có subgroup): MR, squash merge, note, CI qua commit statuses, behind base, revert qua branch mới
- [x] `RoutingGitProvider`: GitHub và GitLab dùng cùng lúc, chọn theo repo
- [ ] Chạy thật trên một repo GitLab (cần tài khoản và `GITLAB_TOKEN`)

### Các việc còn sót — trạng thái ✅

- [x] **Webhook theo org:** `PUT /orgs/:id/notifications {webhooks, kinds}` (owner của org). Notifier luôn chạy: gửi tới webhook chung của platform và tới webhook của org sở hữu project. API chỉ hiện host của URL webhook
- [x] **Cách ly config của agy:** agent agy chạy với `USERPROFILE`/`HOME` riêng (`<home>/profiles/<agent>`, mặc định bật, tắt bằng `isolateConfig: false`). agy vẫn đăng nhập được vì thông tin đăng nhập không nằm trong `~/.gemini`, nhưng không đọc settings, hook, plugin hay MCP cá nhân. Đã chạy thật (LP-38): agy chạy trong profile riêng và đọc repo bình thường. `ANTIGRAVITY_APP_DATA_DIR` đã thử nhưng làm agy treo nên không dùng
- [x] **Dữ liệu LP-9:** task bị ghi CANCELLED dù PR #21 đã merge (lỗi cancel khi đang MERGING, đã sửa trước đó). Đã sửa thành COMPLETED, có event `TaskStateCorrected` để audit
- [x] **Temporal:** đã đánh giá, chưa dùng ([ADR-0032](adr/0032-temporal-evaluation.md)). Giới hạn chỉ chạy được một instance đã được giải quyết bằng leader election (xem bên dưới)

### Qoder CLI adapter — trạng thái ✅ ([ADR-0035](adr/0035-qoder-adapter.md))

- [x] Spike qodercli 1.1.65: stream-json giống Claude, PreToolUse hook giống Claude; hook qua `--settings` bị bỏ khi giới hạn `--setting-sources` nên đặt vào `.qoder/settings.local.json` của worktree
- [x] `@mar/adapter-qoder`: danh sách tool cho phép (read-only khi review/plan), schema qua `--append-system-prompt` + parse JSON, lời gọi bị hook/prompt chặn thành `permission_denied`, bỏ cost/usage bằng 0 (Qoder tính credit)
- [x] Runner config `adapter: "qoder"` (`executable`, `tools`), Marketplace có adapter `qoder`
- [x] **Chạy thật** trên `mar-sandbox`: QD-1 (PR #47) hook kiểm tra mọi lời gọi, handoff đủ criteria, validation pass; QR-1 (PR #48) rework khi base đổi rồi merge; qoder làm planner (read-only, `PLAN_SCHEMA` qua system prompt) ra plan hợp lệ có contract. Agent không review code của chính nó nên vai trò reviewer của qoder chưa chạy thật

### Command Code adapter — trạng thái ✅ ([ADR-0036](adr/0036-command-code-adapter.md))

- [x] Spike Command Code 1.5.0: NDJSON event + result; ở `-p` muốn ghi file hay chạy lệnh phải có `--yolo`; hook `deny` vẫn chặn được khi có `--yolo`; hook lỗi thì tool vẫn chạy nếu không bật `failClosed`; env của hook bị lọc theo tên (`TOKEN`, `SECRET`, `API_KEY`…)
- [x] `@mar/adapter-command-code`: `--yolo` chỉ khi có policy hook, `plan` mode cho read-only, hook `failClosed` + `tasteLearning: false` trong `.commandcode/settings.local.json`, `MAR_HOOK_CONTEXT` để hook nhận lại execution token và secret
- [x] Policy: `shell_command` (shell), `write_file` (ghi)
- [x] Runner: sửa JSON bằng một lượt resume khi câu trả lời có cấu trúc không đọc được (adapter có `promptedSchema`: Qoder, Command Code); core cân bằng ngoặc khi parse
- [x] **Chạy thật** trên `mar-sandbox`: CC-1 lộ lỗi env bị lọc (hook từ chối mọi lời gọi, task an toàn chuyển sang chờ người); CC-2 (PR #50) hook kiểm tra cả 10 lời gọi, criteria đủ, validation pass; planner chạy read-only lộ ra ba lỗi: plan mode tự từ chối bị tính là policy deny nên task chờ người mà Inbox trống; JSON thiếu `]`; có lần trả lại chính schema. Sau khi sửa (bỏ qua lời từ chối của chính CLI, cân bằng ngoặc, kiểm tra trường required, mục "Stopped, nothing to approve" trong Inbox), planner ra plan hợp lệ với 5 tiêu chí

### Chạy end-to-end đủ tính năng trên GitHub — trạng thái ✅

Cấu hình LP: review chéo do agent, agent duyệt là merge; Codex làm critic, plan tự duyệt; budget; validation trong container; CI gate.

- Goal "refund report": Claude lập plan 3 task, Codex critique (approve), plan tự duyệt trong khoảng 2 phút.
- Planner nhận ra payment chưa có currency, nên giao T1 cho **người** để quyết. Người trả lời một lần trong Inbox.
- Codex làm LP-43 và LP-44 (chạy lần lượt vì chung path và có dependency). Claude review chéo cả hai (approve), agent duyệt nên tự merge, CI xanh. Kết quả là PR #40 và #41, không cần người review.
- Kiểm tra trên `main`: 148/149 test pass (test còn lại skip vì CI không có secret). `summarizeRefunds()` và `formatRefundSummary()` cho ra đúng như quyết định của T1.
- Lần chạy này lộ ra và đã sửa 3 vấn đề:
  - metric "autonomous" coi review của agent là review của người, và tính cả task do người làm;
  - planner bảo người ghi câu trả lời vào `DECISIONS.md` (đúng ra là handoff), và khai `paths` cho task của người; `checkPlan` giờ bỏ các path đó;
  - timeline của UI hiện tên thô cho các event mới, và layout tab Policy bị vỡ.


### Scale ngang: leader election — trạng thái ✅ ([ADR-0033](adr/0033-leader-election.md))

- [x] Advisory lock trên Postgres (kết nối riêng, kiểm tra mỗi lượt): chỉ leader chạy sweep, merge queue, self-healing, escalation và thông báo; mọi instance phục vụ API
- [x] `/health` trả `role: leader | standby`; `migrate()` an toàn khi nhiều instance khởi động cùng lúc
- [x] Test trên Postgres thật (container): chuyển giao lock, failover, hai control plane chỉ gửi webhook một lần, ba instance cùng migrate một DB
- [x] **Chạy thật** với hai control plane trên một Postgres (HA-1, PR #42): giết leader thì standby lên thay trong chưa tới 8 giây, rồi merge PR; leader cũ khởi động lại thì về standby; tổng cộng chỉ có một thông báo


### Collaboration contract §62–63 — trạng thái ✅ ([ADR-0034](adr/0034-collaboration-contract.md))

- [x] Task có `inputs`, `constraints`, `expectedOutput`, `acceptanceCriteria` và `owner`; planner sinh, critic kiểm tra, người sửa được
- [x] Agent báo từng tiêu chí trong handoff; reviewer chấm từng tiêu chí; approve mà còn tiêu chí chưa đạt thì bị ép thành request_changes
- [x] Brief review có các quyết định của người (ghi đè contract); PR có checklist; UI có mục Contract
- [x] **Chạy thật:**
  - Một plan sinh 9 tiêu chí, được chấm 9/9 và merge (PR #43).
  - Một tiêu chí mâu thuẫn với ràng buộc thì bị chặn, không merge.
  - Sau khi sửa: agent hỏi owner, owner gỡ ràng buộc, rồi task merge (PR #46).

## Rủi ro đang theo dõi

| Rủi ro | Giảm thiểu |
|---|---|
| CLI thay đổi format output | Test dựa trên fixture, pin phiên bản CLI, contract test chạy hằng đêm với CLI thật |
| agy headless không cho phép chạy lệnh shell (upstream #548/#619) | ADR-0004: Runner chạy build/test thay agent; ADR-0018: chế độ unattended (`--sandbox`) opt-in theo runner, luôn có policy hook |
| Config cá nhân lọt vào lượt chạy (hook, plugin) | Claude: `--setting-sources project,local --strict-mcp-config`; Codex: `--ignore-user-config`; agy: profile riêng theo agent (`isolateConfig`) |
| Merge conflict khi chạy song song | Path ownership + merge queue |
| Quota subscription | Theo dõi `rate_limit_event` (Claude); scheduler giới hạn concurrency theo agent |
