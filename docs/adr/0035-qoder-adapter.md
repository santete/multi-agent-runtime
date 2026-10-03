# ADR-0035: Qoder CLI adapter

- Status: Accepted
- Date: 2026-10-03

## Context

Qoder CLI (`qodercli`) là agent CLI thứ tư cần chạy trong platform. Spike trên qodercli 1.1.65 (Windows 11, xem [adapter capability matrix](../spikes/adapter-capability-matrix.md), mục Qoder) cho thấy nó đi theo giao diện của Claude Code:

- `-p --output-format stream-json` sinh cùng loại NDJSON (`system/init`, `assistant`, `user`, `result`) và cùng dạng content block.
- PreToolUse hook có cùng payload (`tool_name`, `tool_input`) và cùng câu trả lời (`hookSpecificOutput.permissionDecision`).
- Ở headless, lệnh shell không read-only bị từ chối nếu không có hook. Hook `allow` mở được lệnh đó, hook `deny` chặn được.

Những điểm khác:

1. Hook truyền qua `--settings` chỉ được nạp khi **mọi** nguồn setting được bật. Log ghi: "Flag hooks skipped: not in --setting-sources". `--setting-sources` chỉ nhận `user, project, local`, nên muốn có hook qua flag thì phải nạp cả setting cá nhân của user (hook, plugin).
2. Không có `--json-schema`.
3. Không có permission mode `plan`. Các mode có: `default, accept_edits, bypass_permissions, dont_ask, auto`.
4. `permission_denials` trong `result` luôn rỗng. Lời gọi bị hook chặn hoặc bị prompt quyền từ chối chỉ hiện thành `tool_result` lỗi.
5. Usage được tính bằng credit của Qoder. `total_cost_usd` và số token luôn bằng 0.
6. Có thêm nhiều tool built-in (Cron, ScheduleWakeup, Monitor, EnterWorktree, Workflow, ImageGen, VideoGen…). Các tool này không hợp với một lượt chạy được điều phối.

## Decision

Package `@mar/adapter-qoder`, `id = "qoder"`, capability giống Claude (`pre-tool-hook`, resume, structured output), riêng `costReporting: false`.

- **Command:** `qodercli -p --output-format stream-json --setting-sources project,local --strict-mcp-config --permission-mode <mode> --tools <list>`. Prompt đi qua stdin, `--resume <session>`, `--model`.
- **Policy hook:** ghi vào `.qoder/settings.local.json` trong worktree (`workspaceFiles`, merge JSON, dialect `claude`). Đây là nguồn `local` nên vẫn giữ được `project,local`, và setting cá nhân không lọt vào. Runner đã sẵn cơ chế thêm file vào `info/exclude` và khôi phục nếu file đó được track.
- **Tool:** dùng danh sách cho phép thay vì danh sách chặn, để tool mới ở bản sau không tự xuất hiện.
  - Edit: `Read, Write, Edit, Glob, Grep, Bash, NotebookEdit, WebFetch, WebSearch, TaskCreate/Get/List/Update`. Đổi được bằng `tools` trong runner config.
  - Read-only (review, planner, critic): `Read, Glob, Grep, WebFetch, WebSearch` với mode `default`. Không có tool nào ghi file hay chạy lệnh, thay cho `plan` mode mà qoder không có.
- **Structured output:** schema được đưa vào `--append-system-prompt` ("final message must be only a JSON object…"). Parser đọc JSON từ câu trả lời cuối bằng `parseJsonAnswer` của core, dạng nguyên văn hoặc trong code fence. Nếu không đọc được, giữ nguyên text, và handoff fallback như các agent không có schema.
- **Parser:** bọc `ClaudeStreamParser`. Một `tool_result` lỗi có `hook blocking error` hoặc `Error: Allow <Tool> to …` thành `permission_denied`, kèm lý do từ hook (`[RISK] …`) nếu có. Run có lời gọi bị từ chối thì không được tính là success (ADR-0003). `costUsd` bằng 0 và usage toàn số 0 bị bỏ, để metrics không ghi chi phí 0 sai.

## Consequences

- Đã chạy thật trên `mar-sandbox` (QD-1, PR #47): hook kiểm tra mọi lời gọi (Read, Edit, Glob, Bash `npm test`), handoff có cấu trúc, đủ acceptance criteria, validation pass, PR có checklist.
- Chi phí không ước tính được từ token. Nếu cần budget theo tiền, phải đặt `pricing` trong runner config, nhưng hiện token = 0 nên ước tính cũng bằng 0. Budget theo USD không áp dụng được cho agent qoder.
- Chưa dùng sub-agent (`Agent`) vì chưa kiểm chứng hook có chạy cho lời gọi bên trong sub-agent hay không.
- Hook command có dấu nháy được qoder chạy qua Git Bash trên Windows và hoạt động với đường dẫn có backslash. Máy không có Git Bash thì chưa thử.
- Lỗi do hook chặn hiện cả command line của hook (đường dẫn runner) cho agent thấy. Không có bí mật trong đó.
