# Adapter Capability Matrix (Phase 0 spike)

Ngày spike: 2026-09-29 · Máy: Windows 11 · Kết quả ghi lại ở `packages/adapter-*/test/fixtures/`.

| Khả năng | Claude Code CLI 2.1.284 | Antigravity CLI (`agy`) 1.2.13 | Codex CLI |
|---|---|---|---|
| Headless | `claude -p` (prompt qua stdin) | `agy -p "<prompt>"` | _chưa spike (ưu tiên sau)_ |
| Stream event | `--output-format stream-json --verbose` (NDJSON: `system/init`, `assistant`, `user`, `result`) | `--output-format stream-json` (NDJSON: `init`, `step_update`, `result`) | |
| Session id | `session_id` ở `init` và `result` | `conversation_id` ở `init` và `result` | |
| Resume | ✅ `--resume <session_id>` | ✅ `--conversation <id>` (hoặc `-c` cho lần gần nhất) | |
| Auto-apply edit | `--permission-mode acceptEdits` | `--mode accept-edits` | |
| Read-only | `--permission-mode plan` | `--mode plan` | |
| Structured output | `--json-schema` | `--json-schema` (chuỗi JSON hoặc đường dẫn file) | |
| Timeout | runner tự kill | `--print-timeout <dur>` (mặc định 0 = chờ vô hạn → **luôn đặt**) | |
| Cost / usage | `total_cost_usd`, `usage`, `rate_limit_event` (quota 5h/7d) | `usage` theo từng step (token, không có USD) | |
| Báo action bị từ chối | `permission_denials[]` trong `result` | `denied_actions[]` trong `result` (**status vẫn là `SUCCESS`**) | |
| Pre-tool policy hook | ✅ PreToolUse hook, inject theo từng run qua `--settings <json>` | ✅ PreToolUse trong `<workspace>/.agents/hooks.json` (stdin JSON → `{decision: allow\|deny\|ask}`) | |
| Hook `deny` ở headless | ✅ | ✅ Chặn cứng, agent nhận `reason` | |
| Hook `allow` ở headless | ✅ | ❌ Không mở được lệnh shell (bug upstream [#548](https://github.com/google-antigravity/antigravity-cli/issues/548), [#619](https://github.com/google-antigravity/antigravity-cli/issues/619)) | |
| Allow-rule tĩnh | `permissions.allow` qua `--settings` | `permissions.allow` trong `~/.gemini/antigravity-cli/settings.json` → **bị bỏ qua** ở headless trên Windows (cùng bug) | |
| Cách ly config của user | `--setting-sources project,local --strict-mcp-config` | Chưa có flag tương đương, config dùng chung `~/.gemini/` | |
| Auth | Subscription (OAuth) hoặc API key | Tài khoản Google (keyring) hoặc `GEMINI_API_KEY` | |
| Sandbox có sẵn | permission modes | `--sandbox` (terminal restrictions) | |
| Model | `--model` | `--model` (`agy models`: Gemini 3.x, Claude, GPT-OSS) | |

## Hệ quả cho thiết kế

1. **Không tin vào status "success" mà CLI trả về.** Adapter tính `success = status OK && không có denied action`. Nếu có denied action thì task chuyển sang `WAITING_FOR_HUMAN` (ADR-0003).
2. **Approval dựa trên PreToolUse hook của platform**, được inject theo từng task: Claude qua `--settings`, agy qua `.agents/hooks.json` trong worktree. Hook gọi về Runner. Runner áp dụng policy hoặc hỏi người duyệt.
3. **agy hiện chưa tự chạy được lệnh shell ở headless nếu không bypass.** Trong lúc chờ upstream sửa bug #548/#619, MVP giao cho agy các task **edit và phân tích**. Task cần build/test do Runner tự chạy ở bước Validation, không để agent chạy. Chạy agy với `--dangerously-skip-permissions` (khi đó hook deny là lớp policy duy nhất) chỉ bật được qua project policy và phải chạy trong sandbox (ADR-0004).
4. Hai CLI đều có resume và structured output, nên `pause` được triển khai dạng checkpoint (dừng ở ranh giới lượt rồi resume) cho cả hai.

## Chưa kiểm chứng

- agy: `--json-schema` với lượt chạy thành công (lượt thử bị chặn vì cần lệnh shell).
- agy: `--sandbox` kết hợp `--dangerously-skip-permissions` (cần owner cho phép chạy).
- agy: cách ly config riêng cho từng runner (thử override `USERPROFILE`/`HOME` và giữ auth).
- Claude: hook PreToolUse inject qua `--settings` chạy ở headless (dự kiến spike ở M2).
