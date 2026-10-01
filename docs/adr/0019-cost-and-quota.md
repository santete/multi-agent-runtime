# ADR-0019: Cost, quota và budget

- Status: Accepted
- Date: 2026-10-01

## Context

Spec §39 yêu cầu theo dõi token, thời gian, chi phí API, số lần retry, số lần fail, và với agent dùng subscription thì cả concurrency, quota và thời lượng session. Trước ADR này:
- Chi phí chỉ nằm trong JSON kết quả của Claude, không tổng hợp được.
- Agent hết quota chỉ bị loại khỏi **task đó** (ADR-0012), nên các task khác vẫn tiếp tục giao cho nó và lần lượt fail.
- Không có cách nào giới hạn chi tiêu theo project.

## Decision

**Chi phí từng execution:** khi agent kết thúc, control plane ghi vào `executions`:
- `input_tokens`, `output_tokens`;
- `cost_usd`: lấy theo thứ tự ưu tiên:
  1. cost agent báo (Claude báo cả khi chạy không thành công);
  2. ước tính từ `pricing {inputPerMTok, outputPerMTok}` khai báo cho agent trong config runner (Codex, agy không báo cost), kèm `cost_estimated`;
  3. nếu không có cả hai thì `null` (không tính).

**Quota → cooldown** (theo runner + agent, vì quota gắn với tài khoản mà runner dùng):
- Execution fail với lý do "agent không khả dụng" (`isAgentUnavailable`: quota, rate limit, usage limit, login…) tạo `agent_cooldowns` cho agent đó trên runner đó.
- Thời điểm hết cooldown (`until`) đọc từ chính thông báo lỗi, ví dụ "try again in 2 hours", "retry after 90 seconds", "resets at 3pm" hay một thời điểm ISO. Không đọc được thì mặc định 30 phút; giá trị vô lý (quá 7 ngày) bị bỏ qua.
- Trong lúc cooldown, runner đó không nhận task của agent đó:
  - task `auto` được route sang agent khác;
  - task có fallback được reassign (ADR-0012);
  - task cố định không có fallback thì chờ.
- Event `AgentCooldown`. Người có role senior trở lên có thể gỡ cooldown sớm qua `DELETE /runners/:id/cooldowns/:agent`.

**Concurrency theo agent:** `maxConcurrent` của agent trong config runner (giới hạn của subscription). Execution đang chạy, kể cả lúc đang validate, được tính vào giới hạn này.

**Budget theo project** (`PUT /projects/:id/budget {dailyUsd?, perTaskUsd?}`, role owner):
- `dailyUsd`: khi chi tiêu từ 0h UTC đến giờ đã đạt mức này, task `READY` của project **chờ**. Claim bỏ qua project đó, và sweep ghi `BudgetExceeded` mỗi ngày một lần. Nâng budget thì công việc chạy tiếp ngay.
- `perTaskUsd`: một task đang chờ retry hoặc rework mà tổng chi phí đã đạt mức này thì chuyển sang `BLOCKED` (event `TaskBudgetExceeded`) thay vì chạy thêm.

**Xem chi phí:**
- `GET /projects/:id/costs?days=` trả chi phí theo ngày và theo agent, cùng chi tiêu hôm nay và budget.
- `/agents/stats` có thêm token và cost.
- UI: tab Costs (gồm form budget cho owner), cột Cost ở bảng Track record, và badge "resting until…" trên trang Agents.

**Notifier:** thêm loại thông báo `budget` và `quota`, bật mặc định.

## Consequences

- Chi phí của agent không báo cost và không có pricing thì không được tính, nên budget có thể bị vượt mà không ai biết. UI ghi chú rõ điều này, và chi phí ước tính được đánh dấu `≈`.
- Budget được kiểm tra trước khi task chạy, không phải trong lúc task chạy. Một execution đang chạy vẫn chạy xong, nên số thực chi có thể vượt budget một lượt chạy.
- Cooldown gắn theo runner. Hai runner dùng chung một tài khoản sẽ mỗi runner tự gặp quota một lần.
- `input_tokens` của Claude không tính token đọc từ cache, nên số input hiển thị nhỏ hơn thực tế. Cost vẫn đúng vì lấy cost Claude báo, không ước tính.
- Kiểm chứng thật:
  - Claude báo cost của nó ($0,32). Codex được ước tính $0,12 từ pricing.
  - Vượt budget ngày thì task mới chờ ở READY, kèm đúng một thông báo `BudgetExceeded`.
  - Notifier giờ bỏ qua event cũ hơn `MAR_NOTIFY_MAX_AGE_MINUTES` (mặc định 60) khi bắt kịp sau một thời gian tắt, vì trước đó nó gửi lại thông báo đã cũ hàng giờ.
