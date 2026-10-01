# ADR-0024: Con người là executor — câu hỏi quyết định và task cho người

- Status: Accepted
- Date: 2026-10-01

## Context

Spec §61: không phải task nào cũng hợp với AI. Khi agent gặp chỗ mơ hồ, luồng phải là: Decision Request → Human → Decision Artifact → agent làm tiếp. Platform cũng phải giao được task cho người, ví dụ một quyết định nghiệp vụ.

Trước ADR này, agent gặp chỗ mơ hồ chỉ có hai lựa chọn: tự đoán, hoặc ghi vào `knownIssues`. Khi đó không ai bị chặn để trả lời. Approval (ADR-0004) chỉ dùng cho hành động rủi ro, không dùng cho câu hỏi.

## Decision

**Câu hỏi quyết định:**
- `HANDOFF_SCHEMA` có thêm `openQuestions: [{question, options, context}]` (bắt buộc, được để rỗng). Brief dặn agent chỉ hỏi khi gặp chỗ mơ hồ thật sự mà chỉ người quyết định được (business rule, lựa chọn sản phẩm, quyền truy cập), còn lại agent tự quyết.
- Work task kết thúc mà có câu hỏi: execution chuyển `needs_approval`, task chuyển `WAITING_FOR_HUMAN`, các câu hỏi được lưu vào bảng `decisions`, và ghi event `DecisionRequested`.
- Người trả lời qua `POST /decisions/:id/answer`. Có thể bấm một option hoặc tự viết câu trả lời.
- Khi mọi câu hỏi **và** mọi approval của lượt chạy đó đã có kết quả, task quay về `READY`. Agent **resume chính session của nó** và nhận `DECISIONS.md` (câu hỏi, câu trả lời, người trả lời) cùng prompt "tiếp tục với các câu trả lời này".

**Task cho người:**
- Executor `human` được dành riêng: không runner nào được đăng ký agent tên `human`, nên không runner nào claim task của người.
- Người tạo task với `agent: "human"`, hoặc planner tạo. Planner thấy `human` trong danh sách agent, với hướng dẫn dùng nó cho quyết định nghiệp vụ, quyền truy cập và bước thủ công.
- Task `READY` của người hiện trong Inbox. Người làm xong thì gọi `POST /tasks/:id/done {summary}`: task chuyển `READY → COMPLETED` (trigger `human_completed`). Summary trở thành handoff của task, nên các task phụ thuộc nhận được nó trong `DEPENDENCIES.md`.
- Escalation ghi lý do "waiting for a person to do it". Thông báo được gửi khi có task cho người hoặc có câu hỏi.

**UI:** trang Approvals đổi thành **Inbox**, gồm câu hỏi của agent, task cho người và approval. Số đếm trên sidebar cộng cả ba. Trang task hiện câu hỏi kèm form trả lời, và form Done cho task của người.

## Consequences

- Trong lúc chờ người, agent dừng hẳn và không giữ session mở. Khi resume, agent tiếp tục với ngữ cảnh cũ, nên phần việc đã làm không bị mất.
- Câu trả lời của người chỉ áp dụng cho task đó. Nếu là quy tắc chung, người hoặc agent nên ghi thêm vào knowledge base (ADR-0014).
- Đã kiểm chứng thật (LP-28):
  - Claude hỏi đúng chỗ còn thiếu, tức độ dài refund window và ranh giới ngày cuối, kèm các option.
  - Câu hỏi được trả lời trong Inbox, rồi Claude resume session và làm đúng câu trả lời (PR #30).
