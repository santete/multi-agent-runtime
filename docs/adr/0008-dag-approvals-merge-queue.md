# ADR-0008: Task DAG, approval gateway, review và merge queue

- Status: Accepted
- Date: 2026-09-30

## Context

Spec §13, §26 yêu cầu task được biểu diễn thành DAG và chạy song song khi được phép. §31–32 yêu cầu approval gateway cho action rủi ro. §30 và §33 yêu cầu review rồi merge. §21 yêu cầu các agent chia sẻ context.

## Decision

**DAG.** `dependsOn` (id hoặc key) chỉ được khai báo lúc tạo task và chỉ trỏ tới task đã tồn tại trong cùng project, nên đồ thị không thể có chu trình. Lưu ở cột `tasks.depends_on uuid[]`. Task có dependency nằm ở `CREATED` (trạng thái suy ra `WAITING_FOR_DEPENDENCY`) cho tới khi mọi dependency `COMPLETED`, tức đã merge. Khi đó `dependencies_satisfied → READY`. Worktree luôn được dựng từ base mới nhất, nên task sau thấy được code của task trước. Claim trả `dependencies` (handoff mới nhất của từng dependency) và runner ghi chúng ra `DEPENDENCIES.md`. `GET /projects/:id/graph` trả nodes và edges.

**Song song có giới hạn.** `maxParallel` theo project: claim bỏ qua project đang có số task ở `ASSIGNED/RUNNING/VALIDATING` đạt giới hạn. Kết hợp với `maxConcurrent` của từng runner.

**Approval gateway.** Tool call bị policy đánh giá **HIGH** tạo một `approval` (`pending`), có `action_key = approvalKey(call)` để khớp cùng một hành động qua các lần thử, kể cả khi agent đổi từ `Bash` sang `PowerShell`. Agent nhận `deny` với lý do "requires human approval", và execution kết thúc ở `needs_approval → WAITING_FOR_HUMAN`. **CRITICAL** vẫn là deny cứng, không có approval. Người quyết định qua `POST /approvals/:id/approve|reject`. Khi task không còn approval nào `pending` thì `WAITING_FOR_HUMAN → READY`. Lần claim sau trả `approvals` (quyết định kèm comment) và `resume`. Action đã được duyệt thì tool-check trả `allow` (risk vẫn ghi HIGH, lý do ghi "approved by a human"). `POST /tasks/:id/retry` đưa task `WAITING_FOR_HUMAN` hoặc `BLOCKED` về hàng đợi (ví dụ sau một lần deny CRITICAL).

**Review.** `POST /tasks/:id/review` (`approve` | `reject` + comment), chỉ áp dụng cho task ở `REVIEW`. Reject tạo artifact `review_result` và chuyển task sang `REWORK`. Lần sau agent nhận `REWORK.md` chứa comment của reviewer.

**Merge queue** (`processMergeQueue`, chạy trong vòng housekeeping):
- Mỗi project tại một thời điểm chỉ merge **một** task: ưu tiên task đang `MERGING` dở, sau đó tới task `APPROVED` cũ nhất.
- `GitProvider.mergePullRequest` (GitHub: kiểm tra `mergeable`, squash merge, xóa branch) trả `merged`, `conflict` hoặc `pending`.
- `merged`: task sang `COMPLETED`, ghi event `TaskMerged`, mở khóa các task phụ thuộc.
- `conflict`: tạo artifact `merge_result` và chuyển task sang `REWORK`. Runner sẽ `fetch` rồi `merge origin/<base>` vào worktree; conflict để lại cho agent resolve. Validation có thêm bước tích hợp kiểm tra marker conflict. Delivery hoàn tất merge commit và push, và PR cũ được cập nhật.
- `pending`: thử lại ở lượt sau. Lỗi khác quá 3 lần thì chuyển `BLOCKED`.
- Task không có PR (không có thay đổi, hoặc không cấu hình provider) được coi là merge xong ngay.

**Worktree trên máy khác.** Khi branch `task/<KEY>` đã có trên remote, worktree mới được dựng từ branch đó thay vì từ base, nên không mất công việc đã deliver.

## Consequences

- Đã kiểm chứng trên `santete/mar-sandbox` với Claude Code thật. DAG 4 task: PAY-1 → (PAY-2 ∥ PAY-3) → PAY-4. PAY-2 và PAY-3 chạy song song. PAY-3 xin duyệt một lệnh `curl`; sau khi duyệt, task được requeue, resume session và `curl` được phép. Merge queue merge 4 PR theo thứ tự, `main` cuối cùng có 32/32 test pass. Tổng chi phí khoảng $1.00.
- Conflict khi merge đã được kiểm chứng end-to-end với git thật trong test (`apps/runner/test/e2e-m4.test.ts`). Trong demo trực tiếp không xảy ra conflict.
- Merge queue chưa re-validate trên base mới trước khi merge; nó dựa vào GitHub (mergeable/branch protection). Có thể bổ sung "rebase + revalidate" sau.
- Chưa có phân quyền người duyệt: ai có API token cũng duyệt được. Việc gắn approver theo mức rủi ro (§32) để lại cho M5 hoặc Phase 2.
