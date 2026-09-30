# ADR-0014: Shared knowledge base của project

- Status: Accepted
- Date: 2026-10-01

## Context

Spec §20–§21: các agent phải làm việc như một team. Agent sau không cần phân tích lại toàn bộ project mà dùng những gì agent trước đã biết (architecture, business rules, API contract, data model, conventions, decisions, known issues). Spec §35 mô tả knowledge là một vòng khép kín: repository → phân tích → knowledge → phát triển tiếp → phát hiện mới → cập nhật knowledge.

Trước ADR này, thứ duy nhất được truyền giữa các agent là handoff của các task mà task hiện tại phụ thuộc vào (`DEPENDENCIES.md`). Handoff nói về **thay đổi** của task đó, không nói về **project**, và cũng không đến được với những task không phụ thuộc vào nhau.

## Decision

**Entry** (bảng `knowledge`) gồm các trường:
- `kind`: `architecture`, `business_rule`, `api_contract`, `data_model`, `convention`, `decision` hoặc `known_issue`;
- `title`, `body`;
- `status`: `proposed`, `accepted` hoặc `archived`;
- nguồn: task + agent, hoặc người viết;
- `decidedBy`, `supersededBy`.

**Agent đóng góp:**
- `HANDOFF_SCHEMA` và `PLAN_SCHEMA` có thêm trường bắt buộc `knowledge: [{kind, title, body}]` (được phép rỗng). Mô tả yêu cầu agent chỉ ghi "fact bền vững về project mà agent sau không nên phải tự tìm lại", không phải mô tả thay đổi. Mỗi lần báo cáo tối đa 10 note, và `toKnowledgeNotes` bỏ note không dùng được.
- Khi agent làm xong (work task sang `VALIDATING`, planner đề xuất xong), các note được lưu ở trạng thái `proposed`. Lần chạy sau của cùng task sẽ thay các note `proposed` trước đó (chúng chuyển sang `archived`), nên rework không để lại note trùng.

**Khi nào knowledge được tin cậy:**
- Work task được **merge**: note của nó được `accepted` (`decidedBy: "platform"`). Code được validate, review và merge là bằng chứng rằng những gì agent hiểu về project là đúng.
- Plan được **approve**: note của planner được `accepted` (`decidedBy`: người duyệt).
- Người có thể accept, archive hoặc sửa bất kỳ entry nào (`PUT /knowledge/:id`) và viết entry mới (`POST /projects/:id/knowledge`, được accepted ngay).
- **Supersede:** khi một entry được accept mà đã có entry `accepted` cùng `kind` và cùng title (so sánh bỏ qua hoa thường và dấu câu), entry cũ chuyển sang `archived` với `supersededBy`. Nhờ vậy, một fact được phát biểu lại sẽ thay bản cũ chứ không tạo bản trùng.

**Agent sử dụng:**
- Khi claim, mọi task (work, review, plan) nhận `knowledge`: các entry `accepted`, sắp theo kind rồi mới nhất trước, trong ngân sách 40.000 ký tự.
- Runner ghi chúng ra `.orchestrator/context/KNOWLEDGE.md` (nhóm theo kind, ghi nguồn task) và prompt trỏ tới file này.
- Brief yêu cầu agent dựa vào các fact này thay vì phân tích lại, và báo lại bằng một note mới nếu thấy fact nào sai.

**UI:** tab Knowledge trong project. Note do agent đề xuất đứng đầu, kèm các nút accept / archive / edit. Entry đã accepted được nhóm theo kind. Entry đã archive được ẩn mặc định. Có form để người thêm entry.

Event ghi lại: `KnowledgeProposed`, `KnowledgeAccepted`, `KnowledgeUpdated`.

## Consequences

- Knowledge chỉ được chia sẻ sau khi đã qua cùng cổng kiểm tra với code (merge) hoặc qua một người. Agent làm sai không đầu độc được context của các agent khác.
- Nếu agent chỉ đề xuất mà task không bao giờ được merge, note vẫn ở `proposed` cho người xem xét. Chúng không tự bị xóa.
- Việc chống trùng dựa trên title nên khá thô: hai cách diễn đạt khác nhau của cùng một fact vẫn có thể cùng tồn tại. Người có thể archive bản thừa. Tìm kiếm theo ngữ nghĩa (embedding) để lại cho Phase 3.
- Ngân sách 40.000 ký tự giới hạn kích thước context. Khi knowledge vượt ngân sách, các entry cũ nhất trong mỗi kind sẽ không được gửi cho agent.
