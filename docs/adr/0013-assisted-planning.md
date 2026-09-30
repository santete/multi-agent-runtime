# ADR-0013: Planner hỗ trợ — agent đề xuất DAG, người duyệt

- Status: Accepted
- Date: 2026-10-01

## Context

Spec §24: người dùng mô tả mục tiêu, một agent lập kế hoạch và chia mục tiêu thành các task có dependency, rồi người duyệt. Ở Phase 2, planner chỉ **đề xuất**: không task nào được tạo nếu con người chưa đồng ý. Planner tự động hoàn toàn để sang Phase 3.

Platform đã có sẵn các thành phần cần thiết: task DAG (`dependsOn`), routing theo skill (ADR-0012) và mô hình "task không sinh code" của review agent (ADR-0011).

## Decision

**Plan** là một bản ghi riêng (bảng `plans`) gồm `goal`, `status`, `proposal`, `createdTasks`, `previousPlanId` + `feedback` (khi là bản sửa), `createdBy`, `decidedBy` và `comment`. Trạng thái:

```text
planning ──planner xong──▶ proposed ──approve──▶ approved (tạo task)
    │                         ├──revise(feedback)──▶ revised ──▶ plan mới (planning)
    │                         └──reject──▶ rejected
    └── planner task BLOCKED/CANCELLED ──▶ failed (suy ra, không lưu)
```

**Chạy planner.** Planner là một task `kind: "plan"` (`planId`, tối đa 2 lần thử), giao cho agent được chọn hoặc cho `auto`, nên dùng lại toàn bộ cơ chế claim, lease, heartbeat, cancel, resume và audit. Khi claim, runner nhận `PlanningContext`:
- goal và base branch;
- các agent đang online, kèm skill và cost;
- các task chưa xong của project (task mới được phép phụ thuộc vào chúng);
- nếu là bản sửa: proposal cũ và feedback của người duyệt.

Runner dựng worktree từ base branch, ghi `.orchestrator/context/PLAN.md` và chạy agent ở chế độ **read-only**, với output ép theo `PLAN_SCHEMA`:
- `summary`;
- `tasks[{ref, title, objective, agent|null, requires, dependsOn}]`, tối đa 20 task.

Với agent không có structured output, prompt yêu cầu agent trả lời bằng JSON, và `checkPlan` tự tìm JSON trong text (cả khối JSON đứng riêng lẫn nằm trong code fence). Worktree của planner không bao giờ được deliver.

**Kiểm tra (`checkPlan`, dùng cho cả output của planner lẫn bản người sửa):**
- mỗi task có title và objective;
- `ref` không trùng nhau, không có vòng dependency;
- dependency không phải `ref` trong plan thì được coi là key của task đã có;
- trả về task theo thứ tự topo.

Nếu output không dùng được, execution bị tính `failed` và planner được retry. Agent nào không tồn tại sẽ được đổi thành `null`, tức là để scheduler route.

**Duyệt** (role `member`):
- `POST /plans/:id/approve {tasks?, comment?}`: tạo task theo thứ tự topo trong **một transaction**. `ref` được map sang id, `agent: null` thành `auto` + `requires`, mỗi task mang `planId`. Task không có dependency chuyển sang `READY` ngay, các task còn lại chờ như DAG bình thường. Nếu gửi kèm `tasks`, bản người sửa được dùng thay proposal.
- `POST /plans/:id/revise {feedback}`: plan cũ chuyển `revised`, rồi tạo plan mới với cùng goal, planner cũ và context `previous`.
- `POST /plans/:id/reject {comment?}`: nếu planner còn đang chạy thì bị cancel.

Event ghi lại: `PlanRequested`, `PlanProposed`, `PlanApproved { tasks, edited }`, `PlanRejected`, `PlanRevisionRequested`.

**UI.** Tab Plans trong project có nút "New plan". Trang plan cho phép:
- xem proposal và sửa từng task (title, objective, agent, requires, dependsOn) hoặc xóa task;
- chọn Approve, Reject, hoặc gửi feedback để planner sửa lại;
- sau khi duyệt, theo link sang các task đã được tạo.

## Consequences

- Planner không được sửa code. Quyền read-only được đảm bảo bởi permission profile của adapter (Claude dùng plan mode, Codex dùng sandbox) cộng với policy hook, giống cơ chế của review agent.
- Chất lượng plan phụ thuộc vào agent. Người duyệt vẫn là bên quyết định cuối, và bản sửa (edit hoặc revise) luôn được kiểm tra lại bằng `checkPlan`.
- Một plan chỉ tạo task mới. Nó không sửa hay hủy task có sẵn: muốn phụ thuộc vào task cũ thì tham chiếu bằng key.
- Đã kiểm chứng thật trên `mar-sandbox`:
  - Claude lập plan 2 task song song, và cố ý tách file để hai PR không đụng nhau.
  - Người duyệt sửa agent của một task, rồi Codex và Claude cùng thực hiện. PR #15 và #16 được merge, `main` đạt 72/72 test.
  - Với một goal đã làm xong, planner trả về plan rỗng. Kết quả này được coi là hợp lệ, không tính là lỗi.
