# ADR-0009: Vai trò và audit, phục hồi sau restart, dashboard

- Status: Accepted
- Date: 2026-09-30

## Context

M5 (plan §Phase 1) cần: UI cho dashboard, task board, agent console và approval (spec §42–43); khôi phục sau khi control plane hoặc runner restart (§55 Reliability/Recoverability); approval phân cấp và có audit (§31–32).

## Decision

**Vai trò.** Người gọi API được xác định bằng bearer token trong `MAR_USERS_FILE` (`[{name, role, token}]`, token ≥ 16 ký tự) và/hoặc `MAR_API_TOKEN` (owner "admin"). Vai trò người: `viewer < member < senior < owner`. Riêng `runner` là một định danh máy, chỉ dùng được runner protocol. Mỗi route khai báo vai trò tối thiểu:
- đọc dữ liệu: viewer;
- tạo task, cancel, retry, review: member;
- tạo project, đặt validation: owner;
- runner protocol: runner.

Approval mức HIGH cần senior. Mọi hành động của người được ghi `actor` vào event, và approval có thêm `decided_by`. Nếu không cấu hình user nào thì chạy **open mode** (mọi người gọi đều là owner "local"), và control plane từ chối lắng nghe trên địa chỉ không phải loopback.

**Phục hồi sau restart.**
- Khi khởi động, control plane gia hạn lease cho mọi execution đang hoạt động (`LeasesExtendedOnStartup`) trước khi chạy sweep, để thời gian nó tắt không bị tính thành runner mất.
- Runner retry (backoff, khoảng 2 phút) các lời gọi mang kết quả công việc (`start`, `events`, `complete`, `validation`, `delivery`). `claim` và `heartbeat` không retry vì tick sau sẽ gọi lại.
- **Policy hook** retry lỗi mạng hoặc 5xx trong tối đa 90 giây (`MAR_POLICY_HOOK_BUDGET_MS`) trước khi fail-closed. Timeout hook phía agent là 120 giây. Lý do: khi chạy thật, control plane tắt 40 giây và hook cũ lập tức chặn mọi tool call của Claude, kể cả `Read` và `StructuredOutput`.

**Dọn worktree.** Runner định kỳ (`gcIntervalMs`) hỏi `POST /runners/:id/gc` xem các worktree nào thuộc task đã `COMPLETED` hoặc `CANCELLED`, rồi xóa worktree và branch local của chúng. Worktree của task đang chạy trên máy đó không bao giờ bị động tới. Khóa git dùng đường dẫn repo đã chuẩn hóa.

**Event realtime.** `GET /stream` là server-sent events, lấy từ event store (poll 1 giây, resume theo `after`). `GET /events/recent` trả activity feed. Event có kèm `taskKey`.

**Dashboard** (`apps/web`, React 19 + Vite, không thư viện UI hay router ngoài, hash routes) được control plane phục vụ tại `/ui/`:
- **Overview:** runner online, agent đang làm, approval đang chờ, số task theo cột của từng project, activity feed.
- **Project:** board 7 cột (Waiting, Ready, Working, Needs you, Rework, Merging, Done), DAG bằng SVG, activity, form tạo task (chọn agent từ registry và dependency).
- **Task:** các action (review approve/reject kèm comment, retry, cancel), approval, handoff, validation, danh sách execution kèm **agent console realtime**, timeline.
- **Approvals** (hộp chờ duyệt và lịch sử, có `decidedBy`) và **Agents** (runner, capability, đang làm gì).

Đăng nhập bằng token (lưu ở `sessionStorage`). SSE dùng `fetch` để gửi được header `Authorization`.

## Consequences

- Đã kiểm chứng thật trên `santete/mar-sandbox`:
  1. Kill control plane 40 giây giữa lúc Claude đang làm → execution không bị đánh dấu lost, không mất event.
  2. Retry trên UI → attempt 2 resume đúng session.
  3. Review và approve cả 3 PR (#7–#9) bằng click trên UI (Edge điều khiển qua playwright-core) → merge queue merge theo DAG, `main` đạt 44/44 test.
- Token dùng chung, chưa có SSO hay cơ chế thu hồi theo phiên. Muốn đổi thì sửa file user rồi restart control plane.
- `/stream` poll DB theo từng kết nối; với vài chục người xem là đủ, nhiều hơn thì cần LISTEN/NOTIFY hoặc một broker (Phase 2).
