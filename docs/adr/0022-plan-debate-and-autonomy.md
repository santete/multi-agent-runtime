# ADR-0022: Planner tự động — tranh luận giữa các agent và tự duyệt có giới hạn

- Status: Accepted
- Date: 2026-10-01

## Context

Spec §53 (Phase 3) có "Autonomous Planning" và "Multi-agent Debate". ADR-0013 đã có planner đề xuất DAG và người duyệt mọi plan. Có hai giới hạn:
- Chất lượng plan chỉ phụ thuộc vào một agent.
- Người phải duyệt cả những plan nhỏ, rõ ràng.

## Decision

**Tranh luận (debate)** — project có `planning: {critics, maxRounds, autoApprove, maxAutoTasks}`, cấu hình qua `PUT /projects/:id/planning`:
1. Planner đề xuất xong, nếu có critic thì plan chuyển sang `reviewing`. Một task `kind: "critique"` được giao cho critic đầu tiên **khác planner** (planner nằm trong `excludedAgents`; các critic còn lại là fallback).
2. Critic chạy read-only với `CRITIQUE.md` (goal, plan dạng JSON, các agent đang online) và trả lời theo `CRITIQUE_SCHEMA`: `verdict` (`approve` hoặc `revise`), `summary`, và danh sách `issues[{ref, severity, message}]`. Câu trả lời không dùng được thì bị tính là fail, không bao giờ được coi là approve.
3. Nếu verdict là `revise` và round hiện tại nhỏ hơn `maxRounds`, plan chuyển `revised`. Platform tự tạo plan mới (round + 1) cho planner cũ, với feedback là critique đã định dạng. Planner nhận proposal cũ cùng feedback (ADR-0013) rồi đề xuất lại, và critic xét lại.
4. Nếu critic `approve` hoặc đã hết số round, plan chuyển sang `proposed` kèm `critique`.
5. Critic bỏ cuộc (hết lượt thử) thì plan chuyển sang `proposed` (event `PlanCritiqueFailed`) để người quyết định.

**Tự duyệt (autonomy)** — chỉ khi `autoApprove` bật **và** thỏa tất cả các điều kiện sau:
- critic đã `approve`;
- critique không có issue mức `blocker`;
- plan có từ 1 đến `maxAutoTasks` task;
- mỗi task có agent online nhận được (agent được chỉ định đang online, hoặc có agent đủ skill).

Khi đó plan được duyệt bởi `platform` (`PlanAutoApproved`) và các task bắt đầu chạy như bình thường. Nếu không thỏa, event `PlanAutoApprovalSkipped` ghi lý do và người duyệt như trước.

Tự duyệt chỉ áp dụng cho plan. Code của các task vẫn đi qua validation, review (của người, hoặc của agent nếu project bật `autoApproveOnAgentReview`), CI và merge queue.

**UI:**
- Plan có trạng thái "critic reviewing", phần Critique (verdict và các issue), và số round.
- Tab Plans có form cài đặt planning cho owner.

**Event:** `PlanCritiqueRequested`, `PlanCritiqued`, `PlanAutoApproved`, `PlanAutoApprovalSkipped`, `PlanCritiqueFailed`. Notifier báo khi một plan tự duyệt.

## Consequences

- Mỗi round tốn thêm một lượt chạy của planner và một của critic. `maxRounds` giới hạn chi phí này, và budget (ADR-0019) vẫn áp dụng.
- Giới hạn `maxAutoTasks` giữ cho các plan lớn vẫn có người xem. Owner chủ động nâng mức này khi đã tin vào chất lượng plan.
- Đã kiểm chứng thật: Claude lập plan, Codex critique (approve), plan tự duyệt, rồi Codex thực hiện và mở PR #29 mà không bước nào cần người, cho tới lần review code.
