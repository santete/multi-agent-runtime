# ADR-0004: Thực thi policy ở ranh giới tài nguyên + PreToolUse hook

- Status: Accepted
- Date: 2026-09-29

## Context

Approval Gateway (§31) chỉ chặn được action nếu agent có hook. Claude Code và agy đều có PreToolUse hook. Tuy vậy ở headless, agy chỉ tôn trọng `deny`. `allow` và allow-rule tĩnh bị bỏ qua (upstream #548/#619), nên muốn agent chạy lệnh shell thì phải bật `--dangerously-skip-permissions`.

## Decision

Chia thành hai lớp:

1. **Ranh giới tài nguyên (bắt buộc, không phụ thuộc agent):** agent không có credential push hay merge. Chỉ platform push branch, mở PR và merge. Mỗi task chạy trong worktree riêng. Build/test/validation do Runner chạy, không phải agent.
2. **PreToolUse hook của platform (inject theo từng task):**
   - Claude: `--settings '{"hooks":{"PreToolUse":[...]}}'` + `--setting-sources project,local`.
   - agy: Runner ghi `<worktree>/.agents/hooks.json` (thêm vào `.git/info/exclude`).
   - Hook gọi về Runner. Runner đánh giá policy theo mức LOW, MEDIUM, HIGH, CRITICAL (§32): mức LOW trả `allow`, các mức cao hơn sinh `ApprovalRequested` và chờ người duyệt.

Với agy, trong lúc chờ upstream sửa:
- Mặc định **không** dùng `--dangerously-skip-permissions`. Lệnh shell sẽ bị báo qua `denied_actions`, task chuyển sang `WAITING_FOR_HUMAN`, và Runner có thể tự chạy lệnh đó hộ nếu policy cho phép.
- Project policy có thể bật `agy.unattendedShell = true`. Khi đó Runner chạy agy với `--sandbox --dangerously-skip-permissions`, và hook deny-by-default là lớp policy duy nhất. Việc bật cần owner đồng ý rõ ràng và được audit.

## Consequences

- Hành động rủi ro cao nhất (push, merge, secret) được bảo vệ kể cả khi agent bypass hook.
- Ở MVP, agy phù hợp nhất cho task edit và phân tích. Khi bug upstream được sửa thì bỏ nhánh workaround này.
