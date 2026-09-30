# ADR-0011: Review chéo giữa các agent

- Status: Accepted
- Date: 2026-09-30

## Context

Spec §30: review nên được thực hiện bởi **một agent khác** với agent đã implement, và không chỉ kiểm tra cú pháp (correctness, security, test, maintainability, business rules). Từ M3, platform đã có vòng rework cho validation, review của người và merge conflict.

## Decision

**Cấu hình theo project:** `reviewAgents` (danh sách agent id) và `autoApproveOnAgentReview`. Có thể đặt khi tạo project hoặc qua `PUT /projects/:id/review`.

**Review task.** Khi một task `work` đã push branch (sau delivery có commit), control plane tạo một task `kind: "review"`, `reviewOf: <task>`, giao cho agent đầu tiên trong `reviewAgents` **khác** agent tác giả. Nếu không có agent nào như vậy thì bỏ qua. Review task:
- **Chuẩn bị:** runner dựng worktree từ **branch đã push của task được review**, tính `git diff origin/<base>...HEAD` rồi ghi `.orchestrator/context/DIFF.patch` (tối đa 150 KB), kèm `REVIEW.md` gồm objective, handoff của tác giả, kết quả validation và link PR.
- **Chạy:** permission profile `read-only` (Claude dùng plan mode; Codex dùng sandbox read-only, riêng trên Windows dùng `workspace-write` vì read-only chặn cả lệnh chỉ đọc). Output ép theo `REVIEW_SCHEMA`: `verdict` (`approve` | `request_changes`), `summary`, `findings[{severity, file, line, message}]`.
- **Kết thúc:** không validate, không deliver, không merge. `RUNNING --review_submitted--> COMPLETED`. Nếu kết quả không đúng schema thì review task sang `RETRYING` (**không bao giờ được coi là approve**).

**Áp kết quả lên task được review** (artifact `review_result` kèm `reviewer`, `verdict`, `findings`; event `AgentReviewCompleted`; đăng comment lên PR qua `GitProvider.commentOnPullRequest`):
- `request_changes`: task chuyển `review_rejected → REWORK`. Rework context `review` chứa summary và findings, và tác giả resume session của mình.
- `approve`: nếu project bật `autoApproveOnAgentReview` thì chuyển `review_approved → APPROVED` và vào merge queue; nếu không thì người vẫn là bên quyết định cuối.
- Nếu người đã quyết định trước khi review agent xong thì quyết định của người được giữ, kết quả của agent chỉ được ghi lại.
- Mỗi lần deliver lại sau rework sẽ tạo một vòng review mới. Số vòng bị giới hạn bởi `maxAttempts` của task.

## Consequences

- Đã kiểm chứng thật trên `mar-sandbox`:
  - **Codex review code của Claude** (approve).
  - **Claude review code của Codex** (approve, kèm 2 nit hợp lý).
  - Review được đăng thành comment trên PR #12 và #13, rồi merge xong, `main` đạt 58/58 test.
  - Một agent "ẩu" cố tình viết sai đặc tả: **Codex yêu cầu sửa với 3 finding đúng** (sai tỉ lệ phí và thiếu làm tròn, thiếu kiểm tra đầu vào, thiếu test), và task tự chuyển sang rework.
- Review tốn thêm một lượt agent cho mỗi lần deliver.
- Vì Codex trên Windows chạy với `workspace-write`, reviewer về lý thuyết có thể sửa file trong worktree review. Điều này vô hại vì worktree đó không bao giờ được commit hay push.
