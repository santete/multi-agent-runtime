# ADR-0023: Tự động ưu tiên lại task

- Status: Accepted
- Date: 2026-10-01

## Context

Spec §53 có "Automatic task reprioritization". Trước ADR này, scheduler lấy task `READY` cũ nhất. Có ba hệ quả:
- việc gấp phải xếp hàng sau việc cũ;
- task nằm trên critical path (nhiều task khác chờ nó) không được ưu tiên;
- review, critique và plan, những việc đang giữ chân người hoặc merge, phải chờ như mọi task khác.

## Decision

- Task có `priority` từ 0 đến 100, mặc định 50. Người đặt priority lúc tạo task hoặc sửa qua `PUT /tasks/:id/priority` (event `TaskReprioritized`). UI dùng các mức low 25, normal 50, high 75, urgent 100.
- Khi claim, scheduler xét tối đa 50 task `READY` và sắp xếp theo **điểm hiệu lực** (`effectivePriority`):
  - `priority`;
  - cộng **5 điểm cho mỗi task đang chờ nó**, tính cả các task chờ gián tiếp (tối đa +30);
  - cộng **1 điểm cho mỗi 10 phút** task đã ở `READY` (aging, tối đa +20), để việc ít quan trọng không bị bỏ đói mãi;
  - cộng **10 điểm** cho task review, critique và plan, vì chúng gỡ việc cho người và cho merge.
- Các mức cộng có giới hạn, nên priority do người đặt vẫn có trọng lượng: task urgent (100) luôn đứng trước một task low (25), kể cả khi task low có đủ mọi mức cộng.
- `GET /projects/:id/queue` trả về hàng đợi đúng theo thứ tự scheduler sẽ lấy, kèm lý do cho từng task. Board xếp cột Ready theo thứ tự này, hiện "#1 · score 100", và có tooltip giải thích.

## Consequences

- Việc tính điểm chạy trên cùng transaction với claim. Chi phí gồm một truy vấn lấy các task mở của project và một lần duyệt DAG, đủ nhỏ cho vài trăm task.
- Aging tính theo `updated_at`. Một task bị reassign hoặc đổi trạng thái sẽ bắt đầu tính lại từ đầu.
