# ADR-0028: Điều khiển agent từ console: pause, resume, instruction, diff

- Status: Accepted
- Date: 2026-10-01

## Context

Spec §43: từ Agent Console, người dùng có thể Pause, Resume, Cancel, Send instruction, Approve, Reject, Open workspace và Open diff. Trước ADR này, console mới chỉ có Cancel, Approve và Reject, cộng với log trực tiếp.

Runner chạy agent bằng CLI headless, không có kênh đưa thêm input vào giữa một lần chạy. Session thì resume được (ADR-0006).

## Decision

### Pause và resume

- Thêm state **PAUSED** (`paused`: READY, ASSIGNED, RUNNING, REWORK, RETRYING → PAUSED; `resumed`: PAUSED → READY).
- Task chưa chạy thì pause ngay. Task đang chạy thì execution được đánh dấu `stop_reason = 'pause'`. Heartbeat kế tiếp trả `cancel: true`, runner dừng agent (giống cancel) rồi báo `complete`. Control plane thấy `stop_reason` nên ghi execution là **`interrupted`** (không phải `cancelled`) và chuyển task sang PAUSED.
- Resume đưa task về READY. Lần claim kế tiếp **resume đúng session** của agent, vì `session_id` đã được ghi từ `session_started`.
- Execution `interrupted` không tính vào `maxAttempts`.
- VALIDATING, REVIEW và các state sau đó không pause được: agent đã chạy xong.

### Send instruction

- Bảng `instructions` (`POST /tasks/:id/instructions {text, interrupt?}`, `GET /tasks/:id/instructions`).
- Instruction được giao ở lần chạy kế tiếp của task. Claim đánh dấu `execution_id` cho các instruction chưa giao (mỗi instruction chỉ giao một lần) và gửi kèm trong `instructions`.
- Runner ghi chúng vào `.orchestrator/context/INSTRUCTIONS.md`, và đặt nguyên văn **ở đầu prompt**, với câu nói rõ instruction được ưu tiên hơn objective gốc nếu khác nhau.
- `interrupt` (mặc định true) với agent đang chạy: dừng agent (`stop_reason = 'instruction'`), đưa task về READY (trigger `interrupted`), và chạy lại ngay, resume session cùng instruction. Với `interrupt: false`, hoặc khi agent không chạy, instruction chờ lần chạy sau.

### Open diff

- Sau mỗi lần chạy agent của task `work`, kể cả khi bị pause hay bị instruction ngắt, runner tính `workingDiff`: mọi thay đổi so với merge-base với nhánh base, gồm cả phần đã commit, chưa commit và file mới (`git add --intent-to-add`). File bị git-exclude (context, hook) và file config runner đã merge vào không nằm trong diff.
- Diff được gửi trong `complete.diff` (tối đa 300 KB) và lưu thành artifact `diff` (`text`, `files`).
- Trang task hiện mục **Diff** (bản mới nhất, tô màu), mục **Instructions** (danh sách và ô gửi, có lựa chọn "dừng agent ngay"), và các nút **Pause** / **Resume**.

### Open workspace

Worktree nằm trên máy runner. Console đã hiện branch, và đường dẫn có trong event `ExecutionStarted`. Không mở được từ trình duyệt; diff thay cho việc xem workspace.

## Consequences

- Pause dừng agent ở giữa một tool call: worktree có thể còn dở dang. Lần resume được nhắc kiểm tra lại trạng thái workspace.
- Instruction ngắt agent thì tốn một lần khởi động lại session, nhưng không tốn attempt.
- Agent không resume được session (`resume: false`) thì bắt đầu session mới. Phần đã làm vẫn còn trong worktree, và instruction vẫn nằm đầu prompt.
- Đã kiểm chứng thật trên `mar-sandbox` (LP-34, PR #36):
  - Sau 25 giây Claude chạy task `formatAmount`, gửi instruction "đổi thành `formatMoney`, mã tiền tệ đứng trước số tiền". Agent bị dừng sau khoảng 6 giây, và lần chạy thứ 2 resume đúng session (cùng session id) với instruction đó.
  - Pause lần chạy thứ 2: task PAUSED. Diff lúc pause cho thấy `formatMoney` đã viết theo instruction.
  - Resume: lần chạy thứ 3 hoàn tất, PR có `formatMoney` và test `"EUR 12.34"` / `"USD -0.05"`, rồi merge.
  - 2 lần chạy `interrupted` không tính là attempt.
