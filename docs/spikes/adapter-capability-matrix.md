# Adapter Capability Matrix (Phase 0 spike)

Ngày spike: 2026-09-29 · Máy: Windows 11 · Kết quả ghi lại ở `packages/adapter-*/test/fixtures/`.

| Khả năng | Claude Code CLI 2.1.284 | Antigravity CLI (`agy`) 1.2.13 | Codex CLI |
|---|---|---|---|
| Headless | `claude -p` (prompt qua stdin) | `agy -p "<prompt>"` | `codex exec -` (prompt qua stdin) — xem mục Codex bên dưới |
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
| Hook `deny` ở headless | ✅ Lệnh bị chặn xuất hiện trong `permission_denials` | ✅ Chặn cứng, agent nhận `reason`; tool error `tool call denied by pre-tool hook: …` (**không** nằm trong `denied_actions`) | |
| Hook `allow` ở headless | ✅ Mở được cả lệnh shell | ❌ Không mở được lệnh shell (bug upstream [#548](https://github.com/google-antigravity/antigravity-cli/issues/548), [#619](https://github.com/google-antigravity/antigravity-cli/issues/619)) | |
| Hook nhận env của agent | ✅ | ✅ | |
| Cách chạy lệnh hook (Windows) | Giữ nguyên dấu nháy | `cmd /c` với nháy bị escape thành `\"`, nên đường dẫn có nháy hỏng. Dùng lệnh `%MAR_POLICY_HOOK%` (biến env) | |
| Tên tool shell (Windows) | `PowerShell` (đôi khi `Bash`) | `run_command` | |
| Binary trên Windows | `claude.cmd` (npm shim) → `bin\claude.exe` | `%LOCALAPPDATA%\agy\bin\agy.exe` (không có trên PATH) | |
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
- ~~Claude: hook PreToolUse inject qua `--settings` chạy ở headless~~ → đã kiểm chứng ở M2.

## Codex CLI 0.159.2 (spike 2026-09-30, Windows 11) — [ADR-0010](../adr/0010-codex-adapter.md)

| Khả năng | Codex |
|---|---|
| Headless | `codex exec --json -` (JSONL: `thread.started`, `turn.started`, `item.started/completed`, `turn.completed`, `turn.failed`) |
| Item types | `agent_message`, `command_execution` (command, aggregated_output, exit_code, status), `file_change` (changes[path, kind]), `mcp_tool_call`, `error` |
| Session / resume | `thread_id`; `codex exec resume <id> -` ✅ (nhớ được ngữ cảnh) |
| Structured output | `--output-schema <file>`; message cuối là JSON đúng schema |
| Cách ly config | `--ignore-user-config` — **trên Windows phải kèm `-c windows.sandbox="elevated"`**, nếu không mọi lệnh bị từ chối mà exit vẫn 0 (openai/codex#42172) |
| Sandbox | `sandbox_mode="workspace-write"`: ghi chỉ trong workspace, **không có mạng** (curl → 000) |
| PreToolUse hook | Định dạng giống Claude Code (`hookSpecificOutput.permissionDecision`), matcher là **regex**, cần trust (`--dangerously-bypass-hook-trust`) — **không được gọi cho lệnh shell trên Windows** (openai/codex#24453); hook lỗi → fail-open |
| Cost | Chỉ token (input, cached, output, reasoning), không có USD |
| Auth | Đăng nhập ChatGPT (`codex login`) hoặc API key |
| Binary trên Windows | `codex.cmd` (npm shim) → `node .../@openai/codex/bin/codex.js` |

## Qoder CLI 1.1.65 (spike 2026-10-03, Windows 11) — [ADR-0035](../adr/0035-qoder-adapter.md)

| Khả năng | Qoder (`qodercli`) |
|---|---|
| Headless | `qodercli -p` (prompt qua stdin), `--output-format stream-json` (NDJSON giống Claude: `system/init`, `assistant`, `user`, `result`; thêm `system/hook_*`, `artifacts_update`) |
| Session / resume | `session_id`; `--resume <id>` |
| Auto-apply edit | `--permission-mode accept_edits` |
| Read-only | Không có `plan` mode → `--permission-mode default` + `--tools Read,Glob,Grep,WebFetch,WebSearch` |
| Giới hạn tool | `--tools a,b,c` (thay đổi danh sách tool trong `init`) |
| Structured output | Không có `--json-schema` → schema qua `--append-system-prompt`, parse JSON từ câu trả lời cuối |
| Cost / usage | `total_credits`, `credits` theo message; `total_cost_usd` và token luôn = 0 |
| Báo action bị từ chối | `permission_denials` luôn rỗng; đọc từ `tool_result` lỗi: `… hook blocking error from command: "…": <reason>` hoặc `Error: Allow Bash to run: <cmd>?` |
| Pre-tool policy hook | PreToolUse giống Claude (`tool_name`, `tool_input` → `hookSpecificOutput.permissionDecision`). Qua `--settings` chỉ khi **không** giới hạn `--setting-sources` ("Flag hooks skipped: not in --setting-sources"); qua `.qoder/settings.local.json` trong workspace thì chạy với `project,local` |
| Hook `deny` / `allow` ở headless | ✅ / ✅ (allow mở được lệnh shell ghi file) |
| Lệnh shell không hook | read-only (`git status`) tự cho phép; lệnh khác bị từ chối ở headless |
| Hook nhận env của agent | ✅ |
| Cách chạy lệnh hook (Windows) | qua Git Bash, dấu nháy giữ nguyên |
| Cách ly config của user | `--setting-sources project,local --strict-mcp-config`; plugin hệ thống (security-scan, code tracking) vẫn chạy |
| Binary trên Windows | `~/.qoder/bin/qodercli/qodercli.exe` (PATH của user) |
| Auth | Đăng nhập trình duyệt (`qodercli login`), lưu ở `~/.qoder/.auth` |
| Model | `--model` (tên tier: `efficient`, `performance`, `auto`…; `--list-models`) |

## Command Code 1.5.0 (spike 2026-10-05, Windows 11) — [ADR-0036](../adr/0036-command-code-adapter.md)

| Khả năng | Command Code (`command-code`) |
|---|---|
| Headless | `command-code -p --output-format json` (prompt qua stdin). NDJSON: `{"type":"event","event":{…}}` rồi một dòng `{"type":"result",…}` |
| Event chính | `run_start` (sessionId), `message_end` (content text), `tool_queued` (toolCallId, toolName, input), `tool_completed` (result), `tool_errored`, `tool_hook_blocked` (hookOutput), `tool_denied`, `run_error`, `notice`; nhiều `*_delta` |
| Kết quả | `result.subtype`: `success`, `error`, `max_turns`; `finalText`, `usage` (token), `durationMs` |
| Resume | ✅ `--resume <sessionId>` |
| Quyền ở `-p` | Ghi file và chạy lệnh **luôn bị chặn** nếu không có `--yolo`, kể cả với `auto-accept` hay hook `allow` |
| Read-only | `--permission-mode plan` (chỉ có tool đọc) |
| Structured output | Không có `--json-schema`, không có system prompt cho `-p` → schema nối vào prompt |
| Pre-tool policy hook | PreToolUse giống Claude, trong `.commandcode/settings.local.json` / `settings.json` / `~/.commandcode/settings.json`; chạy cả khi chưa trust project |
| Hook `deny` dưới `--yolo` | ✅ chặn được |
| Hook lỗi hoặc timeout | **Cho chạy tiếp**, trừ khi hook có `"failClosed": true` |
| Hook nhận env của agent | ⚠️ Trừ các biến có tên khớp `TOKEN`, `SECRET`, `API_KEY`, `PASSWORD`, `AUTH`… |
| Tên tool | `read_file`, `read_multiple_files`, `read_directory`, `write_file`, `edit_file`, `shell_command`, `web_fetch`, `web_search` |
| Cách ly config của user | Không có flag; hook trong `~/.commandcode/settings.json` vẫn được nạp |
| Taste learning | Bật mặc định; tắt cho project bằng `tasteLearning: false` trong `settings.local.json` (`--config` ghi hẳn vào settings) |
| Binary trên Windows | npm shim `command-code.cmd` (cũng có `cmd`, nhưng trùng `cmd.exe`) |
| Auth | `command-code login`, lưu ở `~/.commandcode/auth.json`; hoặc `COMMAND_CODE_API_KEY` |
| Cost / usage | Token, không có USD |
