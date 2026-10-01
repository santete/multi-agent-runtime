# ADR-0021: Self-healing — base hỏng sau merge, việc bị kẹt, workspace lỗi, mất session

- Status: Accepted
- Date: 2026-10-01

## Context

Spec §46 liệt kê các cách mà một agent có thể hỏng: crash, timeout, mất session, hết quota, tạo code không build được, bị approval chặn, workspace lỗi. Platform phải có retry, resume, reassign, rollback, escalate và human intervention.

Retry, resume, reassign và quota đã có (ADR-0006, ADR-0012, ADR-0019). Còn thiếu ba thứ:
- **rollback** khi một merge làm hỏng base branch;
- **escalate** việc không còn tiến triển;
- tự phục hồi khi **workspace** hoặc **session** hỏng.

## Decision

**Base branch hỏng sau merge.** `GitProvider.commitChecks(sha)` đọc CI trên commit mà merge queue tạo ra. Mỗi lần sweep, control plane xét các work task đã merge trong 24 giờ qua mà chưa có kết luận:
- Xanh, hoặc không có CI sau thời gian chờ: ghi `MainHealthy`.
- Đỏ: ghi `MainBroken` (sha, các check thất bại, policy), rồi làm theo `onBrokenMain` của project (`PUT /projects/:id/self-healing`):
  - `notify` (mặc định): chỉ báo (thông báo loại `main`).
  - `revert`: mở **PR revert** bằng mutation GraphQL `revertPullRequest` của GitHub, giống nút Revert trên giao diện GitHub (event `RevertOpened` hoặc `RevertFailed`). **Người** là bên merge PR này. Platform không tự rollback `main`.
  - `fix`: tạo task "Fix main after KEY" cho cùng agent (hoặc `auto` nếu task gốc là auto), cùng `requires`. Objective gồm sha, các check thất bại với thông điệp của chúng, và objective gốc (event `FixTaskCreated`).

**Escalate việc bị kẹt** (`MAR_ESCALATE_READY_MINUTES`, mặc định 30; `MAR_ESCALATE_HUMAN_HOURS`, mặc định 8):
- Task `READY` quá N phút, hoặc `WAITING_FOR_HUMAN`/`REVIEW` quá N giờ, sinh event `TaskStuck`. Event này chỉ được ghi một lần cho mỗi lần task vào trạng thái đó, và kèm **lý do**:
  - budget ngày đã hết;
  - không runner online nào có agent đó / có agent đủ skill;
  - mọi agent phù hợp đang cooldown, và giờ sớm nhất có agent trở lại;
  - đang chờ capacity;
  - đang chờ người quyết định N approval / chờ review.
- Thông báo thuộc loại `blocked`.

**Workspace lỗi:**
- Worktree mà git không đọc được nữa (ví dụ file `.git` hỏng) bị coi là hỏng.
- Runner tự sửa theo hai bậc: xóa worktree (`git worktree prune`, xóa branch local) rồi tạo lại; nếu vẫn không được thì xóa luôn clone của project và clone lại.
- Việc đã push không bị mất: worktree mới tiếp tục từ branch đã push của task.

**Mất session:** nếu execution trước fail với lý do kiểu "No conversation found" hoặc "session not found/expired", lần sau sẽ **không resume** nữa (event `SessionDiscarded`) mà bắt đầu một session mới.

## Consequences

- Rollback cần người merge PR revert. Đây là quyết định có chủ ý: một revert tự động có thể xóa mất công việc hợp lệ của task khác đã merge sau đó.
- Lỗi CI được gắn cho task tạo ra commit đó. Nếu nhiều merge diễn ra liên tiếp trước khi CI chạy xong, lỗi có thể đến từ sự kết hợp giữa chúng. Merge queue (ADR-0015) làm giảm khả năng này vì mỗi task đều được validate trên base mới nhất.
- `fix` và `revert` loại trừ nhau theo project, vì làm cả hai cùng lúc sẽ gây conflict.
