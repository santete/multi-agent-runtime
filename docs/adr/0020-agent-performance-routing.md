# ADR-0020: Agent performance và chọn agent theo kết quả thực tế

- Status: Accepted
- Date: 2026-10-01

## Context

Spec §40 liệt kê các chỉ số cần đo: completion rate, success rate, rework rate, thời gian trung bình, validation pass rate, review rejection rate, retry rate và human intervention rate. Spec nhấn mạnh việc đánh giá phải dựa trên thực tế chạy trên project, không dựa trên benchmark của model. Spec §53 (Phase 3) đặt mục tiêu "Dynamic Agent Selection" và "Agent performance optimization".

Scheduler của ADR-0012 chỉ dùng một tỉ lệ thành công tổng cho mỗi agent. Agent giỏi backend nhưng hay hỏng frontend vẫn được giao frontend.

## Decision

**Chỉ số** (`GET /agents/stats?projectId=`), tính cho mỗi agent:

| Chỉ số | Cách tính |
|---|---|
| runs / succeeded / failed | execution |
| validation pass | `validation_result` của execution có `passed` |
| review rejects | `review_result` (của người hoặc agent) có `decision: reject` trên công việc của agent |
| needed a person | execution ở `needs_approval` hoặc có approval request |
| tasks merged / blocked | work task mà agent là người làm execution cuối cùng |
| rework rate, avg duration, tokens, cost | như cũ |

**Theo skill** (`GET /agents/skill-stats`): succeeded, failed và reworked cho mỗi cặp (agent, skill). Skill lấy từ `requires` của task.

**Chọn agent** (`chooseAgent`):
1. Reliability theo skill: thành công trên các skill mà task yêu cầu, được kéo về tỉ lệ tổng của agent với trọng số 3 lượt chạy. Vì vậy vài lượt chạy trên một skill không tự quyết định được.
2. Quality = reliability × (1 − 0,5 × rework rate) × (1 − 0,3 × tỉ lệ cần người).
3. Điểm = w_rel × quality − w_cost × cost − w_load × load − w_speed × độ chậm. Độ chậm là thời gian trung bình so với agent chậm nhất trong các agent đủ điều kiện.
4. Policy có thêm `speed` (ngoài `balanced`, `reliability`, `cost`). `balanced` cũng tính tốc độ với trọng số nhỏ. Owner đổi policy qua `PUT /projects/:id/routing-policy`.
5. `reason` của `AgentSelected` nêu các con số, ví dụ "8/8 runs; 2/2 on javascript, backend; avg 73s".

**UI:** bảng Track record trên trang Agents có thêm các cột validation pass, review rejects, needed a person và tasks merged, cùng một bảng By skill.

## Consequences

- Scheduler "học" từ chính lịch sử của project mà không cần bước huấn luyện riêng. Một agent mới vẫn được thử nhờ giá trị prior (0,8).
- Task giao cố định cho một agent thường không có `requires`, nên không góp vào thống kê theo skill. Thống kê theo skill đến từ task `auto` và task do planner tạo (có `requires`).
- Mọi chỉ số được tính bằng SQL aggregate mỗi lần route. Khi lịch sử lớn sẽ cần materialize.
