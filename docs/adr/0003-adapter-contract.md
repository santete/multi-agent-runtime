# ADR-0003: Adapter contract = build command + parse stream

- Status: Accepted
- Date: 2026-09-29

## Context

Spec §16/§58 định nghĩa adapter với `pause/resume/sendTask/...` như thể agent là một service chạy lâu dài. Thực tế (xem `docs/spikes/adapter-capability-matrix.md`) mỗi lượt chạy của CLI là một process headless: nhận prompt, stream NDJSON, rồi thoát, và có session id để resume.

## Decision

`AgentAdapter` (`packages/core/src/adapter.ts`):

- `capabilities` khai báo `pause: native|checkpoint|none`, `resume`, `approval`, `structuredOutput`, `costReporting`.
- `buildCommand(AgentRunRequest) → CommandSpec` là hàm thuần. Adapter không tự spawn process.
- `createParser().push(line) → AgentEvent[]` chuẩn hóa output về `session_started | message | tool_call | tool_result | permission_denied | usage | diagnostic | completed | failed`.
- Runner quản lý vòng đời process (spawn, timeout, kill). `pause` = dừng ở ranh giới lượt, `resume` = chạy lại với `resumeSessionId`.
- `completed.success` chỉ đúng khi CLI báo thành công **và** không có action nào bị từ chối. Lý do: agy trả `status: SUCCESS` ngay cả khi mọi lệnh bị từ chối.

## Consequences

- Adapter test được hoàn toàn bằng fixture ghi lại từ lượt chạy thật, không cần gọi model.
- Thêm agent mới chỉ cần thêm package `adapter-*`, không phải sửa core (NFR Extensibility §55).
