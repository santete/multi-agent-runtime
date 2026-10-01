# ADR-0032: Đánh giá Temporal cho orchestration

- Status: Accepted (chưa dùng Temporal)
- Date: 2026-10-01

## Context

D3 (ADR-0002, ADR-0005): MVP dùng state machine tự viết trên Postgres, và hẹn "đánh giá Temporal ở Phase 2". Đến nay, sau Phase 3, control plane điều phối:

- **task**: 16 state, chuyển state có optimistic lock, mọi thay đổi ghi event;
- **execution**: lease, heartbeat, sweep khi runner mất, resume session, pause và instruction;
- **merge queue**: CI gate, revalidate khi base đổi, self-healing của main, revert;
- **plan**: planner, critic, tự duyệt;
- **chờ người**: approval, decision, review;
- **chờ hạn mức**: quota cooldown, budget;
- **timer**: escalation, sweep, notifier.

Temporal sẽ biến các luồng này thành workflow bền vững (durable): code tuần tự, timer, retry và signal có sẵn.

## Decision

**Chưa dùng Temporal.** Giữ state machine trên Postgres, cộng với các vòng lặp định kỳ (sweep, merge queue, notifier, escalation).

Lý do:

1. **Độ bền đã đạt được bằng cơ chế khác.** Mọi chuyển state nằm trong transaction Postgres. Event log là nguồn sự thật. Runner gọi control plane một cách idempotent, có retry khi control plane khởi động lại. Lease và sweep xử lý runner mất kết nối. Khi khởi động lại, lease được gia hạn trước khi sweep. Các lần chạy thật trong Phase 1 đến 3 (khởi động lại control plane, runner bị kill, session limit) đều không mất việc.
2. **Phần chạy lâu nằm ngoài control plane.** Phiên agent và validation chạy trên runner, là process bên ngoài. Workflow Temporal cũng chỉ chờ chúng, giống như lease đang làm. Temporal không làm phần khó nhất (điều khiển CLI agent) dễ hơn.
3. **Chờ người và chờ tài nguyên** đã là state cộng với event (WAITING_FOR_HUMAN, PAUSED, cooldown). Chúng truy vấn được trực tiếp bằng SQL cho UI, metric (ADR-0030) và org scoping. Với Temporal, phần này phải đồng bộ thêm qua visibility hoặc search attribute.
4. **Chi phí vận hành và ràng buộc:** cần thêm một cluster (Temporal server và DB riêng), code workflow phải deterministic, và phải quản lý versioning khi đổi logic. Platform hiện chạy được chỉ với một Postgres, hoặc PGlite khi dev.
5. **Scheduler:** chọn việc bằng `FOR UPDATE SKIP LOCKED` và tính ưu tiên trong SQL (ADR-0023). Hai thứ này gắn chặt với dữ liệu nên đặt trong DB là hợp lý hơn trong workflow.

## Khi nào xem lại

Nên chuyển các luồng dài (merge queue, plan và debate, self-healing) sang Temporal khi có một trong các dấu hiệu sau:

- **Cần chạy nhiều instance control plane.** Sweep đã an toàn nhờ `SKIP LOCKED`, nhưng merge queue, notifier (con trỏ event) và escalation hiện giả định chỉ có một instance chạy vòng lặp. Lúc đó, hoặc thêm leader election (Postgres advisory lock, việc nhỏ), hoặc chuyển sang Temporal. → Đã làm leader election ở ADR-0033.
- Có quy trình nhiều bước xuyên dịch vụ, cần saga hoặc compensation, ví dụ deploy, migration DB, phát hành.
- Số timer hoặc luồng chờ rất lớn, khiến vòng lặp định kỳ quét DB trở nên tốn kém.
- Logic điều phối thay đổi thường xuyên đến mức state machine khó đọc hơn code tuần tự.

## Consequences

- Không thêm hạ tầng. Platform vẫn chạy được chỉ với một Postgres.
- ~~Giới hạn đã biết: control plane chỉ nên chạy một instance cho các vòng lặp nền.~~ Đã giải quyết bằng leader election ([ADR-0033](0033-leader-election.md)): nhiều instance cùng phục vụ API, một leader chạy việc nền, failover tự động.
