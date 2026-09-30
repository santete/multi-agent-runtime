# ADR-0006: Execution lease, retry tự động và resume session

- Status: Accepted
- Date: 2026-09-30

## Context

Runner có thể chết giữa chừng (máy tắt, process bị kill). Spec §46 và §55 yêu cầu phát hiện lỗi, retry và resume workflow. Claude Code và agy đều resume được session theo id (`--resume`, `--conversation`), nhưng session chỉ nằm trên máy đã chạy nó.

## Decision

- **Lease:** execution có `lease_expires_at` (mặc định 60 giây, `MAR_LEASE_SECONDS`), được đặt khi claim hoặc start và gia hạn qua `POST /executions/:id/heartbeat` (runner gửi mỗi `heartbeatIntervalMs`, mặc định 10 giây).
- **Cancel:** `POST /tasks/:id/cancel` đánh dấu `cancel_requested` trên execution đang chạy. Heartbeat tiếp theo trả `cancel: true`, runner abort và kill cả cây process (`taskkill /T` trên Windows), rồi complete với status `cancelled`.
- **Sweep** (control plane, mặc định mỗi 5 giây, `MAR_SWEEP_INTERVAL_MS`):
  1. Execution `assigned` hoặc `running` quá hạn lease thì thành `lost`, và task chuyển `agent_failed` sang `RETRYING`.
  2. Task `RETRYING`: nếu số attempt nhỏ hơn `maxAttempts` (mặc định 3) thì về `READY`; ngược lại thành `BLOCKED`.
  3. Runner báo complete muộn cho execution đã `lost` thì nhận 409 và bỏ qua.
- **Định danh runner ổn định:** register theo `name` là upsert, cùng tên thì giữ nguyên runner id qua các lần restart.
- **Resume:** claim trả thêm `resume: { sessionId, runnerId }` lấy từ attempt gần nhất có session. Runner chỉ resume nếu `runnerId` trùng với chính nó và adapter có `capabilities.resume`. Prompt khi resume yêu cầu agent kiểm tra lại workspace rồi làm tiếp. Worktree của task được dùng lại.

## Consequences

- Đã kiểm chứng với Claude Code thật: kill cả cây process runner sau tool call đầu tiên, sweep đưa task về `READY` sau khi lease hết hạn, runner restart và resume đúng session. Claude tự kiểm tra `a.md` đã có rồi làm tiếp `b.md` và `c.md`.
- Resume chỉ hoạt động trên cùng máy. Task chuyển sang máy khác thì chạy lại từ đầu trên worktree mới (M3 có thể push branch trung gian để máy khác tiếp tục).
- Sweep và claim dùng `FOR UPDATE SKIP LOCKED`, nên có thể chạy nhiều instance control plane về sau.
