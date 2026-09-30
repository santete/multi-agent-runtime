# ADR-0012: Scheduler theo capability và reassign khi agent lỗi

- Status: Accepted
- Date: 2026-10-01

## Context

Spec §25 và §38: platform không nên gắn cứng "loại việc X thì giao vendor Y". Nó cần chọn agent dựa trên capability, độ tin cậy đo được, chi phí và tải hiện tại. Spec §46: khi một agent hết quota, bị rate limit hoặc cứ fail liên tục thì task phải được chuyển sang agent khác thay vì bị `BLOCKED`.

Đến trước ADR này, mỗi task đều ghi cố định `agent`, và runner chỉ claim những task thuộc agent mà nó có.

## Decision

**Mô tả agent.** Trong config của runner, mỗi agent có thêm `skills` (ví dụ `typescript`, `backend`, `frontend`, `review`) và `cost` (`low` | `medium` | `high`). Hai trường này được gửi lên khi runner register (`AgentDescriptor`).

**Routing tự động.** Task được tạo với `agent: "auto"` (kèm `requires: [skills]`) thì có `routing: "auto"`. Khi claim, runner xét tối đa 20 task `READY` cũ nhất, gồm task của các agent nó có và task `auto`. Với task `auto`, control plane gọi `chooseAgent` (`packages/core/src/routing.ts`) trên danh sách agent của runner đó:
- **Lọc:** agent phải có đủ mọi skill trong `requires` (không phân biệt hoa thường) và không nằm trong `excludedAgents` của task.
- **Chấm điểm:** `w.reliability × reliability − w.cost × cost − w.load × load`
  - `reliability`: tỉ lệ thành công đã làm trơn về prior 0.8 (tương đương 2 lượt chạy ảo), để agent mới vẫn được thử và một lần may mắn không lấn át.
  - `load`: số execution đang chạy, chặn trên ở 5.
  - Trọng số lấy theo `routingPolicy` của project: `balanced` (mặc định), `reliability` hoặc `cost`.
- Agent được chọn sẽ được ghi vào `tasks.agent`, kèm event `AgentSelected { agent, reason, requires }` (reason nêu rõ các con số). Nếu runner không có agent nào phù hợp thì task vẫn ở `READY` để runner khác nhận.

**Reassign** (chạy trong `sweep`, trước khi đưa task `RETRYING` trở lại hàng đợi). Điều kiện là execution gần nhất do chính agent hiện tại chạy, và:
- lý do fail cho thấy agent không khả dụng (`isAgentUnavailable`: quota, rate limit, usage limit, credit, unauthorized, not logged in, overloaded, 503, capacity), **hoặc**
- 2 execution gần nhất của agent đó đều `failed`/`lost`.

Khi đó agent này được thêm vào `excludedAgents`, rồi:
- task `auto`: quay về `agent = "auto"` để scheduler chọn lại;
- task `fixed`: chuyển sang agent đầu tiên trong `fallbackAgents` chưa bị loại. Nếu không còn agent nào thì giữ nguyên.

Event ghi lại là `TaskReassigned { from, to, reason }`. Số lần thử vẫn tính chung theo `maxAttempts` của task, nên việc reassign không tạo thêm lượt chạy.

**Resume chỉ trong cùng agent.** `executions.agent` lưu agent đã chạy mỗi lượt. Khi tìm session để resume, control plane chỉ lấy session của đúng agent hiện tại, vì session của Claude không có nghĩa gì với Codex.

**Review task:** reviewer đầu tiên khác tác giả được giao task, các reviewer còn lại vào `fallbackAgents`, còn tác giả nằm trong `excludedAgents`, nên sẽ không bao giờ tự review việc của mình kể cả khi fallback.

**Thống kê** `GET /agents/stats?projectId=` trả về theo từng agent (spec §40): số lượt chạy, thành công, thất bại, đang chạy, thời gian trung bình, và rework rate (tỉ lệ lượt chạy bị validation fail hoặc bị review reject). UI hiển thị bảng "Track record" trên trang Agents; hộp thoại tạo task có tùy chọn `auto` + ô required skills, hoặc chọn fallback agents cho task cố định.

## Consequences

- Scheduler chọn agent ngay trong transaction của `claim`, nên không cần một tiến trình scheduler riêng. Cái giá là mỗi runner chỉ chọn trong những agent mà nó có. Như vậy, "agent tốt nhất" được hiểu theo runner đang rảnh, chứ không phải tốt nhất trên toàn hệ thống. Cách này đủ cho quy mô vài runner.
- Thống kê được tính bằng SQL aggregate mỗi lần route task `auto`. Khi lịch sử lớn sẽ cần materialize.
- Cách nhận biết "agent không khả dụng" dựa trên text lỗi, nên có thể nhận nhầm hoặc bỏ sót. Sai theo hướng nào thì cũng chỉ làm task sớm hoặc muộn chuyển sang agent khác, và vẫn bị giới hạn bởi `maxAttempts`.
- Phase 3 có thể thay hàm điểm bằng mô hình học từ metric (§40) mà không phải đổi giao thức.
