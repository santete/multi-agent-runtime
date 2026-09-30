# ADR-0010: Codex adapter — sandbox + audit sau khi chạy

- Status: Accepted
- Date: 2026-09-30

## Context

Codex CLI (`@openai/codex` 0.159.2) có `codex exec --json` (JSONL), `--output-schema <file>`, sandbox riêng (`sandbox_mode`), resume (`codex exec resume <id>`) và PreToolUse hook theo đúng định dạng của Claude Code. Spike trên Windows 11 cho thấy:

- `--ignore-user-config` làm mất lựa chọn sandbox Windows, khiến **mọi lệnh bị từ chối** ("blocked by policy") nhưng exit code vẫn là 0 ([openai/codex#42172](https://github.com/openai/codex/issues/42172)). Workaround: `-c windows.sandbox="elevated"`.
- Sandbox `workspace-write` chỉ cho ghi trong workspace và **chặn mạng** (`curl` → 000).
- **PreToolUse hook không được gọi cho lệnh shell trên Windows** ([openai/codex#24453](https://github.com/openai/codex/issues/24453)). Đã thử hook cấp user, cấp project (có trust), override qua `-c`, matcher regex hợp lệ (`matcher` là **regex**: `"*"` không hợp lệ nên bị bỏ qua lặng lẽ). Không cách nào khiến hook chạy.
- Hook lỗi hoặc không chạy được thì Codex vẫn cho tool chạy (fail-open).

## Decision

`CodexAdapter` (`packages/adapter-codex`):
- Lệnh: `codex exec [resume <id>] --json --ignore-user-config -c sandbox_mode="workspace-write|read-only" -c approval_policy="never" [-c windows.sandbox="elevated"] [--output-schema .orchestrator/handoff.schema.json] -`, prompt truyền qua stdin. Runner ghi schema ra file trong worktree (file này được git-exclude).
- Parser: `thread.started` → session; `command_execution` → tool `shell`; `file_change` → tool `apply_patch` (kèm `paths`); `mcp_tool_call` → `mcp__server__tool`; `agent_message` → message (message cuối được parse thành kết quả có cấu trúc); `turn.completed` → completed kèm usage; `turn.failed` → failed.
- Capability **`approval: "sandbox"`** (giá trị mới). Ý nghĩa: agent tự cách ly nhưng không thể chặn từng tool call trước khi chạy.
  1. **Sandbox của Codex** là lớp chặn chính: chỉ ghi trong worktree, không có mạng (nên không `push`/`curl` được).
  2. Runner **vẫn cài policy hook** (`.codex/hooks.json`, matcher `.*`, workspace được đánh dấu trusted, cờ `--dangerously-bypass-hook-trust` chỉ áp cho hook của chính platform), để hook tự có hiệu lực khi upstream sửa lỗi hoặc trên OS mà hook chạy được.
  3. **Control plane audit sau khi chạy**: mỗi `tool_call` của agent có approval `sandbox` được đánh giá bằng policy (có xét các approval đã được duyệt) và ghi thành `ToolCallChecked { audit: true }`. Có vi phạm (ví dụ đọc `.env`, ghi ra ngoài worktree) thì execution kết thúc ở `needs_approval` → `WAITING_FOR_HUMAN` để người xem xét.
- Policy hiểu thêm `apply_patch`: đọc đường dẫn từ nội dung patch (`*** Add/Update/Delete File:`, `*** Move to:`) hoặc từ `paths`.

## Consequences

- Đã kiểm chứng thật trên `mar-sandbox`: DAG **CDX-1 (Codex) → CDX-2 (Claude)**. Codex tạo `src/reasons.js` kèm test (mọi tool call được audit ở mức LOW), trả handoff có cấu trúc, validation pass, PR #10. Claude nhận handoff qua `DEPENDENCIES.md`, dùng hàm Codex viết, PR #11. Cả hai được merge và `main` đạt 47/47 test.
- Trên Windows, với Codex, những hành động mà sandbox **không** chặn (ví dụ đọc secret trong worktree) chỉ bị phát hiện **sau khi đã xảy ra**; không có cơ chế duyệt trước như với Claude. Muốn chặn trước thì phải chờ upstream sửa #24453, hoặc chạy Codex trên Linux/macOS (chưa kiểm chứng).
- Codex không báo chi phí bằng USD, chỉ báo số token.
