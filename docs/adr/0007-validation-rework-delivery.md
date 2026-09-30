# ADR-0007: Context, validation, rework và delivery

- Status: Accepted
- Date: 2026-09-30

## Context

Spec §28–29 và §33 yêu cầu: agent báo "xong" chưa phải là xong. Kết quả phải được validate, fail thì tự rework, pass thì commit, push và mở merge request. Spec §22 và §62 yêu cầu handoff có cấu trúc giữa các agent.

## Decision

**Context cho agent.** Runner ghi `.orchestrator/context/TASK.md` (objective, luật: không commit/push, danh sách validation sẽ chạy, yêu cầu handoff) vào worktree, và thêm `REWORK.md` (output của bước fail) khi đây là lần rework. Hai file này được git-exclude. Prompt chỉ gồm objective kèm chỉ dẫn đọc các file đó. Agent không phải LLM (`generic-cli`) dùng placeholder `{objective}` để nhận objective thô.

**Handoff artifact.** Adapter có structured output (Claude, agy) chạy với `--json-schema` = `HANDOFF_SCHEMA` (`summary`, `changes`, `decisions`, `knownIssues`, `remainingWork`). Control plane lưu kết quả thành artifact `handoff` (`toHandoff` vẫn tạo được handoff khi agent trả text thường). Cả hai CLI đều trả field `structured_output`.

**Các pha của execution** (một lease và heartbeat liên tục phủ cả quá trình):

```text
assigned → running → validating → delivering → succeeded
                        │               └─ failed (push lỗi, task giữ REVIEW)
                        └─ failed (validation fail → task REWORK)
```

- `validating`: runner chạy các `project.validation` (lệnh shell, chạy tuần tự, dừng ở bước fail đầu tiên, có timeout, không truyền biến `MAR_*`) trong worktree rồi gửi `POST /executions/:id/validation`. Kết quả lưu thành artifact `validation_result`.
- Pass: task `VALIDATING → REVIEW`, control plane trả `deliver: true`.
- Fail: task `VALIDATING → REWORK`. Sweep đưa task về `READY` (tối đa `maxAttempts`, quá thì `BLOCKED`). Lần claim sau trả `rework` (lý do, kết quả validation) và `resume` (session cũ), nên agent sửa tiếp trên chính session và worktree đó.
- `delivering`: runner khôi phục các file tracked mà nó đã sửa để dùng riêng, rồi `git add -A`, commit (author `multi-agent-runtime`, `--no-verify`) và push `task/<KEY>`. Sau đó gửi `POST /executions/:id/delivery`. Agent không bao giờ được push (policy chặn `git push`), nên runner (thuộc platform) là bên duy nhất push.
- **Control plane** mở PR qua `GitProvider` (`GitHubProvider`, token `GITHUB_TOKEN`). Nội dung PR gồm objective, handoff, bảng validation và danh sách file thay đổi. Nếu PR của branch đó đã tồn tại (tái delivery sau rework) thì dùng lại PR cũ.

**Mất runner:** khi đang `validating` thì task sang `RETRYING` (làm lại, resume session). Khi đang `delivering` thì ghi event `DeliveryLost` và giữ task ở `REVIEW` để người xử lý, vì không nên làm lại phần việc đã validate xong.

## Consequences

- Đã kiểm chứng với Claude Code thật trên repo private `santete/mar-sandbox`: validation `npm test` pass, push, và PR #1, #2 được mở tự động với handoff đầy đủ.
- Lệnh validation do project định nghĩa và chạy trên máy runner, giống job CI. Chủ runner phải tin cấu hình project.
- Chưa có merge và merge queue (M4). Task đang dừng ở `REVIEW`, và các task độc lập được tách nhánh từ `main` hiện tại nên chưa thấy được thay đổi của nhau cho tới khi merge.
