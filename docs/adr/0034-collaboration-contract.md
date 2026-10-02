# ADR-0034: Collaboration contract và acceptance criteria làm cổng merge

- Status: Accepted
- Date: 2026-10-02

## Context

Spec §62: mọi task phải có Input, Objective, Constraints, Dependencies, Expected Output, Acceptance Criteria, Validation, Owner và Executor. Spec §63: một task chỉ hoàn tất khi objective được đáp ứng, dependency xong, validation pass, review bắt buộc pass, và policy được tuân thủ. Không được lấy việc agent nói "done" làm tiêu chí duy nhất.

Trước ADR này, task đã có objective, dependency, validation (theo project) và executor (`agent`). Phần còn lại nằm lẫn trong objective dạng văn bản tự do, nên reviewer không thể chấm từng tiêu chí.

## Decision

- **Contract của task**: `inputs`, `constraints`, `expectedOutput`, `acceptanceCriteria` (tối đa 20) và `owner`, tức người chịu trách nhiệm. Owner mặc định là người tạo task; với task sinh từ plan thì là người yêu cầu plan. Executor vẫn là `agent`.
  - Người khai báo contract khi tạo task.
  - Planner bắt buộc sinh contract cho mọi task (có trong `PLAN_SCHEMA`), critic kiểm tra tiêu chí có cụ thể và kiểm chứng được không, và người sửa được trên trang Plans.
- **`TASK.md`** có các mục Inputs, Constraints, Expected output, Acceptance criteria (đánh số) và Owner.
  - Agent báo từng tiêu chí trong `handoff.criteria`: `{criterion, met, evidence}`.
  - Nếu một tiêu chí không thể đạt, ví dụ vì mâu thuẫn với một ràng buộc, agent phải hỏi owner qua `openQuestions` thay vì làm xong mà để tiêu chí chưa đạt.
- **Review agent** tự chấm từng tiêu chí, không dựa vào lời của tác giả, rồi trả `review.criteria`.
  - Platform khớp các kết quả chấm với tiêu chí của task: theo nội dung, hoặc theo thứ tự khi câu chữ bị viết lại. Tiêu chí không ai chấm thì coi là chưa đạt.
  - **Reviewer approve mà còn tiêu chí chưa đạt hoặc chưa chấm thì kết quả bị ép thành `request_changes`**, kèm một finding mức blocker cho mỗi tiêu chí. Đây chính là "Required review passed" của §63.
  - Brief của review có thêm **các quyết định người đã trả lời** cho task. Những quyết định này ghi đè contract ở chỗ hai bên mâu thuẫn.
- **PR** có checklist tiêu chí kèm bằng chứng do agent báo. **UI**:
  - trang task có mục Contract, với checklist lấy kết quả của reviewer (nếu chưa có review thì lấy kết quả agent tự báo);
  - form tạo task có ô tiêu chí, và phần "More of the contract";
  - trang Plans hiển thị và sửa được tiêu chí.

## Consequences

- Task không có tiêu chí chạy như trước, nên dữ liệu cũ vẫn tương thích.
- Tiêu chí do người hoặc planner viết, nên tiêu chí mơ hồ thì chấm cũng mơ hồ. Critic là lớp kiểm tra đầu tiên cho chất lượng tiêu chí.
- Khi review do người làm, người duyệt nhìn checklist (của reviewer agent nếu có, nếu không thì của tác giả). Platform không ép người duyệt chấm từng tiêu chí.
- Đã kiểm chứng thật trên `mar-sandbox` (Postgres mới; project CT):
  - **Từ goal:** planner sinh 9 tiêu chí kiểm chứng được và 5 ràng buộc, critic đồng ý. Codex làm, tự báo 9/9 kèm bằng chứng. Claude review chấm lại 9/9 và PR #43 tự merge. Nội dung PR có checklist.
  - **Cổng chặn:** một task có tiêu chí mâu thuẫn với ràng buộc ("README phải ghi…" nhưng "không được sửa README"). Codex báo thật là tiêu chí chưa đạt, Claude trả request_changes, và task không merge mà bị BLOCKED.
  - Lần chạy đó lộ ra và đã sửa 3 vấn đề:
    - agent cứ làm rồi để tiêu chí chưa đạt thay vì hỏi owner; giờ agent hỏi ngay lượt đầu;
    - reviewer không thấy quyết định của owner, nên vẫn chặn sau khi owner đã gỡ ràng buộc; giờ quyết định có trong brief của review;
    - bản ghi review trên task gốc mất phần `criteria`.
  - **Sau khi sửa (CT-9, PR #46):** agent hỏi, owner gỡ ràng buộc README, agent làm, reviewer chấm 3/3 và dẫn đúng quyết định của owner, rồi tự merge.
