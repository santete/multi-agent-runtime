# ADR-0026: Path ownership

- Status: Accepted
- Date: 2026-10-01

## Context

Spec §27: khi nhiều agent chạy song song trên cùng một repo, hai task sửa cùng một file sẽ gây merge conflict, hoặc tệ hơn là ghi đè quyết định của nhau. Trước ADR này, platform chỉ dựa vào merge queue và revalidation (ADR-0015) để xử lý conflict sau khi chuyện đã xảy ra.

## Decision

- **Khai báo vùng:** mỗi task có `paths`, là danh sách file hoặc glob của repo mà task sẽ sửa (`src/payments/**`, `README.md`). Tối đa 50 mục. Người khai báo khi tạo task (form New task, `POST /projects/:id/tasks`). Planner phải khai báo `paths` cho mỗi task (bắt buộc trong `PLAN_SCHEMA`), critic kiểm tra vùng có hợp lý không, và người có thể sửa vùng trên trang Plans trước khi duyệt. Danh sách rỗng nghĩa là không khai báo: task đó không bị ràng buộc gì.
- **Glob:** `*` khớp trong một segment, `**` khớp qua nhiều segment, và một thư mục không có wildcard sở hữu mọi thứ bên trong nó. Hai glob được coi là chồng nhau khi phần literal đứng trước wildcard của glob này nằm trong phần literal của glob kia. Cách so này bảo thủ: `src/**` chồng với `src/payments.js`, còn `src/a/**` và `src/b/**` thì không.
- **Chạy tuần tự:** khi claim, một task READY có vùng chồng với một task khác chưa merge thì bị bỏ qua, và scheduler lấy task kế tiếp. "Chưa merge" là các state ASSIGNED, RUNNING, VALIDATING, WAITING_FOR_HUMAN, WAITING_FOR_AGENT, REVIEW, APPROVED, MERGING, REWORK, RETRYING. Task bị bỏ qua nhận event `TaskWaitingForPaths` (một lần mỗi lần đổi state). `GET /projects/:id/queue` trả thêm `blockedBy: {key, path}`, board hiện badge "waits for LP-30", và lý do escalation nói task đang chờ task nào.
- **Ghi vào vùng của người khác:** mọi tool call ghi file (hook trước khi chạy, hoặc audit sau khi chạy với agent sandbox) được kiểm tra. Nếu file nằm ngoài vùng của task và thuộc vùng của một task khác chưa merge, verdict là **deny HIGH**, nghĩa là cần người duyệt (qua approval gateway, ADR-0008). File không thuộc vùng nào thì vẫn được ghi tự do.
- **Brief:** `TASK.md` báo cho agent biết vùng của nó, và nói rằng ghi ra ngoài vùng có thể cần người duyệt.

## Consequences

- Path ownership ngăn conflict trước khi nó xảy ra, nhưng không thay merge queue. File không ai khai báo (ví dụ CHANGELOG) vẫn có thể conflict và vẫn được xử lý bằng revalidation.
- Khai báo vùng quá rộng (`**`) làm mọi task chạy tuần tự. Brief của planner yêu cầu giữ vùng hẹp.
- Ghi vào vùng người khác là HIGH chứ không phải CRITICAL: đôi khi đó chính là việc đúng (ví dụ một re-export nhỏ), và người quyết định.
- Đã kiểm chứng thật trên `mar-sandbox`:
  - Codex làm LP-30 và Claude làm LP-31, hai task cùng vùng `src/payments.js`. LP-31 chờ, với `blockedBy LP-30`. LP-32 (`src/export.js`) chạy song song với LP-30.
  - Theo đề bài, LP-32 cũng phải re-export từ `src/payments.js`. Lệnh Edit đó bị chặn thành approval HIGH ("src/payments.js belongs to LP-30 … not merged yet"). Claude không cố ghi mà hỏi người qua `openQuestions`, và người trả lời là để sau.
  - LP-30 merge (PR #32), rồi LP-31 mới chạy, trên base đã có thay đổi của LP-30 (PR #34, không conflict). LP-32 merge (PR #33) sau một lần revalidate vì conflict ở `CHANGELOG.md`, file không ai khai báo.
