# ADR-0004: Thực thi policy ở ranh giới tài nguyên + PreToolUse hook

- Status: Accepted (cập nhật 2026-09-30 sau khi triển khai M2 và chạy thật với Claude Code và agy)
- Date: 2026-09-29

## Context

Approval Gateway (§31) chỉ chặn được action nếu agent có hook. Claude Code và agy đều có PreToolUse hook. Tuy vậy ở headless, agy chỉ tôn trọng `deny`. `allow` và allow-rule tĩnh bị bỏ qua (upstream #548/#619), nên muốn agy chạy lệnh shell thì phải bật `--dangerously-skip-permissions`.

## Decision

Chia thành ba lớp:

1. **Ranh giới tài nguyên (bắt buộc, không phụ thuộc agent):** agent không có credential push hay merge. Chỉ platform push branch, mở PR và merge. Mỗi task chạy trong worktree riêng. Build/test/validation do Runner chạy, không phải agent.
2. **PreToolUse hook của platform, inject theo từng task.** Hook chung là `apps/runner/hook/mar-policy-hook.mjs` (JS thuần, không dependency). Hook gọi `POST /executions/:id/tool-check` trên control plane bằng **execution token** chỉ có hiệu lực cho execution đó (không dùng API token). Control plane đánh giá policy (`packages/core/src/policy.ts`) và ghi event `ToolCallChecked` cho **mọi** quyết định. Hook **fail-closed**: nếu lỗi mạng, thiếu biến môi trường hoặc gặp dialect lạ thì trả `deny`.
   - Claude: `--settings '{"hooks":{"PreToolUse":[...]}}'` + `--setting-sources project,local`. Hook `allow` mở được cả lệnh shell ở headless. Trên Windows, Claude chạy lệnh qua tool `PowerShell`, nên policy coi `Bash`, `PowerShell`, `run_command` đều là shell.
   - agy: Runner ghi `<worktree>/.agents/hooks.json` (merge theo tên `mar-policy`, thêm vào `info/exclude` nếu file không được git theo dõi). **Trên Windows**, agy chạy hook qua `cmd /c` và escape dấu nháy thành `\"`, làm hỏng mọi đường dẫn có nháy (ví dụ `C:\Program Files\...`). Vì vậy lệnh hook là `%MAR_POLICY_HOOK%`, không có nháy: `cmd` expand biến (đặt trong env của agent) trước khi parse, nên dấu nháy trong giá trị biến giữ nguyên.
3. **Audit của control plane là nguồn sự thật:** execution có bất kỳ `ToolCallChecked` nào bị `deny` thì luôn thành `needs_approval` và task sang `WAITING_FOR_HUMAN`, bất kể agent tự báo gì. Lý do: agy báo `status: SUCCESS` ngay cả khi mọi tool bị chặn. Parser của agy cũng tính tool error có chữ "hook" là action bị từ chối.

Chưa có approval gateway (M4), nên mức HIGH/CRITICAL hiện là `deny`, còn LOW/MEDIUM là `allow`.

Với agy, trong lúc chờ upstream sửa:
- Mặc định **không** dùng `--dangerously-skip-permissions`. Lệnh shell đã được hook cho phép vẫn bị tầng quyền của agy chặn, báo qua `denied_actions`, và task chuyển sang `WAITING_FOR_HUMAN`. Build/test do Runner chạy ở bước Validation (M3).
- (Chưa triển khai) Project policy có thể bật `agy.unattendedShell = true`. Khi đó Runner chạy agy với `--sandbox --dangerously-skip-permissions`, và hook deny-by-default là lớp policy duy nhất. Việc bật cần owner đồng ý rõ ràng và được audit.

## Consequences

- Hành động rủi ro cao nhất (push, merge, secret) được bảo vệ kể cả khi agent bypass hook.
- Mọi tool call của Claude và agy đều nằm trong event log, xem được theo task hoặc execution.
- Execution token nằm trong env của agent, nên agent có thể tự gọi `tool-check`. Việc này vô hại (endpoint chỉ trả verdict và ghi audit), nhưng có thể làm nhiễu log.
- Ở MVP, agy phù hợp nhất cho task edit và phân tích. Khi bug upstream được sửa thì bỏ nhánh workaround này.
- Nếu merge vào `hooks.json` đã được git theo dõi, M3 phải hoàn tác file đó trước khi commit (runner đã báo qua diagnostic `modifiedTracked`).
